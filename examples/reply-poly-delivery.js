const Snub = require('../snub.js');

const snub = new Snub({
  debug: false
});

// create listener for 'hello'
snub.on('hello', (payload, reply) => {
  console.log('Recieved 1 => ', payload);
  // send reply
  reply('I got your message 1');
});

snub.on('hello', (payload, reply) => {
  console.log('Recieved 2 => ', payload);
  // send reply
  reply('I got your message 2');
});

// reply methos and send event
var replyMethod = (payload) => {
  console.log('Recieved Reply => ', payload);
};

snub.poly('hello', 'world')
  .replyAt(replyMethod)
  .send();