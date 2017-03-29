const Snub = require('../snub.js');

// create multiple snub instances, and listen on each.

const snub3 = new Snub({
  debug: true
});
snub3.on('hello', (payload) => {
  console.log('Recieved Instance 3 => ', payload);
});

const snub1 = new Snub();
snub1.on('hello', (payload) => {
  console.log('Recieved Instance 1 => ', payload);
});

const snub2 = new Snub();
snub2.on('hello', (payload) => {
  console.log('Recieved Instance 2 => ', payload);
});



// send 'hello' to a single listener 10 times from snub1.

snub1.poly('hello', 'world').send();
//snub1.mono('hello', 'world').send();
//snub1.mono('hello', 'world').send();
//snub1.mono('hello', 'world').send();
//snub1.mono('hello', 'world').send();
//snub1.mono('hello', 'world').send();
//snub1.mono('hello', 'world').send();
//snub1.mono('hello', 'world').send();
//snub1.mono('hello', 'world').send();
//snub1.mono('hello', 'world').send();
