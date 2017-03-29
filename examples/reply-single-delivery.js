const Snub = require('../snub.js');

const snub = new Snub();

// create listener for 'hello'
snub.on('hello', (payload, reply) => {
  console.log('Recieved => ', payload);
  // send reply
  reply('I got your message');
});

// reply methos and send event
var replyMethod = (payload) => {
  console.log('Recieved Reply => ', payload);
};

snub.mono('hello', 'world')
  .replyAt(replyMethod)
  .send();