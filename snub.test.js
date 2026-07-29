jest.mock('ioredis', () => {
  const IORedisMock = require('ioredis-mock');
  class MockRedis extends IORedisMock {
    client() {
      return Promise.resolve('OK');
    }
  }
  return MockRedis;
});

const Snub = require('snub');

var snub = new Snub({
  // debug: true,
  // host: 'localhost',
  // password: '',
  // db: 8,

  // redisAuth: 'redis://:@localhost:6379/8',
  redisAuth: {
    // see https://github.com/redis/ioredis#connect-to-redis for more information
    port: 6379, // Redis port
    host: 'localhost', // Redis host
    username: '', // needs Redis >= 6
    password: '',
    db: 8, // Defaults to 0
  },
  timeout: 10000,
  interceptor: async (payload, reply, listener, channel) => {
    if (listener === 'test-intercept-block') return false;
    if (listener === 'test-intercept-mono')
      payload.intercept = payload.intercept * 2;
    return true;
  },
});

test('Publish mono reply no listeners', async function () {
  var awaitReplyNoList = false;
  try {
    await snub.mono('test-listener-mono-no-listener', 'junk').awaitReply();
  } catch (error) {
    awaitReplyNoList = true;
  }
  await justWait(150);
  expect(awaitReplyNoList).toBe(true);
  // expect(checkReplyAwait).toBe(random * 5);
}, 10000);

test('Publish mono reply timeout', async function () {
  await snub.on('test-listener-mono-no-reply', (payload, reply) => {
    // do nothing here.
  });

  var replyAtTimeout = false;
  snub
    .mono('test-listener-mono-reply', 'junk')
    .replyAt((v, err) => {
      if (err) replyAtTimeout = true;
    }, 100)
    .send();

  var awaitReplyTimeout = false;
  try {
    await snub.mono('test-listener-mono-no-reply', 'junk').awaitReply(100);
  } catch (error) {
    awaitReplyTimeout = true;
  }

  await justWait(150);
  expect(replyAtTimeout).toBe(true);
  expect(awaitReplyTimeout).toBe(true);
  // expect(checkReplyAwait).toBe(random * 5);
}, 10000);

test('Pattern Test', async function () {
  var random = Math.round(Math.random() * 10);
  await snub.on('test-listener-mono-pattern-wild*', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
    }, 500);
  });
  await snub.on('test-listener-mono-pattern-m[ae]h', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
    }, 500);
  });

  var checkReplyAwait1 = await snub
    .mono('test-listener-mono-pattern-wildcard', random)
    .awaitReply();
  var checkReplyAwait2 = await snub
    .mono('test-listener-mono-pattern-meh', random)
    .awaitReply();

  await justWait(250);
  expect(checkReplyAwait1.data).toBe(random * 5);
  expect(checkReplyAwait2.data).toBe(random * 5);
});

test('Publish mono reply', async function () {
  var random = Math.round(Math.random() * 10);

  await snub.on('test-listener-mono-reply', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
      // these should be ignored
      reply({ data: payload * 5 });
      reply({ data: payload * 5 });
    }, 250);
  });

  await snub.on('test-listener-mono-reply', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
    }, 250);
  });

  var replyCount = 0;
  var checkReplyAt;
  snub
    .mono('test-listener-mono-reply', random)
    .replyAt((v) => {
      checkReplyAt = v.data;
      replyCount++;
    })
    .send();

  var checkReplyAwait = await snub
    .mono('test-listener-mono-reply', random)
    .awaitReply();

  await justWait(500);
  expect(replyCount).toBe(1);
  expect(checkReplyAt).toBe(random * 5);
  expect(checkReplyAwait.data).toBe(random * 5);
  expect(checkReplyAwait.responseTime).toBeGreaterThan(250);
}, 10000);

