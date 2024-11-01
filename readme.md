# Snub

Snub is a lightweight library designed to facilitate messaging between your services using Redis Pub/Sub. It simplifies service communication, supporting single delivery, broadcast, and event replies.

## Features

- **Single Delivery**: Send a message to a single service instance.
- **Broadcast**: Broadcast messages to all available services.
- **Event Replies**: Easily handle replies to sent events.

## Installation

To install Snub, use npm:

```sh
npm install snub
```

## Usage

Here are some examples demonstrating how to use Snub for messaging between services:

### Basic Setup

```js
const Snub = require('snub');

var snub = new Snub({
  // redis config object
  redisAuth: { 
    port: 6379,
    host: 'localhost',
    username: '',
    password: '',
    db: 8,
  },
  
  timeout: 10000,
  intercepter: async (payload, reply, listener, channel) => {
    // you can block events
    if (listener === 'test-intercept-block') return false;
    // intercept and mutate events
    if (listener === 'test-intercept-mono')
      payload.intercept = payload.intercept * 2;
    // returning true will continue the event through its lifecycle.
    return true;
    // this interceptor function is also handy for event logging and statistics.
  },
});
```

### Single Message with Reply

```js
snub.on('test-listener-mono-reply', (payload, reply) => {
  setTimeout(() => {
    reply({ result: payload.value * 5 });
  }, 100);
});

(async () => {
  try {
    const response = await snub.mono('test-listener-mono-reply', { value: 10 }).send().awaitReply();
    console.log('Received reply:', response);
  } catch (error) {
    console.log('Request timed out:', error);
  }
})();
```

### Broadcasting Messages

```js
snub.on('test-listener-poly-reply', (payload, reply) => {
  setTimeout(() => {
    reply({ result: payload.value * 5 });
  }, 100);
});

(async () => {
  const responses = await snub.poly('test-listener-poly-reply', { value: 5 }).send().awaitReply();
  console.log('Received responses:', responses);
})();
```

### Using Patterns

```js
snub.on('test-listener-mono-pattern-wild*', (payload, reply) => {
  reply({ result: payload.value * 5 });
});

(async () => {
  const response = await snub.mono('test-listener-mono-pattern-wildcard', { value: 4 }).send().awaitReply();
  console.log('Pattern listener response:', response);
})();
```

### Handling Timeouts

```js
(async () => {
  try {
    await snub.mono('test-listener-mono-no-reply', { value: 'junk' }).send().awaitReply();
  } catch (error) {
    console.log('Request timed out:', error);
  }
})();
```

### Using `replyAt` for Multiple Replies

The `replyAt` function is a callback-based alternative to `awaitReply` and can handle multiple replies. Here is an example:

```js
snub.on('test-listener-poly-reply-at', (payload, reply) => {
  setTimeout(() => {
    reply({ result: payload.value * 2 });
  }, 100);
  setTimeout(() => {
    reply({ result: payload.value * 3 });
  }, 200);
});

snub.poly('test-listener-poly-reply-at', { value: 5 }).replyAt((response) => {
  console.log('Received reply:', response);
}, 500).send();
```

In this example, `replyAt` receives multiple replies from the listeners, allowing you to handle each response as it arrives.

### Delayed Sending

The `sendDelay` function can be used to add a delay before sending the message. This can be helpful for scheduling or spacing out events.

```js
snub.on('test-listener-mono-delay', (payload, reply) => {
  reply({ result: payload.value * 2 });
});

(async () => {
  try {
    await snub.mono('test-listener-mono-delay', { value: 7 }).sendDelay(5).awaitReply();
    console.log('Message sent with a delay of 5 seconds');
  } catch (error) {
    console.log('Request timed out:', error);
  }
})();
```

In this example, the `sendDelay(5)` method adds a delay of 5 seconds before the message is sent, allowing you to control the timing of your events.

### Using `use` Function

The `use` function allows you to inject custom middlewares or augment the behavior of the Snub instance.

```js
snub.use((snubInstance) => {
  // Custom middleware to log each event
  snubInstance.on('*', (payload) => {
    console.log('Event received:', payload);
  });
});
```

### Subscribing and Unsubscribing from Events (`on` and `off`)

The `on` function is used to subscribe to an event or pattern, while the `off` function removes the subscription. Subscriptions can also be namespaced by suffixing the event with `.name`.

For example, you can use namespacing to subscribe to and remove specific instances of the same event:

```js
// Subscribe to an event with a namespace
snub.on('example-event.name', (payload, reply) => {
  console.log('Namespace-specific handler for example-event.name');
  reply({ status: 'handled' });
});

// Subscribe to another instance of the same event with a different namespace
snub.on('example-event.anotherName', (payload, reply) => {
  console.log('Different namespace for example-event.anotherName');
  reply({ status: 'handled differently' });
});

// Unsubscribe from a specific namespaced event
snub.off('example-event.name');

// Unsubscribe from all instances of the event
snub.off('example-event');
```

## Requirements

- **Redis**: Snub uses Redis Pub/Sub, so you'll need a running Redis instance.

## Contributing

Feel free to open issues or submit pull requests for new features or bug fixes.

## License

This project is licensed under the MIT License.

## Some handy middleware

- [Snub-HTTP](https://github.com/cokeeffekt/snub-http)
- [Snub-WS](https://github.com/cokeeffekt/snub-ws)
- [Snub-CRON](https://github.com/cokeeffekt/snub-cron)
- [snub-STORE](https://github.com/cokeeffekt/snub-store)
