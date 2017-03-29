const Snub = require('../snub.js');

const snub = new Snub();

// create listener for 'hello'
snub.on('hello', (payload) => {
  console.log('Recieved => ', payload);
});

// send 'hello' to single listener.
snub.mono('hello', 'world').send();