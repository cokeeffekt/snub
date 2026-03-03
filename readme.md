# Snub

**Redis-backed pub/sub messaging for Node.js services.**

Snub lets your services talk to each other over Redis with minimal boilerplate. Send to one worker, broadcast to all, await replies, schedule delayed jobs — all with a clean, chainable API.

## Features

- **Mono** — single delivery, one worker claims the message (load balanced)
- **Poly** — broadcast to every listener across all instances
- **Replies** — request/response patterns with `awaitReply()` or callback-based `replyAt()`
- **Glob patterns** — subscribe to `user:*` and match any channel under it
- **Namespaced listeners** — multiple handlers on the same event, removable by name
- **Delayed jobs** — schedule mono messages with `sendDelay()`, cancel with `cancelDelay()`
- **Interceptors** — middleware functions that run before each handler, can block or mutate
- **Separate Redis connections** — pub/sub and storage connections are kept independent

## Installation

```sh
npm install snub
```

## Setup

```js
const Snub = require('snub');

const snub = new Snub({
  // Redis connection for pub/sub
  redisAuth: {
    host: 'localhost',
    port: 6379,
    password: '',
    db: 0,
  },

  // Optional: separate Redis connection for storage (defaults to redisAuth)
  redisStore: {
    host: 'localhost',
    port: 6379,
    db: 1,
  },

  timeout: 5000,          // reply timeout in ms (default: 5000)
  monoWait: 50,           // max jitter in ms before workers race to claim mono messages
  prefix: 'snub',         // Redis key prefix
  processDelayQueue: true, // set false on instances that should not poll the delay queue

  // Interceptor — runs before every handler. Return false to block.
  interceptor: async (payload, reply, listener, channel) => {
    if (listener === 'blocked-event') return false;
    return true;
  },

  // Stats — called after each user event is handled
  stats: ({ pattern, replyTime }) => {
    console.log(`${pattern} replied in ${replyTime}ms`);
  },
});
```

### Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `redisAuth` | object \| string | `null` | ioredis options or URL for pub/sub connections |
| `redisStore` | object \| string | `null` | ioredis options or URL for storage. Falls back to `redisAuth` |
| `prefix` | string | `'snub'` | Redis key namespace prefix |
| `timeout` | number | `5000` | Default reply timeout in ms |
| `monoWait` | number | `50` | Max random wait (ms) before workers race to claim a mono message |
| `nsSeparator` | string | `'.'` | Separator between event name and namespace |
| `delayResolution` | number | `1000` | How often (ms) to poll the delay queue |
| `processDelayQueue` | boolean | `true` | Set `false` to skip delay queue polling on this instance |
| `interceptor` | function \| function[] | passthrough | Run before each handler. Return `false` to block |
| `stats` | function | no-op | Called after each user event is handled |
| `debug` | boolean | `false` | Log internal events to console |

---

## API

### `snub.on(pattern, handler)`

Subscribe to an event or glob pattern. The handler signature is:

```js
handler(payload, reply, channel, eventPattern)
```

- `payload` — the data sent with the event
- `reply(data)` — call to send a reply back to the emitter
- `channel` — the exact channel name the message was published on
- `eventPattern` — the pattern this listener was registered with

### `snub.once(pattern, handler)`

Same as `on`, but automatically unsubscribes after the first delivery.

### `snub.off(pattern)`

Unsubscribe all listeners for a pattern, or just a namespaced one:

```js
snub.off('user:login');        // removes all listeners for 'user:login'
snub.off('user:login.myApp');  // removes only the 'myApp' namespace listener
```

### `snub.mono(channel, data)` → EmitObject

Emits a single-delivery message. Only one listener across all instances receives it — whichever claims it first (with optional jitter via `monoWait`).

### `snub.poly(channel, data)` → EmitObject

Broadcasts to every listener on every instance.

### EmitObject methods

| Method | Description |
|---|---|
| `.send(cb?)` | Publish the message. `cb(count)` receives subscriber count. Returns `Promise<count>` |
| `.awaitReply(timeout?, expectedReplies?)` | Await reply(ies). Mono resolves with a single value; poly resolves with an array |
| `.replyAt(callback, timeout?)` | Callback-based reply handler. Chainable before `.send()` |
| `.sendDelay(seconds)` | Schedule delivery after N seconds. Returns a job ID. Mono only |

### `snub.cancelDelay(jobId)` → `Promise<boolean>`

