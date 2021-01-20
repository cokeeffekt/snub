const Snub = require('snub');

var snub = new Snub({
  host: 'localhost',
  password: '',
  db: 8,
  timeout: 10000
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
  snub.mono('test-listener-mono-reply', 'junk').replyAt((v, err) => {
    if (err)
      replyAtTimeout = true;
  }, 100).send();

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

test('Publish mono reply', async function () {
  var random = Math.round(Math.random() * 10);

  await snub.on('test-listener-mono-reply', (payload, reply) => {
    setTimeout(_ => {
      reply({ data: payload * 5 });
    }, 500);
  });

  await snub.on('test-listener-mono-reply', (payload, reply) => {
    setTimeout(_ => {
      reply({ data: payload * 5 });
    }, 500);
  });

  var checkReplyAt;
  snub.mono('test-listener-mono-reply', random).replyAt(v => {
    checkReplyAt = v.data;
  }).send();

  var checkReplyAwait = await snub.mono('test-listener-mono-reply', random).awaitReply();

  await justWait(1000);
  expect(checkReplyAt).toBe(random * 5);
  expect(checkReplyAwait.data).toBe(random * 5);
  expect(checkReplyAwait.responseTime).toBeGreaterThan(500);
}, 10000);

test('Publish poly replies', async function () {
  var random = Math.round(Math.random() * 10);

  await snub.on('test-listener-poly-reply', (payload, reply) => {
    setTimeout(_ => {
      reply({ data: payload * 5 });
    }, 100);
  });
  await snub.on('test-listener-poly-reply', (payload, reply) => {
    setTimeout(_ => {
      reply({ data: payload * 5 });
    }, 100);
  });
  await snub.on('test-listener-poly-reply', (payload, reply) => {
    setTimeout(_ => {
      reply({ data: payload * 5 });
    }, 100);
  });

  var checkReplyAt = 0;
  snub.poly('test-listener-poly-reply', random)
    .replyAt(v => {
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

test('Publish mono delat test', async function () {
  var data = null;

  await snub.mono('test-listener-mono-delay', { data: 456 }).sendDelay(5);
  await snub.on('test-listener-mono-delay', (payload) => {
    data = payload.data;
  });
  await justWait(3000);
  expect(data).toBe(null);
  await justWait(4000);
  expect(data).toBe(456);
}, 20000);

function justWait (ms = 1000) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
