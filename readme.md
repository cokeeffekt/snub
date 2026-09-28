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

## Upgrading from 4.x

**5.0.0 changes the wire format.** Poly payloads larger than `offloadThreshold`
(default 512 KB) now publish a `redisStore` key instead of the body — see
[Large payloads](#large-payloads). A subscriber running snub 4.x on the same bus
receives that key as the message body and cannot decode it.

Your application code does not change. There are no API changes in 5.0.0.

Pick one of:

- **Upgrade every instance on a bus together.** Simplest if you can deploy atomically.
- **Deploy with `offloadThreshold: 0`, then enable it.** Ship 5.0.0 with offloading
  off, wait until the whole fleet is on 5.0.0, then remove the setting. Safe for
  rolling deploys.

Check your middleware too: `snub-ws` and `snub-http` install `snub` from npm into
their own `node_modules`, so they may still resolve a 4.x core even after your app
is on 5.0.0.

Everything else in 5.0.0 is a fix or an optimisation and needs no action — handler
faults and malformed messages no longer crash the process, `close()` is idempotent,
and payload parsing is several times faster.

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
  offloadThreshold: 512 * 1024, // poly payloads over this many bytes go via Redis, not the bus

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
| `offloadThreshold` | number | `524288` | Poly payloads larger than this many bytes are stored in `redisStore` and only the key is published. `0` disables. See [Large payloads](#large-payloads) |
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

Which listener that is comes down to a lottery. Each one waits a random time
between 0 and `monoWait` ms and then tries to claim the message; the first
claim wins and the rest drop it. Every listener draws from the same range, so
each has the same chance of the shortest wait. What is left is latency to
Redis: a listener that is closer claims sooner on an equal draw.

Delivery is **at most once**. A message that is claimed by a listener which
then dies, or that cannot be claimed because Redis is unreachable, is not
retried. Use `awaitReply()` or `replyAt()` when the sender needs to know, they
fail with a timeout.

The claim relies on a single Redis answering every listener. It is not safe on
Redis Cluster, or when listeners read from replicas.

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

### Large payloads

Redis pub/sub buffers every published message per subscriber and serializes it on a
single thread, so a multi-megabyte `PUBLISH` stalls the whole Redis instance — it
shows up as slowlog entries on the channel that carried it.

`mono` has always avoided this: the payload is written to `redisStore` under
`<prefix>_mono:<key>` and only that key name goes on the bus. As of **5.0.0**
`poly` does the same for anything over `offloadThreshold` (default 512 KB):

1. The serialized payload is `SET` into `redisStore` at `<prefix>_offload:<key>`,
   with a TTL of the emit's `timeout` + 1s.
2. Only that key name is published on the channel.
3. Subscribers detect the key, `GET` the body back, and hand it to your handlers
   unchanged. Your handler code sees no difference.

This matters most for **replies**, which travel back over `poly` on an internal
`_monoReply:` channel. Before 5.0.0 a large reply to a `mono` request published
inline at full size even though the request itself had been offloaded.

The key is read but never deleted — `poly` is a broadcast and a delete by the first
reader would starve the other subscribers. The TTL is the cleanup. If the key has
expired before a subscriber reads it, the message is dropped and an error is logged.

Set `offloadThreshold: 0` to disable it entirely and publish everything inline.

> **Rolling upgrades:** the offload key is a wire-format change. An instance running
> snub < 5.0.0 that is subscribed to the same channel will receive the key string and
> fail to decode it. Upgrade every instance on a bus together — or deploy with
> `offloadThreshold: 0` and turn it on once the whole fleet is on 5.0.0.
>
> This is worth checking in the middleware too: `snub-ws` and `snub-http` install
> `snub` from npm into their own `node_modules`, so they may still resolve an older
> core than your app does.

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

Since **5.1.0** `use()` resolves to whatever the plugin returns, so a plugin can
hand back a handle:

```js
const ws = await snub.use(SnubWs({ port: 8585 }));
await ws.close();
```

---

## Direct Redis Access

The underlying ioredis connections are exposed if you need direct Redis access:

```js
snub.redis // storage connection (redisStore)
snub.pub   // publish connection
snub.sub   // subscribe connection
```

`snub.prefix` (5.1.0) is the normalised key namespace, always ending in `:`
(`'snub:'` by default). Plugins that write their own Redis keys should build
them on it so separate deployments sharing a database stay separate.

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