test('Publish poly replies', async function () {
  var random = Math.round(Math.random() * 10);

  await snub.on('test-listener-poly-reply', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
    }, 100);
  });
  await snub.on('test-listener-poly-reply', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
    }, 100);
  });
  await snub.on('test-listener-poly-reply', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
    }, 100);
  });

  var checkReplyAt = 0;
  snub
    .poly('test-listener-poly-reply', random)
    .replyAt((v) => {
      checkReplyAt = checkReplyAt + v.data;
    }, 500)
    .send();

  var checkReplyAwait = await snub
    .poly('test-listener-poly-reply', random)
    .awaitReply(1000);

  var checkReplyAwaitValue = checkReplyAwait.reduce((total, current) => {
    return total + current.data;
  }, 0);

  await justWait(1000);
  expect(checkReplyAwaitValue).toBe(random * 5 * 3);
  expect(checkReplyAt).toBe(random * 5 * 3);
}, 10000);

test('Check listeners', async function () {
  await snub.on('test-listener-on-off', (payload, reply) => {
    reply('ok');
  });

  var whileOn = await snub.mono('test-listener-on-off').awaitReply();

  await snub.off('test-listener-on-off');
  try {
    var whileOff = await snub.mono('test-listener-on-off').awaitReply();
  } catch (error) {
    whileOff = 'nope';
  }
  var junkListerCount = await snub.poly('junk-junk').send();

  expect(whileOn).toBe('ok');
  expect(whileOff).toBe('nope');
  expect(junkListerCount).toBe(0);
});

// test('Wild cards', async function () {
//   await snub.on('wilcard:*', (payload, _reply, channel) => {

//   });

//   await snub.mono('wilcard:imawhildcard').awaitReply();

//   await justWait();
//   expect(1).toBe(1);
// });

test('Publish poly tests', async function () {
  var countPoly = 0;
  var data;

  // set up 4 listeners
  await snub.on('test-listener-poly', (payload) => {
    data = payload.data;
    countPoly++;
  });
  await snub.on('test-listener-poly', (payload) => {
    data = payload.data;
    countPoly++;
  });
  await snub.on('test-listener-poly', (payload) => {
    data = payload.data;
    countPoly++;
  });
  await snub.on('test-listener-poly', (payload) => {
    data = payload.data;
    countPoly++;
  });

  await snub.poly('test-listener-poly', { data: 123 }).send();
  await snub.poly('test-listener-poly', { data: 123 }).send();

  await justWait(250);
  expect(countPoly).toBe(8);
  expect(data).toBe(123);
}, 10000);

test('Publish mono tests', async function () {
  var countMonos = 0;
  var data;

  // set up 4 listeners
  await snub.on('test-listener-mono', (payload) => {
    data = payload.data;
    countMonos++;
  });
  await snub.on('test-listener-mono', (payload) => {
    data = payload.data;
    countMonos++;
  });
  await snub.on('test-listener-mono', (payload) => {
    data = payload.data;
    countMonos++;
  });
  await snub.on('test-listener-mono', (payload) => {
    data = payload.data;
    countMonos++;
  });

  await snub.mono('test-listener-mono', { data: 123 }).send();
  await snub.mono('test-listener-mono', { data: 123 }).send();

  await justWait(50);
  expect(countMonos).toBe(2);
  expect(data).toBe(123);

  await snub.off('test-listener-mono');
  expect(countMonos).toBe(2);
  await snub.mono('test-listener-mono', { data: 456 }).send();
  expect(countMonos).toBe(2);
  expect(data).toBe(123);
}, 10000);

test('Publish mono tests - name spaced', async function () {
  var countMonos = 0;
  var data;

  // set up 4 listeners
  await snub.on('test-listener1-mono.name1', (payload) => {
    data = payload.data;
    countMonos++;
  });
  await snub.on('test-listener1-mono.name2', (payload) => {
    data = payload.data;
    countMonos++;
  });
  await snub.on('test-listener1-mono.name3', (payload) => {
    data = payload.data;
    countMonos++;
  });
  await snub.on('test-listener1-mono.name4', (payload) => {
    data = payload.data;
    countMonos++;
  });

  await snub.mono('test-listener1-mono', { data: 123 }).send();
  await snub.mono('test-listener1-mono', { data: 123 }).send();

  await justWait(100);
  expect(countMonos).toBe(2);
  expect(data).toBe(123);
}, 10000);

