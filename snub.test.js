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
  intercepter: async (payload, reply, listener, channel) => {
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
  await justWait(250);
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

  await justWait(250);
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

  await justWait(1000);
  expect(checkReplyAwait1.data).toBe(random * 5);
  expect(checkReplyAwait2.data).toBe(random * 5);
});

test('Publish mono reply', async function () {
  var random = Math.round(Math.random() * 10);

  await snub.on('test-listener-mono-reply', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
    }, 500);
  });

  await snub.on('test-listener-mono-reply', (payload, reply) => {
    setTimeout((_) => {
      reply({ data: payload * 5 });
    }, 500);
  });

  var checkReplyAt;
  snub
    .mono('test-listener-mono-reply', random)
    .replyAt((v) => {
      checkReplyAt = v.data;
    })
    .send();

  var checkReplyAwait = await snub
    .mono('test-listener-mono-reply', random)
    .awaitReply();

  await justWait(1000);
  expect(checkReplyAt).toBe(random * 5);
  expect(checkReplyAwait.data).toBe(random * 5);
  expect(checkReplyAwait.responseTime).toBeGreaterThan(500);
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
    }, 1000)
    .send();

  await justWait(2000);
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

  await justWait(250);
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

  await justWait(250);
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

  await snub.mono('test-listener-mono-delay', { data: 456 }).sendDelay(5);
  await snub.on('test-listener-mono-delay', (payload) => {
    data = payload.data;
    ran++;
  });
  await justWait(4000);
  expect(data).toBe(null);
  await justWait(4000);
  expect(data).toBe(456);
  expect(ran).toBe(1);
}, 20000);

function justWait(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
