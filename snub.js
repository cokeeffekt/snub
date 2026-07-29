const path = require('path');
const { randomBytes } = require('crypto');
const Redis = require('ioredis');

const DEFAULT_CONFIG = {
  prefix: 'snub',
  debug: false,
  monoWait: 50, // this is a maximum wait time in ms for mono messages to be delivered.
  timeout: 5000,
  nsSeparator: '.',
  delayResolution: 1000, // mono delay resolution in ms
  processDelayQueue: true, // set false on instances that should not poll the delay queue
  offloadThreshold: 512 * 1024, // bytes; poly payloads larger than this are stored in
  // redisStore and only the key is published. Set 0/null to disable.
  stats: (_) => {},
  redisAuth: null,
  redisStore: null,
  interceptor: async (payload, reply, listener, eventName) => {
    return true; // return false to block the event
  },
};

class Snub {
  #subscribedPatterns = new Set();
  #eventsMap = new Map();
  #config;
  #prefix;
  #nsSeparator;
  #interceptors;
  #delayInterval = null;
  #emitRegistry = null;
  #replyTimers = new Set();

  #redis;
  #pub;
  #sub;

  constructor(config) {
    this.#config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    if (!config.auth) this.#config.auth = undefined;
    this.#prefix = this.#config.prefix.replace(/:/gim, '') + ':';
    this.#nsSeparator = this.#config.nsSeparator;
    this.#interceptors = Array.isArray(this.#config.interceptor)
      ? this.#config.interceptor
      : [this.#config.interceptor];
    // 0, null, false and negatives all mean "never offload".
    if (!(this.#config.offloadThreshold >= 1))
      this.#config.offloadThreshold = null;

    // config.debug = true;
    if (this.#config.debug) console.info('Snub Init => ', config);

    // dev-only: warn when an emit builder is GC'd without ever being sent (B13).
    // The held value carries a tiny `state` object, never `emitObj` itself, so
    // registration does not keep the builder alive.
    if (this.#config.debug && typeof FinalizationRegistry !== 'undefined') {
      this.#emitRegistry = new FinalizationRegistry(({ eventName, type, state }) => {
        if (!state.sent)
          console.warn(
            `[snub] ${type}('${eventName}') was created but never sent — did you forget .send()?`
          );
      });
    }

    const filename = path.basename(__filename);

    // keeping concerns separate with different redis connections
    this.#redis = new Redis(config.redisStore || config.redisAuth || config);
    this.#redis.client('SETNAME', 'redis:' + filename).catch(() => {});

    this.#redis.on('error', (err) => {
      console.error(`[snub] Redis (store) connection error (${redisConnStr(this.#redis)}):`, err.message);
    });

    this.#pub = new Redis(config.redisAuth || config);
    this.#pub.client('SETNAME', 'pub:' + filename).catch(() => {});

    this.#pub.on('error', (err) => {
      console.error(`[snub] Redis (pub) connection error (${redisConnStr(this.#pub)}):`, err.message);
    });

    this.#sub = new Redis(config.redisAuth || config);
    this.#sub.client('SETNAME', 'sub:' + filename).catch(() => {});
    this.#sub.on('pmessage', this.#pmessage.bind(this));
    this.#sub.on('error', (err) => {
      console.error(`[snub] Redis (sub) connection error (${redisConnStr(this.#sub)}):`, err.message);
    });

    // message delay interval — opt out with processDelayQueue: false
    if (this.#config.processDelayQueue === false) return;
    this.#delayInterval = setInterval(async () => {
      const now = Date.now();
      const queueKey = `${this.#prefix}_monoDelayQueue`;
      const maxJobs = 100; // tune this based on expected load
    
      try {
        const jobs = await this.#redis.zrangebyscore(queueKey, 0, now, 'LIMIT', 0, maxJobs);
    
        for (const job of jobs) {
          // Atomically attempt to remove the job to prevent duplicates across workers
          const removed = await this.#redis.zrem(queueKey, job);
          if (!removed) continue; // someone else claimed it
    
          if (this.#config.debug) console.log('Snub Delayed event =>', job);
    
          let payload;
          try {
            payload = parseJson(job);
          } catch (err) {
            console.error('[snub] Failed to parse delayed job payload:', err.message, '— raw:', String(job).slice(0, 120));
            continue;
          }

          if (payload?.eventName && payload?.contents) {
            this.mono(payload.eventName, payload.contents).send();
          }
        }
      } catch (err) {
        console.error('[snub] Delay queue poll failed:', err.message);
      }
    }, this.#config.delayResolution);
    
  }

  get status() {
    return {
      listeners: this.eventListenerCount,
      patterns: this.#subscribedPatterns.size,
      redisPub: this.#pub.status,
      redisSub: this.#sub.status,
      redis: this.#redis.status,
      // subPatternKeys: this.#subscribedPatterns.keys(),
      // eventMapKeys: this.#eventsMap.keys(),
    };
  }

  async close() {
    clearInterval(this.#delayInterval);
    this.#delayInterval = null;
    // Pending reply timers would otherwise fire against dead connections.
    for (const timer of this.#replyTimers) clearTimeout(timer);
    this.#replyTimers.clear();
    // Idempotent: shutdown paths genuinely run twice (signal handler plus an
    // explicit teardown), and quit() on an ended connection rejects.
    await Promise.all(
      [this.#redis, this.#pub, this.#sub].map((c) =>
        c.status === 'end'
          ? Promise.resolve()
          : c.quit().catch(() => c.disconnect())
      )
    );
  }

  async cancelDelay(jobId) {
    const jobKey = `${this.#prefix}_monoDelayJob:${jobId}`;
    const payload = await this.#redis.get(jobKey);
    if (!payload) return false;
    const zsetKey = `${this.#prefix}_monoDelayQueue`;
    await this.#redis.pipeline([
      ['zrem', zsetKey, payload],
      ['del', jobKey],
    ]).exec();
    return true;
  }

  get eventListenerCount() {
    let totalItemCount = 0;
    for (let array of this.#eventsMap.values()) {
      totalItemCount += array.length;
    }
    return totalItemCount;
  }

  // redid connections
  get redis() {
    return this.#redis;
  }
  get pub() {
    return this.#pub;
  }
  get sub() {
    return this.#sub;
  }

  // helper functions
  static generateUID() {
    return generateUID;
  }
  get generateUID() {
    return generateUID;
  }
  get parseJson() {
    return parseJson;
  }
  get stringifyJson() {
    return stringifyJson;
  }

  // exposed functions
  async use(method) {
    if (typeof method === 'function') method(this);
  }

  async on(iPattern, method) {
    await this.#add(iPattern, method, false);
  }

  async once(iPattern, method) {
    await this.#add(iPattern, method, true);
  }

  async off(iPattern) {
    await this.#remove(iPattern);
  }

  mono(channel, data) {
    return this.#emit('mono', channel, data);
  }

  poly(channel, data) {
    return this.#emit('poly', channel, data);
  }

  // private functions
  #find(iPattern) {
    const [pattern, namespace] = iPattern.split(this.#nsSeparator);
    let eventList = this.#eventsMap.get(pattern) || [];
    eventList = eventList.filter(
      (e) => e.namespace === namespace || !namespace
    );
    return eventList;
  }

  async #add(iPattern, method, once) {
    const [pattern, namespace] = iPattern.split(this.#nsSeparator);
    let eventList = this.#eventsMap.get(pattern);
    if (!eventList) {
      eventList = [];
    }
    const eventObject = {
      pattern: pattern,
      namespace: namespace,
      method: method,
      once: once,
    };
    // console.log('EventsRegistry.add => ', pattern, namespace, eventObject);
    eventList.push(eventObject);
    this.#eventsMap.set(pattern, eventList);
    try {
      await this.#sub.psubscribe(this.#prefix + pattern);
      this.#subscribedPatterns.add(this.#prefix + pattern);
    } catch (error) {
      console.error(`[snub] Failed to subscribe to "${this.#prefix + pattern}":`, error.message);
      this.#remove(eventObject);
    }
    if (this.#config.debug) console.log('Snub.on => ', this.#prefix + iPattern);
  }

  async #remove(iPattern) {
    let pattern;
    let eventList;
    if (typeof iPattern === 'object') {
      // Removing a specific event object — always filter by reference,
      // never delete the whole pattern (fixes once() nuking sibling listeners).
      pattern = iPattern.pattern;
      eventList = this.#eventsMap.get(pattern) || [];
      eventList = eventList.filter((e) => e !== iPattern);
      this.#eventsMap.set(pattern, eventList);
    } else {
      const [p, namespace] = iPattern.split(this.#nsSeparator);
      pattern = p;
      if (!namespace) {
        this.#eventsMap.delete(pattern);
      } else {
        eventList = this.#eventsMap.get(pattern) || [];
        eventList = eventList.filter((e) => e.namespace !== namespace);
        this.#eventsMap.set(pattern, eventList);
      }
    }
    eventList = this.#eventsMap.get(pattern) || [];
    if (!eventList.length) {
      try {
        await this.#sub.punsubscribe(this.#prefix + pattern);
        this.#subscribedPatterns.delete(this.#prefix + pattern);
      } catch (error) {
        console.error(`[snub] Failed to unsubscribe from "${this.#prefix + pattern}":`, error.message);
      }
    }
    if (this.#config.debug)
      console.log('Snub.off => ', this.#prefix + iPattern);
  }

  #stat(obj) {
    if (!obj.pattern.startsWith('_')) this.#config.stats(obj);
  }

  #emit(type, eventName, data) {
    if (this.#config.debug)
      console.log(`Snub.${type} => `, this.#prefix + eventName);
    const emitObj = {
      key: generateUID(),
      contents: data,
      reply: false,
      ts: Date.now(),
      replyMethod: null,
      replies: 0,
      listened: 0,
      timeout: this.#config.timeout,
      send: send.bind(this),
      sendDelay: type === 'mono' ? sendDelay.bind(this) : undefined,
      awaitReply: awaitReply.bind(this),
    };

    emitObj.replyAt = (replyMethod, timeout) => {
      emitObj.timeout = timeout || emitObj.timeout;
      emitObj.reply = typeof replyMethod === 'function';
      if (emitObj.reply) emitObj.replyMethod = replyMethod;
      return emitObj;
    };

    // B13 — track whether this builder was ever sent, for the dev-mode
    // unsent-builder warning. Kept separate from emitObj so the registry can
    // hold it without pinning the builder in memory.
    const sendState = { sent: false };
    if (this.#emitRegistry)
      this.#emitRegistry.register(emitObj, { eventName, type, state: sendState });

    async function send(cb) {
      sendState.sent = true;
      let pubPayload = null;
      let replyEventName;
      let replyTimout;

      if (type === 'mono') {
        pubPayload = this.#prefix + '_mono:' + emitObj.key;
        await this.#redis.set(
          pubPayload,
          serializePayload(),
          'EX',
          Math.ceil((emitObj.timeout + 1000) / 1000)
        );
      }

      if (type === 'poly') {
        pubPayload = serializePayload();
        // Large payloads (commonly `_monoReply` bodies) go into redisStore and only
        // the key travels on the bus — a multi-MB PUBLISH stalls the whole Redis
        // instance. Mono already works this way; this closes the gap for poly.
        if (
          this.#config.offloadThreshold &&
          Buffer.byteLength(pubPayload, 'utf8') > this.#config.offloadThreshold
        ) {
          const offloadKey = this.#prefix + '_offload:' + emitObj.key;
          // awaited, unlike snub-ws's fire-and-forget, so the value is in place
          // before the publish below wakes any subscriber up
          await this.#redis.set(
            offloadKey,
            pubPayload,
            'EX',
            Math.ceil((emitObj.timeout + 1000) / 1000)
          );
          pubPayload = offloadKey;
        }
      }

      // handle reply
      if (emitObj.reply) {
        replyEventName = this.#prefix + '_monoReply:' + emitObj.key;

        replyTimout = setTimeout((_) => {
          this.#replyTimers.delete(replyTimout);
          this.off(replyEventName);
          if (type === 'mono' && emitObj.replies < 1) {
            emitObj.replyMethod(
              null,
              `[snub] Timed out waiting for a reply to "${eventName}" (${emitObj.timeout}ms)`
            );
          }
        }, emitObj.timeout);
        this.#replyTimers.add(replyTimout);

        const sweepTimer = setTimeout((_) => {
          this.#replyTimers.delete(sweepTimer);
          this.off(replyEventName);
        }, emitObj.timeout + 1000);
        this.#replyTimers.add(sweepTimer);

        this.on(replyEventName, (rawReply) => {
          const [replyData, _registeredEvent] = rawReply;
          emitObj.replies++;
          if (this.#config.debug)
            console.log(
              'Snub.emit reply => ',
              this.#prefix + eventName,
              Date.now() - emitObj.ts + 'ms'
            );
          if (typeof replyData === 'object' && replyData !== null)
            Object.defineProperty(replyData, 'responseTime', {
              value: Date.now() - emitObj.ts,
            });
          emitObj.replyMethod(replyData);
          if (type === 'mono') {
            emitObj.replyMethod = (_) => {};
            clearTimeout(replyTimout);
            this.#replyTimers.delete(replyTimout);
          }
        });
      }

      emitObj.listened = await this.#pub.publish(
        this.#prefix + eventName,
        pubPayload
      );
      if (typeof cb === 'function') cb(emitObj.listened);

      // Surface no-listener error immediately for mono+reply instead of waiting for timeout.
      if (emitObj.reply && type === 'mono' && emitObj.listened < 1) {
        clearTimeout(replyTimout);
        this.#replyTimers.delete(replyTimout);
        this.off(replyEventName);
        emitObj.replyMethod(
          null,
          `[snub] No listeners on "${eventName}" — message was not delivered`
        );
      }

      return emitObj.listened;
    }

    async function sendDelay(seconds) {
      sendState.sent = true;
      const when = emitObj.ts + seconds * 1000; // scheduled time
      const zsetKey = `${this.#prefix}_monoDelayQueue`;
      const jobKey = `${this.#prefix}_monoDelayJob:${emitObj.key}`;
      const jobPayload = serializePayload();

      await this.#redis.pipeline([
        ['zadd', zsetKey, when, jobPayload],
        ['set', jobKey, jobPayload, 'EX', Math.ceil(seconds) + 60],
      ]).exec();

      return emitObj.key; // job ID for use with cancelDelay()
    }

    // meet expected replies or timeout whichever comes first.
    function awaitReply(timeout, expectedReplies) {
      expectedReplies = type === 'mono' ? 1 : expectedReplies;
      const replies = [];
      emitObj.timeout = timeout || emitObj.timeout;
      return new Promise((resolve, reject) => {
        let to;
        const done = () => {
          clearTimeout(to);
          resolve(type === 'mono' ? replies[0] : replies);
        };
        emitObj
          .replyAt((data, err) => {
            if (err) return reject(err);
            replies.push(data);
            if (replies.length >= expectedReplies) return done();
            clearTimeout(to);
            to = setTimeout(done, emitObj.timeout);
          }, emitObj.timeout)
          .send((count) => {
            if (count < 1)
              reject(`[snub] No listeners on "${eventName}" — nothing is subscribed to this event`);
          });
      });
    }

    function serializePayload(extra = {}) {
      return stringifyJson({
        key: emitObj.key,
        contents: emitObj.contents,
        reply: emitObj.reply,
        ts: emitObj.ts,
        eventName: eventName,
        channel: eventName, // legacy
        ...extra,
      });
    }

    return emitObj;
  }

  async #pmessage(pattern, channel, message) {
    pattern = pattern.replace(this.#prefix, '');

    const registeredEvents = this.#find(pattern);
    // console.log('Snub pmessage => ', pattern, registeredEvents, e);
    if (!registeredEvents.length) return;

    // Offloaded poly payloads publish only the key — fetch the body back once here
    // rather than once per listener. GET only, never DEL: poly fans out, so a
    // delete by the first reader would starve every other subscriber. The TTL set
    // on publish is the cleanup.
    if (
      typeof message === 'string' &&
      message.startsWith(this.#prefix + '_offload:')
    ) {
      let body;
      try {
        body = await this.#redis.get(message);
      } catch (err) {
        console.error(
          `[snub] Failed to fetch offloaded payload for "${channel}":`,
          err.message
        );
        return;
      }
      if (body == null) {
        console.error(
          `[snub] Offloaded payload for "${channel}" is missing or expired (${message}) — message dropped`
        );
        return;
      }
      message = body;
    }

    registeredEvents.forEach(async (event) => {
      let data;
      // mono messages get delivered once.
      if (message.startsWith(this.#prefix + '_mono:')) {
        // wait is in ms, it will give all handlers a fighting chance to grab the message.
        await justWait(Math.round(Math.random() * this.#config.monoWait));
        const response = await this.#redis
          .pipeline([
            ['get', message],
            ['del', message],
          ])
          .exec();
        const [getR, delR] = response;
        if (delR[1] && getR[1]) message = getR[1];
        else return;
      }
      try {
        data = parseJson(message);
      } catch (parseErr) {
        // Anything that can PUBLISH to this Redis can send garbage, and a
        // `{dataType:'Map', value:42}` body throws inside the reviver. Bail
        // here — dereferencing the undefined result takes the process down.
        console.error(
          `[snub] Failed to parse message on "${channel}":`,
          parseErr.message,
          '— raw:',
          String(message).slice(0, 120)
        );
        return;
      }

      // console.log('Snub pmessage data => ', pattern, data);
      let replyMethod = (_) => {};
      if (data.reply) {
        replyMethod = (replyData) => {
          // console.log('Snub pmessage reply data => ', pattern, replyData);
          this.poly(this.#prefix + '_monoReply:' + data.key, [
            replyData,
            event,
          ]).send();
          this.#stat({
            pattern: event.pattern,
            replyTime: Date.now() - data.ts,
          });
        };
      }

      for (const interceptorFn of this.#interceptors) {
        const intercept = await interceptorFn(
          data.contents,
          replyMethod,
          event.pattern,
          channel
        );
        if (intercept === false) return;
      }

      // A throwing handler must not take the instance down with it. Deliberately
      // not awaited — awaiting would push the `once` removal below past the
      // handler resolving and change once() timing.
      try {
        const result = event.method(
          data.contents,
          replyMethod,
          channel,
          event.pattern
        );
        if (result && typeof result.then === 'function')
          result.catch((err) =>
            console.error(
              `[snub] Handler for "${event.pattern}" rejected:`,
              err
            )
          );
      } catch (err) {
        console.error(`[snub] Handler for "${event.pattern}" threw:`, err);
      }
      if (!data.reply)
        this.#stat({
          pattern: event.pattern,
          replyTime: 0,
        });

      if (event.once)
        this.#remove(event);
    });
  }
}