Cancel a previously scheduled delay job. Returns `true` if found and cancelled, `false` if already fired or not found.

### `snub.close()` → `Promise<void>`

Gracefully shuts down: clears the delay interval and quits all Redis connections.

---

## Examples

### Mono — single delivery with reply

Only one instance handles the message, even if many are listening:

```js
snub.on('order:process', async (payload, reply) => {
  const result = await processOrder(payload);
  reply({ orderId: result.id, status: 'ok' });
});

const response = await snub.mono('order:process', { item: 'widget', qty: 3 }).awaitReply();
console.log(response); // { orderId: '...', status: 'ok' }
```

### Poly — broadcast to all listeners

Every instance that has registered a handler receives the message:

```js
snub.on('config:reload', (payload) => {
  reloadConfig(payload.version);
});

// Notify all instances to reload
snub.poly('config:reload', { version: '2.1.0' }).send();
```

### Poly with replies

Collect responses from every instance:

```js
snub.on('health:check', (payload, reply) => {
  reply({ host: os.hostname(), uptime: process.uptime() });
});

const results = await snub.poly('health:check').awaitReply();
console.log(results); // [{ host: 'web-1', uptime: 120 }, { host: 'web-2', uptime: 95 }]
```

### Glob patterns

```js
snub.on('game:*', (payload, reply, channel) => {
  console.log(`Received on channel: ${channel}`);
});

snub.poly('game:start', { gameId: 'abc' }).send();
snub.poly('game:end',   { gameId: 'abc' }).send();
```

### Namespaced listeners

Register multiple handlers for the same event and remove them independently:

```js
snub.on('user:login.analytics', (payload) => trackLogin(payload));
snub.on('user:login.audit',     (payload) => auditLog(payload));

// Remove only the analytics handler
snub.off('user:login.analytics');

// Remove all user:login handlers
snub.off('user:login');
```

### Callback-based replies with `replyAt`

Useful when you want to handle each reply as it arrives rather than waiting for all of them:

```js
snub.poly('worker:status', null)
  .replyAt((status) => {
    console.log('Worker replied:', status);
  }, 2000)
  .send();
```

### Delayed delivery with `sendDelay`

Schedules a mono message for future delivery. The message is stored in Redis and dispatched by whichever Snub instance polls the queue first.

> **Note:** `sendDelay` is fire-and-schedule. Replies are not supported — the original call context is gone by the time the message fires.

```js
snub.on('reminder:send', (payload) => {
  sendReminderEmail(payload.userId, payload.message);
});

// Schedule delivery in 60 seconds
const jobId = await snub.mono('reminder:send', {
  userId: 'u_123',
  message: 'Your session is about to expire.',
}).sendDelay(60);

// Cancel it if no longer needed
const cancelled = await snub.cancelDelay(jobId);
```

To opt an instance out of polling the delay queue (useful in multi-process setups where only dedicated workers should dispatch delayed jobs):

```js
new Snub({ processDelayQueue: false, ...redisConfig });
```

### Interceptors

Interceptors run before every handler and can block, mutate, or log events:

```js
const snub = new Snub({
  interceptor: [
    // Auth check
    async (payload, reply, listener) => {
      if (listener.startsWith('admin:') && !payload.token) {
        reply({ error: 'Unauthorized' });
        return false; // block
      }
      return true;
    },
    // Event logger
    async (payload, reply, listener) => {
      console.log(`[snub] ${listener}`, payload);
      return true;
    },
  ],
  ...redisConfig,
});
```

### Using `use` for plugins

```js
snub.use((snubInstance) => {
  snubInstance.on('*', (payload, reply, channel) => {
    metrics.increment('snub.events', { channel });
  });
});
```

---

## Direct Redis Access

The underlying ioredis connections are exposed if you need direct Redis access:

```js
snub.redis // storage connection (redisStore)
snub.pub   // publish connection
snub.sub   // subscribe connection
```

---

## Requirements

- Node.js 14+
- A running Redis instance (v4+)

## Ecosystem

- [snub-http](https://github.com/cokeeffekt/snub-http) — HTTP API gateway over Snub
- [snub-ws](https://github.com/cokeeffekt/snub-ws) — WebSocket server over Snub
- [snub-cron](https://github.com/cokeeffekt/snub-cron) — Cron jobs distributed via Snub
- [snub-store](https://github.com/cokeeffekt/snub-store) — Shared key-value store via Snub

## Contributing

Issues and pull requests are welcome.

## License

MIT
