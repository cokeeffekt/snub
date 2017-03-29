const Snub = require('../snub.js');

// create multiple snub instances, and listen on each.
const snub1 = new Snub();
snub1.on('hello', (payload) => {
  console.log('Recieved Instance 1 => ', payload);
});

const snub2 = new Snub();
snub2.on('hello', (payload) => {
  console.log('Recieved Instance 2 => ', payload);
});

const snub3 = new Snub();
snub3.on('hello', (payload) => {
  console.log('Recieved Instance 3 => ', payload);
});




// timeout is not required, just needed for example when running multiple snub instances in single app
setTimeout(() => {

  // at this point we have three listeners we can test this buy doing the following.
  snub1.poly('hello', 'You can see me per listener').send();


  // send 'hello' to a single listener 1 time.
  snub3.mono('hello', 'Im delivered only once').send();

}, 500);
