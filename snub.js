var path = require('path');
var filename = 'Unknown';
try {
  filename = path.basename(process.mainModule.filename);
} catch (_e) {}

module.exports = function (config) {
  config = Object.assign({
    prefix: 'snub',
    port: 6379,
    host: '127.0.0.1',
    debug: false,
    monoWait: 50,
    timeout: 5000,
    stats: _ => {},
    redisStore: null
  }, config || {});
  if (!config.auth)
    delete config.auth;

  // config.debug = true;

  var $ = this;
  var prefix = config.prefix.replace(/:/igm, '') + ':';
  const Redis = require('ioredis');

  // redis connection for each concern
  var redis;// = new Redis(config.redisStore || config);
  var pub;
  var sub;
  var eventsRegistered = [];

  this.redis = redis;

  Object.defineProperties(this, {
    status: {
      get: _ => {
        return {
          listeners: eventsRegistered.length,
          redis: redis ? redis.status : null,
          redisPub: pub ? pub.status : null,
          redisSub: sub ? sub.status : null
        };
      }
    },
    redis: {
      get: _ => {
        redis = redis || new Redis(config.redisStore || config);
        redis.client('SETNAME', 'redis:' + filename);
        return redis;
      }
    },
    sub: {
      get: _ => {
        if (sub) return sub;
        sub = new Redis(config);
        sub.client('SETNAME', 'sub:' + filename);
        sub.on('pmessage', pmessage.bind(this));
        return sub;
      }
    },
    pub: {
      get: _ => {
        pub = pub || new Redis(config);
        pub.client('SETNAME', 'pub:' + filename);
        return pub;
      }
    }
  });

  function stat (obj) {
    if (!obj.pattern.startsWith(prefix))
      config.stats(obj);
  };

  this.on = async (ipattern, method, once) => {
    var [pattern, namespace] = ipattern.split('.');

    if (config.debug)
      console.log('Snub.on => ', prefix + pattern);

    var ev = {
      pattern: pattern,
      namespace: namespace,
      method: method,
      once: once
    };

    eventsRegistered.push(ev);
    try {
      await $.sub.psubscribe(prefix + pattern);
    } catch (error) {
      console.log('Snub Error => ' + error);
      var evIndex = eventsRegistered.findIndex(e => e === ev);
      eventsRegistered.splice(evIndex, 1);
    }
  };

  this.off = async (ipattern) => {
    var [pattern, namespace] = ipattern.split('.');
    if (config.debug)
      console.log('Snub.off => ', prefix + pattern);
    eventsRegistered
      .filter(e => (e.pattern === pattern && e.namespace === namespace))
      .map(v => eventsRegistered.findIndex(f => f === v))
      .reverse().forEach(i => eventsRegistered.splice(i, 1));
    if (!eventsRegistered.find(e => e.pattern === pattern))
      await $.sub.punsubscribe(prefix + pattern);
  };

  // send to one listener
  this.mono = function (channel, data) {
    if (config.debug)
      console.log('Snub.mono => ', prefix + channel);
    return {
      key: generateUID(),
      contents: data,
      reply: false,
      ts: Date.now(),
      replyMethod: null,
      replies: 0,
      listened: 0,
      timeout: config.timeout,
      replyAt (replyMethod, timeout) {
        this.timeout = timeout || this.timeout;
        this.reply = (typeof replyMethod === 'function');
        if (this.reply)
          this.replyMethod = replyMethod;
        return this;
      },
      async send (cb) {
        await $.pub.set(prefix + '_mono:' + this.key, JSON.stringify({
          key: this.key,
          contents: this.contents,
          reply: this.reply,
          ts: this.ts
        }), 'EX', Math.ceil((this.timeout + 1000) / 1000));
        if (this.reply) {
          $.on(prefix + '_monoreply:' + this.key, rawReply => {
            // eslint-disable-next-line
            var [replyData, _registeredEvent] = rawReply;
            this.replies++;
            if (config.debug)
              console.log('Snub.mono reply => ', prefix + channel, (Date.now() - this.ts) + 'ms');
            if (typeof replyData === 'object' && replyData !== null)
              Object.defineProperty(replyData, 'responseTime', { value: (Date.now() - this.ts) });
            this.replyMethod(replyData);
          }, true);
          setTimeout(_ => {
            $.off(prefix + '_monoreply:' + this.key);
            if (this.replies < 1)
              this.replyMethod(null, 'Snub Error => Event timeout, no reply');
          }, this.timeout);
        }
        this.listened = await $.pub.publish(prefix + channel, prefix + '_mono:' + this.key);
        if (typeof cb === 'function')
          cb(this.listened);
        return this.listened;
      },
      awaitReply (timeout) {
        return new Promise((resolve, reject) => {
          this.replyAt((data, err) => {
            if (err)
              return reject(err);
            resolve(data);
          }, timeout).send(count => {
            if (count < 1)
              reject('Snub Error => nothing was listing to this event.');
          });
        });
      }
    };
  };

  // sending messages to any/all matching listeners
  this.poly = function (channel, data) {
    if (config.debug)
      console.log('Snub.poly => ', prefix + channel);

    return {
      key: generateUID(),
      contents: data,
      reply: false,
      ts: Date.now(),
      replyMethod: null,
      replies: 0,
      listened: 0,
      timeout: config.timeout,
      replyAt (replyMethod, timeout) {
        this.timeout = timeout || this.timeout;
        this.reply = (typeof replyMethod === 'function');
        if (this.reply)
          this.replyMethod = replyMethod;
        return this;
      },
      async send (cb) {
        if (this.reply) {
          $.on(prefix + '_monoreply:' + this.key, rawReply => {
            // eslint-disable-next-line
            var [replyData, _registeredEvent] = rawReply;
            if (config.debug)
              console.log('Snub.poly reply => ', prefix + channel, (Date.now() - this.ts) + 'ms');
            if (typeof replyData === 'object' && replyData !== null)
              Object.defineProperty(replyData, 'responseTime', { value: (Date.now() - this.ts) });
            this.replyMethod(replyData);
          });
          setTimeout(_ => {
            $.off(prefix + '_monoreply:' + this.key);
          }, this.timeout);
        }
        this.listened = await $.pub.publish(prefix + channel, JSON.stringify({
          key: this.key,
          contents: this.contents,
          reply: this.reply,
          ts: this.ts
        }));

        if (typeof cb === 'function')
          cb(this.listened);
        return this.listened;
      }
    };
  };

  this.generateUID = generateUID;

  this.use = function (method) {
    if (typeof method === 'function')
      method($);
  };

  function pmessage (pattern, channel, message) {
    pattern = pattern.replace(prefix, '');

    var e = eventsRegistered
      .filter((e, idx) => {
        if (e.pattern !== pattern)
          return false;
        if (message.includes(prefix + '_mono:') && eventsRegistered.findIndex(i => i.pattern === e.pattern) !== idx)
          return false;
        return true;
      });
    // if you have multiple listeners on the same instance randomise the order mainly for the sake of it, you know in case...
    e.sort(() => Math.round(Math.random() * 2) - 1)
      .forEach(async e => {
        var data;
        // mono messages get delivered once.
        if (message.includes(prefix + '_mono:')) {
          // wait is in ms, it will give all handlers a fighting chance to grab the message.
          await justWait(Math.round(Math.random() * config.monoWait));
          var response = await $.pub.pipeline([
            ['get', message],
            ['del', message]
          ]).exec();
          var [getR, delR] = response;
          if (delR[1] && getR[1])
            message = getR[1];
          else
            return;
        }
        try {
          data = JSON.parse(message);
        } catch (e) {
          if (config.debug)
            console.log('Snub Error => ' + e);
        }

        if (data.reply) {
          e.method(data.contents, replyData => {
            this.poly(prefix + '_monoreply:' + data.key, [replyData, e]).send();
            stat({
              pattern: e.pattern,
              replyTime: Date.now() - data.ts
            });
          }, channel, e.pattern);
        } else {
          e.method(data.contents, null, channel, e.pattern);
          stat({
            pattern: e.pattern,
            replyTime: 0
          });
        }

        if (e.once)
          this.off(e.pattern + (e.namespace ? '.' + e.namespace : ''));
      });
  };
};

function justWait (ms = 1000) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function generateUID () {
  var firstPart = (Math.random() * 46656) | 0;
  var secondPart = (Math.random() * 46656) | 0;
  firstPart = ('000' + firstPart.toString(36)).slice(-3);
  secondPart = ('000' + secondPart.toString(36)).slice(-3);
  return firstPart + secondPart;
}