test('Intercept mono tests', async function () {
  var countMonos = 0;
  var data;

  // set up 4 listeners
  await snub.on('test-intercept-mono', (payload) => {
    data = payload.intercept;
    countMonos++;
  });

  await snub.mono('test-intercept-mono', { intercept: 123 }).send();

  await justWait(100);
  expect(countMonos).toBe(1);
  expect(data).toBe(246);
}, 10000);

test('Intercept block tests', async function () {
  var countMonos = 0;
  var data;

  // set up 4 listeners
  await snub.on('test-intercept-block', (payload) => {
    countMonos++;
  });

  await snub.mono('test-intercept-block', { intercept: 0 }).send();

  await justWait(250);
  expect(countMonos).toBe(0);
}, 10000);

test('Publish mono delay test', async function () {
  var data = null;
  var ran = 0;

  await snub.mono('test-listener-mono-delay', { data: 456 }).sendDelay(2);
  await snub.on('test-listener-mono-delay', (payload) => {
    console.log('!!!!!test-listener-mono-delay', payload);
    data = payload.data;
    ran++;
  });
  await justWait(1000);
  expect(data).toBe(null);
  await justWait(3000);
  expect(data).toBe(456);
  expect(ran).toBe(1);
}, 10000);

test('Leak test', async function () {
  var listenCount = snub.status.listeners;
  var listenCountNew = listenCount;

  // run an sync functio 10 times
  for (let i = 0; i < 10; i++) {
    await snub.on('leak-' + i, () => {});
    listenCountNew++;
  }
  await justWait(100);
  for (let i = 0; i < 5; i++) {
    await snub.off('leak-' + i, () => {});
    listenCountNew--;
  }

  expect(snub.status.listeners).toBe(listenCountNew);
}, 10000);

// ─── new tests ───────────────────────────────────────────────────────────────

test('once() fires exactly once', async function () {
  var count = 0;
  await snub.once('test-once-single', () => { count++; });

  // wait between sends so the once removal completes before the next delivery
  await snub.poly('test-once-single', {}).send();
  await justWait(100);
  await snub.poly('test-once-single', {}).send();
  await justWait(100);
  await snub.poly('test-once-single', {}).send();
  await justWait(100);

  expect(count).toBe(1);
}, 10000);

test('once() does not remove sibling on() listeners', async function () {
  var onceCount = 0;
  var onCount = 0;

  await snub.once('test-once-sibling', () => { onceCount++; });
  await snub.on('test-once-sibling', () => { onCount++; });

  await snub.poly('test-once-sibling', {}).send();
  await justWait(100);
  expect(onceCount).toBe(1);
  expect(onCount).toBe(1);

  // second send — once is gone, permanent listener still fires
  await snub.poly('test-once-sibling', {}).send();
  await justWait(100);
  expect(onceCount).toBe(1);
  expect(onCount).toBe(2);

  await snub.off('test-once-sibling');
}, 10000);

test('off() with namespace removes only that namespace', async function () {
  var ns1 = 0;
  var ns2 = 0;

  await snub.on('test-off-ns.a', () => { ns1++; });
  await snub.on('test-off-ns.b', () => { ns2++; });

  await snub.poly('test-off-ns', {}).send();
  await justWait(100);
  expect(ns1).toBe(1);
  expect(ns2).toBe(1);

  await snub.off('test-off-ns.a');

  await snub.poly('test-off-ns', {}).send();
  await justWait(100);
  expect(ns1).toBe(1); // removed — should not fire again
  expect(ns2).toBe(2); // still active

  await snub.off('test-off-ns.b');
}, 10000);

test('replyAt fires error immediately when no listeners', async function () {
  var err = null;
  var start = Date.now();

  await new Promise((resolve) => {
    snub
      .mono('test-replyat-no-listener-fast', {})
      .replyAt((data, e) => {
        err = e;
        resolve();
      }, 5000) // long timeout — error should arrive well before it
      .send();
    setTimeout(resolve, 1000); // safety fallback
  });

  expect(err).toBeTruthy();
  expect(Date.now() - start).toBeLessThan(500);
}, 10000);

