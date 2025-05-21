const path = require('path');
const Redis = require('ioredis');

const DEFAULT_CONFIG = {
  prefix: 'snub',
  debug: false,
  monoWait: 50, // this is a maximum wait time in ms for mono messages to be delivered.
  timeout: 5000,
  nsSeparator: '.',
  delayResolution: 1000, // mono delay resolution in ms
  stats: (_) => {},
  redisAuth: null,
  redisStore: null,
  interceptor: async (payload, reply, listener, eventName) => {
    return true; // return false to block the event
  },
};

class Snub {
  #subcribedPatterns = new Set();
  #eventsMap = new Map();
  #config;
  #prefix;

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

    // config.debug = true;
    if (this.#config.debug) console.info('Snub Init => ', config);

    const filename = path.basename(__filename);

    // keeping concerns separate with different redis connections
    this.#redis = new Redis(config.redisStore || config.redisAuth || config);
    this.#redis.client('SETNAME', 'redis:' + filename);

    this.#redis.on('error', (err) => {
      console.error('Redis error:', err, config);
    });

    this.#pub = new Redis(config.redisAuth || config);
    this.#pub.client('SETNAME', 'pub:' + filename);

    this.#pub.on('error', (err) => {
      console.error('Redis Pub error:', err, config);
    });

    this.#sub = new Redis(config.redisAuth || config);
    this.#sub.client('SETNAME', 'sub:' + filename);
    this.#sub.on('pmessage', this.#pmessage.bind(this));
    this.#sub.on('error', (err) => {
      console.error('Redis Sub error:', err, config);
    });

    // message delay interval
    setInterval(async (_) => {
      const now = Date.now();
      const keys = await this.#redis.keys(`${this.#prefix}_monoDelay:*`);

      keys.forEach(async (key) => {
        const [_, __, id, when] = key.split(':');
        if (now < parseInt(when)) return;
        if (this.#config.debug) console.log('Snub Delayed event => ', key);
        const event = await this.#pub
          .pipeline([
            ['get', key],
            ['del', key],
          ])
          .exec();
        if (!event[0][1]) return;
        let payload = event[0][1];
        payload = parseJson(payload);
        this.mono(payload.eventName, payload.contents).send();
      });
    }, this.#config.delayResolution);
  }

  get status() {
    return {
      listeners: this.eventListenerCount,
      patterns: this.#subcribedPatterns.size,
      redisPub: this.#pub.status,
      redisSub: this.#sub.status,
      redis: this.#redis.status,
      // subPatternKeys: this.#subcribedPatterns.keys(),
      // eventMapKeys: this.#eventsMap.keys(),
    };
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
    this.#add(iPattern, method, false);
  }

  async once(iPattern, method) {
    this.#add(iPattern, method, true);
  }

  async off(iPattern) {
    this.#remove(iPattern);
  }

  mono(channel, data) {
    return this.#emit('mono', channel, data);
  }

  poly(channel, data) {
    return this.#emit('poly', channel, data);
  }

  // private functions
  #find(iPattern) {
    const [pattern, namespace] = iPattern.split('.');
    let eventList = this.#eventsMap.get(pattern) || [];
    eventList = eventList.filter(
      (e) => e.namespace === namespace || !namespace
    );
    return eventList;
  }

  async #add(iPattern, method, once) {
    const [pattern, namespace] = iPattern.split('.');
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
      this.#subcribedPatterns.add(this.#prefix + pattern);
    } catch (error) {
      console.log('Snub Error => ' + error);
      this.#remove(eventObject);
    }
    if (this.#config.debug) console.log('Snub.on => ', this.#prefix + iPattern);
  }

  async #remove(iPattern) {
    let pattern;
    let namespace;
    let eventList;
    if (typeof iPattern === 'object') {
      pattern = iPattern.pattern;
      namespace = iPattern.namespace;
    } else {
      [pattern, namespace] = iPattern.split('.');
    }
    if (!namespace) this.#eventsMap.delete(pattern);
    else {
      eventList = this.#eventsMap.get(pattern) || [];
      eventList = eventList.filter((e) =>
        typeof iPattern === 'object'
          ? e !== iPattern
          : e.namespace !== namespace
      );
      this.#eventsMap.set(pattern, eventList);
    }
    eventList = this.#eventsMap.get(pattern) || [];
    if (!eventList.length) {
      try {
        await this.#sub.punsubscribe(this.#prefix + pattern);
        this.#subcribedPatterns.delete(this.#prefix + pattern);
      } catch (error) {
        console.log('Snub Error => ' + error);
      }
    }
    if (this.#config.debug)
      console.log('Snub.off => ', this.#prefix + iPattern);
  }

  #stat(obj) {
    if (!obj.pattern.startsWith(this.#prefix)) this.#config.stats(obj);
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

    async function send(cb) {
      let pubPayload = null;

      if (type === 'mono') {
        pubPayload = this.#prefix + '_mono:' + emitObj.key;
        await this.#pub.set(
          pubPayload,
          serializePayload(),
          'EX',
          Math.ceil((emitObj.timeout + 1000) / 1000)
        );
      }

      if (type === 'poly') {
        pubPayload = serializePayload();
      }

      // handle reply
      if (emitObj.reply) {
        const replyEventName = this.#prefix + '_monoReply:' + emitObj.key;

        let replyTimout = setTimeout((_) => {
          this.off(replyEventName);
          if (type === 'mono' && emitObj.replies < 1) {
            emitObj.replyMethod(
              null,
              'Snub Error => Event timeout, no reply from : ' +
                this.#prefix +
                eventName
            );
          }
        }, emitObj.timeout);

        setTimeout((_) => {
          this.off(replyEventName);
        }, emitObj.timeout + 1000);

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
          }
        });
      }

      emitObj.listened = await this.#pub.publish(
        this.#prefix + eventName,
        pubPayload
      );
      if (typeof cb === 'function') cb(emitObj.listened);
      return emitObj.listened;
    }

    async function sendDelay(
      seconds,
      linger = this.#config.delayResolution * 2
    ) {
      //@todo poly delay and support replies
      const key =
        this.#prefix +
        '_monoDelay:' +
        emitObj.key +
        ':' +
        (emitObj.ts + seconds * 1000);
      await this.#pub.set(
        key,
        serializePayload({ seconds }),
        'EX',
        seconds + linger / 1000 // redis is in seconds.
      );
    }

    // meet expected replies or timeout whichever comes first.
    function awaitReply(timeout, expectedReplies) {
      expectedReplies = type === 'mono' ? 1 : expectedReplies;
      const replies = [];
      emitObj.timeout = timeout || emitObj.timeout;
      return new Promise((resolve, reject) => {
        emitObj
          .replyAt((data, err) => {
            if (err) return reject(err);
            let to = setTimeout((_) => {
              resolve(type === 'mono' ? replies[0] : replies);
            }, emitObj.timeout);
            replies.push(data);

            if (replies.length >= expectedReplies) {
              clearTimeout(to);
              resolve(type === 'mono' ? replies[0] : replies);
            }
          }, emitObj.timeout)
          .send((count) => {
            if (count < 1)
              reject('Snub Error => nothing was listing to this event.');
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

  #pmessage(pattern, channel, message) {
    pattern = pattern.replace(this.#prefix, '');

    const registeredEvents = this.#find(pattern);
    // console.log('Snub pmessage => ', pattern, registeredEvents, e);

    registeredEvents.forEach(async (event) => {
      let data;
      // mono messages get delivered once.
      if (message.includes(this.#prefix + '_mono:')) {
        // wait is in ms, it will give all handlers a fighting chance to grab the message.
        await justWait(Math.round(Math.random() * this.#config.monoWait));
        const response = await this.#pub
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
      } catch (event) {
        if (this.#config.debug) console.log('Snub Error => ' + event);
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

      const intercept = await this.#config.interceptor(
        data.contents,
        replyMethod,
        event.pattern,
        channel
      );
      if (intercept === false) return;

      event.method(data.contents, replyMethod, channel, event.pattern);
      if (!replyMethod)
        this.#stat({
          pattern: event.pattern,
          replyTime: 0,
        });

      if (event.once)
        this.off(
          event.pattern + (event.namespace ? '.' + event.namespace : '')
        );
    });
  }
}

function justWait(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function generateUID() {
  let firstPart = (Math.random() * 46656) | 0;
  let secondPart = (Math.random() * 46656) | 0;
  firstPart = ('000' + firstPart.toString(36)).slice(-3);
  secondPart = ('000' + secondPart.toString(36)).slice(-3);
  return firstPart + secondPart;
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

function parseJson(json) {
  return JSON.parse(json, (key, value) => {
    if (value && value.dataType === 'Map') {
      return new Map(value.value); // Convert array of key-value pairs back to Map
    } else if (value && value.dataType === 'Set') {
      return new Set(value.value); // Convert array back to Set
    }
    return value;
  });
}

module.exports = Snub;