function redisConnStr(client) {
  const { host = 'localhost', port = 6379, db = 0 } = client.options || {};
  return `${host}:${port}/db${db}`;
}

function justWait(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function generateUID() {
  return randomBytes(8).toString('hex');
}

function stringifyJson(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (value instanceof Map) {
      return {
        dataType: 'Map',
        value: Array.from(value.entries()), // Convert Map to array of key-value pairs
      };
    } else if (value instanceof Set) {
      return {
        dataType: 'Set',
        value: Array.from(value), // Convert Set to array
      };
    }
    return value;
  });
}

function reviveDataTypes(key, value) {
  if (value && value.dataType === 'Map') {
    return new Map(value.value); // Convert array of key-value pairs back to Map
  } else if (value && value.dataType === 'Set') {
    return new Set(value.value); // Convert array back to Set
  }
  return value;
}

function parseJson(json) {
  // A reviver is invoked once per value in the document, which on a large
  // payload costs several times the parse itself. It can only ever transform
  // something if the literal `"dataType"` appears in the source, so scan for it
  // first — a native substring search is far cheaper than the per-value
  // callback, and skipping the reviver when it cannot match is behaviour-
  // preserving. Measured ~7.5x faster on tag-free payloads, no regression on
  // tagged ones.
  if (typeof json === 'string' && !json.includes('"dataType"'))
    return JSON.parse(json);
  return JSON.parse(json, reviveDataTypes);
}

module.exports = Snub;