test('awaitReply resolves early when expectedReplies met', async function () {
  // 3 listeners, expectedReplies=3 — resolves as soon as all arrive, well before timeout
  await snub.on('test-early-resolve.a', (p, reply) => reply({ n: 1 }));
  await snub.on('test-early-resolve.b', (p, reply) => reply({ n: 2 }));
  await snub.on('test-early-resolve.c', (p, reply) => reply({ n: 3 }));

  var start = Date.now();
  var replies = await snub.poly('test-early-resolve', {}).awaitReply(5000, 3);

  expect(Array.isArray(replies)).toBe(true);
  expect(replies.length).toBe(3);
  expect(Date.now() - start).toBeLessThan(1000); // well before 5000ms timeout

  await snub.off('test-early-resolve');
}, 10000);

test('use() calls function with the snub instance', async function () {
  var received = null;
  await snub.use((instance) => { received = instance; });
  expect(received).toBe(snub);
}, 10000);

test('status returns expected shape', async function () {
  var s = snub.status;
  expect(typeof s.listeners).toBe('number');
  expect(typeof s.patterns).toBe('number');
  expect(s.listeners).toBeGreaterThanOrEqual(0);
  expect(s.patterns).toBeGreaterThanOrEqual(0);
}, 10000);

test('Map and Set survive serialization roundtrip', async function () {
  var sent = {
    m: new Map([['key', 'value'], ['num', 42]]),
    s: new Set([1, 2, 3]),
  };
  var received = null;

  await snub.on('test-map-set', (payload) => { received = payload; });
  await snub.poly('test-map-set', sent).send();
  await justWait(150);

  expect(received.m instanceof Map).toBe(true);
  expect(received.m.get('key')).toBe('value');
  expect(received.m.get('num')).toBe(42);
  expect(received.s instanceof Set).toBe(true);
  expect(received.s.has(2)).toBe(true);

  await snub.off('test-map-set');
}, 10000);

test('interceptor array — all interceptors run in order', async function () {
  var order = [];
  var snub2 = new Snub({
    redisAuth: { port: 6379, host: 'localhost', db: 8 },
    interceptor: [
      async () => { order.push(1); return true; },
      async () => { order.push(2); return true; },
    ],
  });

  var received = false;
  await snub2.on('test-interceptor-arr', () => { received = true; });
  await snub2.poly('test-interceptor-arr', {}).send();
  await justWait(150);

  expect(received).toBe(true);
  expect(order).toEqual([1, 2]);
  await snub2.close();
}, 10000);

test('interceptor array — first false blocks the chain', async function () {
  var secondRan = false;
  var snub2 = new Snub({
    redisAuth: { port: 6379, host: 'localhost', db: 8 },
    interceptor: [
      async () => false,
      async () => { secondRan = true; return true; },
    ],
  });

  var received = false;
  await snub2.on('test-interceptor-arr-block', () => { received = true; });
  await snub2.poly('test-interceptor-arr-block', {}).send();
  await justWait(150);

  expect(received).toBe(false);
  expect(secondRan).toBe(false);
  await snub2.close();
}, 10000);

test('close() resolves cleanly', async function () {
  var snubTemp = new Snub({
    redisAuth: { port: 6379, host: 'localhost', db: 8 },
  });
  await expect(snubTemp.close()).resolves.not.toThrow();
}, 10000);

test('sendDelay returns a job ID and cancelDelay prevents delivery', async function () {
  var received = false;
  await snub.on('test-cancel-delay-msg', () => { received = true; });

  var jobId = await snub.mono('test-cancel-delay-msg', {}).sendDelay(2);
  expect(typeof jobId).toBe('string');
  expect(jobId.length).toBeGreaterThan(0);

  var cancelled = await snub.cancelDelay(jobId);
  expect(cancelled).toBe(true);

  await justWait(3000); // past when it would have fired
  expect(received).toBe(false);

  await snub.off('test-cancel-delay-msg');
}, 10000);

test('cancelDelay returns false for unknown job id', async function () {
  var result = await snub.cancelDelay('000000000000000000');
  expect(result).toBe(false);
}, 10000);

