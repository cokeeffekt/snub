# Snub

Pub Sub message system, supports middleware, single delivery, replys and clusterable.

#### Usage

`npm install snub`

#### Tests

Tests are few but cover the essentials, feel free to add to them. Redis needs to be running no auth on default port.
`npm run redis` - basic redis docker
`npm run test`

#### Basic Example

With redis installed and running with default port and no auth.

```javascript
const Snub = require('snub');
const snub = new Snub();

// create listener for 'hello'
snub.on('hello', (payload) => {
  console.log('Recieved => ', payload);
});

// send 'world' to single 'hello' listener.
snub.mono('hello', 'world').send();
```

For further examples take a look in [examples](/examples).

#### Advanced Setup

Optional config, defaults are applied if omitted.

```javascript
const Snub = require('snub');
const snub = new Snub({
    prefix: 'snub', // prefix all snub pub/sub messages
    port: 6379, // redis port
    host: '127.0.0.1', // redis host
    auth: null,   // redis auth
    debug: false, // dump debug junk
    timeout: 5000 // reply timeout, we cant listen forever,
    monoWait: 50,  // used to help mono delivery messages to get dispersed evenlyish, this is a max wait time. will randomize between 0-monoWait, if you have small amount of instances set this low. poly does not use this value.
    redisStore: { // option, if you would like the store be on a seperate instanc from pub/sub activity
      port: 6379, // redis port
      host: '127.0.0.1', // redis host
      auth: null,   // redis auth
    },
    intercepter: async (payload, reply, channel, pattern) => {
      // payload be mutated directly, reply fn can be called early. (if you reply and return true you might have an uninteded outcome)
      return true; // returning false will not exectute the listener.
    }
  });
```

### API

##### `snub.on('eventname', (payload, [reply]) => {});`

- Method is run when an event is triggered.
- Use patterns in subscribers like so `'h[ae]llo'` or `hell*`
- Reply is optionaly a function to reply at with a single param. `reply({})`
- you can also namespace events `hello.one` to allow easy removal with `snub.off('hello.one')`

##### `snub.once('eventname', (payload, [reply]) => {});`

Same as .on but event will only trigger once.

##### `snub.off('eventname');`

- Remove all event listeners by name
- append namespace to remove single listener if you have mutliple.

##### `snub.poly('eventname', payload).send([function]);`

Emits an event trigger with the payload .send() accepts and optional callback function which carries a number value which will indicate the amount of listeners that heard the event trigger. Poly will deliver the message and payload to all listeners.

##### `snub.poly('eventname').replyAt(function(replyData, error), [optional timeout]).send([function]);`

Allows the event to be replied to, since this will get delivered to all listeners the reply will prossibly be responded to multiple times.

##### `snub.mono('eventname', payload).send([function]);`

Emits an event trigger with the payload .send() accepts and optional callback function which carries a number value which will indicate the amount of listeners that heard the event trigger (will always be 0 or 1 for mono). Mono will only be delivered to a single listener, this is first come first served, there is not methodology or way to control this as of yet, think of it as random delivery.

##### `snub.mono('eventname', payload).sendDelay(5);`

number of seconds to delay the event being sent. this is stores in redis so will persist restarts.

##### `snub.poly('eventname', payload).replyAt(function(), [optional timeout]).send([function]);`

Allows the event to be replied to, reply can only run once.

##### `snub.use(middlewareMethod);`

Snub accepts middleware, it will hand the snub instance to the middleware method.

##### Some handy middleware

- [Snub-HTTP](https://github.com/cokeeffekt/snub-http)
- [Snub-WS](https://github.com/cokeeffekt/snub-ws)
- [Snub-CRON](https://github.com/cokeeffekt/snub-cron)
- [snub-STORE](https://github.com/cokeeffekt/snub-store)
