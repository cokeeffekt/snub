# Snub

Pub Sub message system, supports middleware, single delivery, replys and clusterable.

#### Usage

`npm install snub`

##### Basic Example

With redis installed and running with default port and no auth.

```javascript
const Snub = require('snub');
const snub = new Snub();

// create listener for 'hello'
snub.on('hello', (payload) => {
  console.log('Recieved => ', payload);
});

// send 'hello' to single listener.
snub.mono('hello', 'world').send();
```