// --- large payload offload -------------------------------------------------
// Poly payloads over `offloadThreshold` are stored in redisStore and only the key
// is published, so a multi-MB reply never lands inline on the bus.

// Small threshold keeps the test payloads cheap to build.
function offloadSnub(overrides = {}) {
  return new Snub({
    redisAuth: { port: 6379, host: 'localhost', db: 8 },
    offloadThreshold: 1024,
    ...overrides,
  });
}

// comfortably over 1024 bytes once serialized
function bigString(bytes = 8192) {
  return 'x'.repeat(bytes);
}

test('offload — large poly payload round-trips intact', async function () {
  var snubO = offloadSnub();
  var sent = { blob: bigString(), n: 42 };

  var received = null;
  await snubO.on('test-offload-poly', (payload) => { received = payload; });
  await snubO.poly('test-offload-poly', sent).send();
  await justWait(200);

  expect(received).toEqual(sent);
  await snubO.close();
}, 10000);

test('offload — large mono reply round-trips intact', async function () {
  var snubO = offloadSnub();
  var blob = bigString();

  await snubO.on('test-offload-reply', (payload, reply) => {
    reply({ blob: blob, echo: payload });
  });

  var result = await snubO.mono('test-offload-reply', 'ping').awaitReply();

  expect(result.blob).toBe(blob);
  expect(result.echo).toBe('ping');
  await snubO.off('test-offload-reply');
  await snubO.close();
}, 10000);

test('offload — the bus publish carries only the key, not the payload', async function () {
  var snubO = offloadSnub();
  var published = [];
  var realPublish = snubO.pub.publish.bind(snubO.pub);
  snubO.pub.publish = (channel, payload) => {
    published.push([channel, payload]);
    return realPublish(channel, payload);
  };

  await snubO.on('test-offload-small', () => {});
  await snubO.poly('test-offload-small', { blob: 'tiny' }).send();
  await snubO.poly('test-offload-small', { blob: bigString() }).send();
  await justWait(200);

  var [small, large] = published.map((p) => p[1]);
  expect(small.startsWith('{')).toBe(true); // inline JSON
  expect(large).toMatch(/^snub:_offload:[0-9a-f]+$/); // key only
  expect(large.length).toBeLessThan(100);

  snubO.pub.publish = realPublish;
  await snubO.close();
}, 10000);

test('offload — under-threshold payloads still publish inline', async function () {
  var snubO = offloadSnub();

  var received = null;
  await snubO.on('test-offload-under', (payload) => { received = payload; });

  // key count delta, not absolute — earlier offload tests share the mock store
  var before = (await snubO.redis.keys('snub:_offload:*')).length;
  await snubO.poly('test-offload-under', { small: true }).send();
  await justWait(200);
  var after = (await snubO.redis.keys('snub:_offload:*')).length;

  expect(received).toEqual({ small: true });
  expect(after).toBe(before);
  await snubO.close();
}, 10000);

test('offload — offloadThreshold: 0 disables offloading', async function () {
  var snubO = offloadSnub({ offloadThreshold: 0 });
  var published = [];
  var realPublish = snubO.pub.publish.bind(snubO.pub);
  snubO.pub.publish = (channel, payload) => {
    published.push(payload);
    return realPublish(channel, payload);
  };

  var sent = { blob: bigString() };
  var received = null;
  await snubO.on('test-offload-disabled', (payload) => { received = payload; });
  await snubO.poly('test-offload-disabled', sent).send();
  await justWait(200);

  expect(received).toEqual(sent);
  expect(published[0].startsWith('{')).toBe(true); // full payload went inline
  expect(published[0].length).toBeGreaterThan(1024);

  snubO.pub.publish = realPublish;
  await snubO.close();
}, 10000);

test('offload — missing/expired key drops the message without throwing', async function () {
  var snubO = offloadSnub();

  var received = false;
  await snubO.on('test-offload-missing', () => { received = true; });

  // simulate a payload whose offload key has already expired out of redisStore
  var errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  await snubO.pub.publish('snub:test-offload-missing', 'snub:_offload:doesnotexist');
  await justWait(200);

  expect(received).toBe(false);
  expect(errSpy).toHaveBeenCalled();
  errSpy.mockRestore();
  await snubO.close();
}, 10000);

test('offload — Map and Set survive the offload round-trip', async function () {
  var snubO = offloadSnub();
  var sent = {
    blob: bigString(),
    m: new Map([['key', 'value']]),
    s: new Set([1, 2, 3]),
  };

  var received = null;
  await snubO.on('test-offload-mapset', (payload) => { received = payload; });
  await snubO.poly('test-offload-mapset', sent).send();
  await justWait(200);

  expect(received.m instanceof Map).toBe(true);
  expect(received.m.get('key')).toBe('value');
  expect(received.s instanceof Set).toBe(true);
  expect(received.s.has(3)).toBe(true);
  expect(received.blob).toBe(sent.blob);
  await snubO.close();
}, 10000);

// --- fault isolation (B15, B16, B17) ---------------------------------------
// A bad message or a throwing handler must not take the instance (or in a real
// app, the process) down. The out-of-process crash behaviour is covered by
// snub-smoke; these pin the in-process contract.

test('fault — malformed message is dropped, instance keeps working (B15)', async function () {
  var snubF = new Snub({ redisAuth: { port: 6379, host: 'localhost', db: 8 } });
  var errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  var received = [];
  await snubF.on('test-fault-garbage', (p) => { received.push(p); });

  await snubF.pub.publish('snub:test-fault-garbage', 'this is not json {{{');
  await justWait(150);
  expect(received.length).toBe(0);
  expect(errSpy).toHaveBeenCalled();

  // a well-formed message containing the internal Map tag with a non-iterable
  // value throws inside the reviver — same path
  await snubF.pub.publish(
    'snub:test-fault-garbage',
    JSON.stringify({ key: 'k', contents: { dataType: 'Map', value: 42 }, ts: Date.now() })
  );
  await justWait(150);
  expect(received.length).toBe(0);

  // instance still delivers afterwards
  await snubF.poly('test-fault-garbage', { ok: true }).send();
  await justWait(150);
  expect(received).toEqual([{ ok: true }]);

  errSpy.mockRestore();
  await snubF.close();
}, 10000);

test('fault — a sync-throwing handler does not break the instance (B16)', async function () {
  var snubF = new Snub({ redisAuth: { port: 6379, host: 'localhost', db: 8 } });
  var errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  var goodRan = 0;
  await snubF.on('test-fault-throw', () => { throw new Error('handler exploded'); });
  await snubF.on('test-fault-throw', () => { goodRan++; });

  await snubF.poly('test-fault-throw', {}).send();
  await justWait(200);

  expect(goodRan).toBe(1); // sibling listener unaffected
  expect(errSpy).toHaveBeenCalled();

  await snubF.poly('test-fault-throw', {}).send();
  await justWait(200);
  expect(goodRan).toBe(2); // still delivering

  errSpy.mockRestore();
  await snubF.close();
}, 10000);

test('fault — a rejecting async handler does not break the instance (B16)', async function () {
  var snubF = new Snub({ redisAuth: { port: 6379, host: 'localhost', db: 8 } });
  var errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  var goodRan = 0;
  await snubF.on('test-fault-reject', () => Promise.reject(new Error('handler rejected')));
  await snubF.on('test-fault-reject', () => { goodRan++; });

  await snubF.poly('test-fault-reject', {}).send();
  await justWait(200);

  expect(goodRan).toBe(1);
  expect(errSpy).toHaveBeenCalled();

  errSpy.mockRestore();
  await snubF.close();
}, 10000);

test('fault — close() is idempotent (B17)', async function () {
  var snubF = new Snub({ redisAuth: { port: 6379, host: 'localhost', db: 8 } });
  await snubF.close();
  await expect(snubF.close()).resolves.not.toThrow();
  await expect(snubF.close()).resolves.not.toThrow();
}, 10000);

afterAll(async () => {
  await snub.close();
});

function justWait(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
