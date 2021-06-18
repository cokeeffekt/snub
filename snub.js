var path = require('path');
var filename = 'Unknown';
try {
  filename = path.basename(process.mainModule.filename);
} catch (_e) {}

module.exports = function (config) {
  config = Object.assign(
    {
      prefix: 'snub',
      port: 6379,
      host: '127.0.0.1',
      debug: false,
      monoWait: 50,
      timeout: 5000,
      nsSeparator: '.',
      delayResolution: 1000,
      stats: (_) => {},
      redisStore: null,
    },
    config || {}
  );
  if (!config.auth) delete config.auth;

  // config.debug = true;
  if (config.debug) console.error('Snub Init => ', config);

  var $ = this;
  var prefix = config.prefix.replace(/:/gim, '') + ':';
  const Redis = require('ioredis');

  // redis connection for each concern
  var redis; // = new Redis(config.redisStore || config);
  var pub;
  var sub;
  var eventsRegistered = [];

  this.redis = redis;
  if (config.delayResolution !== false)
    setInterval(async (_) => {
      try {
        var keys = await $.pub.keys(prefix + '_monoDelay:*');
        if (!keys || !keys.length) return;
        var values = (await $.pub.mget(keys)).map((v) => JSON.parse(v));
        for (var i in values) {
          var when = values[i].ts + values[i].seconds * 1000;
          if (Date.now() < when) continue;
          var r = await $.pub
            .pipeline([
              ['get', keys[i]],
              ['del', keys[i]],
            ])
            .exec();
          var [getR] = r;
          if (getR[0] || !getR[1]) continue;
          var e = JSON.parse(getR[1]);
          this.mono(e.channel, e.contents).send();
        }
      } catch (error) {
        if (config.debug) console.error('Snub.delayInternal => ', error);
      }
    }, config.delayResolution);

  Object.defineProperties(this, {
    status: {
      get: (_) => {
        return {
          listeners: eventsRegistered.length,
          redis: redis ? redis.status : null,
          redisPub: pub ? pub.status : null,
          redisSub: sub ? sub.status : null,
        };
      },
    },
    redis: {
      get: (_) => {
        if (redis) return redis;
        if (config.debug) console.log('Snub.Init => ', 'redis:' + filename);

        redis = new Redis(config.redisStore || config);
        redis.client('SETNAME', 'redis:' + filename);
        return redis;
      },
    },
    sub: {
      get: (_) => {
        if (sub) return sub;
        if (config.debug) console.log('Snub.Init => ', 'sub:' + filename);

        sub = new Redis(config);
        sub.client('SETNAME', 'sub:' + filename);
        sub.on('pmessage', pmessage.bind(this));
        return sub;
      },
    },
    pub: {
      get: (_) => {
        if (pub) return pub;
        if (config.debug) console.log('Snub.Init => ', 'pub:' + filename);

        pub = new Redis(config);
        pub.client('SETNAME', 'pub:' + filename);
        return pub;
      },
    },
  });

  function stat(obj) {
    if (!obj.pattern.startsWith(prefix)) config.stats(obj);
  }

  this.on = async (iPattern, method, once) => {
    var [pattern, namespace] = iPattern.split(config.nsSeparator);
    if (config.debug) console.log('Snub.on => ', prefix + pattern);

    var ev = {
      pattern: pattern,
      namespace: namespace,
      method: method,
      once: once,
    };

    eventsRegistered.push(ev);
    try {
      await $.sub.psubscribe(prefix + pattern);
    } catch (error) {
      console.log('Snub Error => ' + error);
      var evIndex = eventsRegistered.findIndex((e) => e === ev);
      eventsRegistered.splice(evIndex, 1);
    }
  };

  this.off = async (iPattern) => {
    var [pattern, namespace] = iPattern.split('.');
    if (config.debug) console.log('Snub.off => ', prefix + pattern);
    eventsRegistered
      .filter((e) => e.pattern === pattern && e.namespace === namespace)
      .map((v) => eventsRegistered.findIndex((f) => f === v))
      .reverse()
      .forEach((i) => eventsRegistered.splice(i, 1));
    if (!eventsRegistered.find((e) => e.pattern === pattern))
      await $.sub.punsubscribe(prefix + pattern);
  };

  // send to one listener
  this.mono = function (channel, data) {
    if (config.debug) console.log('Snub.mono => ', prefix + channel);
    return {
      key: generateUID(),
      contents: data,
      reply: false,
      ts: Date.now(),
      replyMethod: null,
      replies: 0,
      listened: 0,
      timeout: config.timeout,
      replyAt(replyMethod, timeout) {
        this.timeout = timeout || this.timeout;
        this.reply = typeof replyMethod === 'function';
        if (this.reply) this.replyMethod = replyMethod;
        return this;
      },
      async send(cb) {
        await $.pub.set(
          prefix + '_mono:' + this.key,
          JSON.stringify({
            key: this.key,
            contents: this.contents,
            reply: this.reply,
            ts: this.ts,
            channel: channel,
          }),
          'EX',
          Math.ceil((this.timeout + 1000) / 1000)
        );
        if (this.reply) {
          $.on(
            prefix + '_monoReply:' + this.key,
            (rawReply) => {
              // eslint-disable-next-line
              var [replyData, _registeredEvent] = rawReply;
              this.replies++;
              if (config.debug)
                console.log(
                  'Snub.mono reply => ',
                  prefix + channel,
                  Date.now() - this.ts + 'ms'
                );
              if (typeof replyData === 'object' && replyData !== null)
                Object.defineProperty(replyData, 'responseTime', {
                  value: Date.now() - this.ts,
                });
              this.replyMethod(replyData);
            },
            true
          );
          setTimeout((_) => {
            $.off(prefix + '_monoReply:' + this.key);
            if (this.replies < 1)
              this.replyMethod(null, 'Snub Error => Event timeout, no reply');
          }, this.timeout);
        }
        this.listened = await $.pub.publish(
          prefix + channel,
          prefix + '_mono:' + this.key
        );
        if (typeof cb === 'function') cb(this.listened);
        return this.listened;
      },
      // linger is how many seconds the event will sit waiting to be picked
      async sendDelay(seconds, linger = 5) {
        await $.pub.set(
          prefix + '_monoDelay:' + this.key,
          JSON.stringify({
            key: this.key,
            contents: this.contents,
            ts: this.ts,
            channel: channel,
            seconds: seconds,
          }),
          'EX',
          seconds + linger
        );
      },
      awaitReply(timeout) {
        return new Promise((resolve, reject) => {
          this.replyAt((data, err) => {
            if (err) return reject(err);
            resolve(data);
          }, timeout).send((count) => {
            if (count < 1)
              reject('Snub Error => nothing was listing to this event.');
          });
        });
      },
    };
  };

  // sending messages to any/all matching listeners
  this.poly = function (channel, data) {
    if (config.debug) console.log('Snub.poly => ', prefix + channel);

    return {
      key: generateUID(),
      contents: data,
      reply: false,
      ts: Date.now(),
      replyMethod: null,
      replies: 0,
      listened: 0,
      timeout: config.timeout,
      replyAt(replyMethod, timeout) {
        this.timeout = timeout || this.timeout;
        this.reply = typeof replyMethod === 'function';
        if (this.reply) this.replyMethod = replyMethod;
        return this;
      },
      async send(cb) {
        if (this.reply) {
          $.on(prefix + '_monoReply:' + this.key, (rawReply) => {
            // eslint-disable-next-line
            var [replyData, _registeredEvent] = rawReply;
            if (config.debug)
              console.log(
                'Snub.poly reply => ',
                prefix + channel,
                Date.now() - this.ts + 'ms'
              );
            if (typeof replyData === 'object' && replyData !== null)
              Object.defineProperty(replyData, 'responseTime', {
                value: Date.now() - this.ts,
              });
            this.replyMethod(replyData);
          });
          setTimeout((_) => {
            $.off(prefix + '_monoReply:' + this.key);
          }, this.timeout);
        }
        this.listened = await $.pub.publish(
          prefix + channel,
          JSON.stringify({
            key: this.key,
            contents: this.contents,
            reply: this.reply,
            ts: this.ts,
          })
        );

        if (typeof cb === 'function') cb(this.listened);
        return this.listened;
      },
    };
  };

  this.generateUID = generateUID;

  this.use = function (method) {
    if (typeof method === 'function') method($);
  };

  function pmessage(pattern, channel, message) {
    // if (config.debug)
    //   console.log('Snub pmessage => ', pattern);

    pattern = pattern.replace(prefix, '');

    var e = eventsRegistered.filter((e, idx) => {
      if (e.pattern !== pattern) return false;
      if (
        message.includes(prefix + '_mono:') &&
        eventsRegistered.findIndex((i) => i.pattern === e.pattern) !== idx
      )
        return false;
      return true;
    });
    if (e.length < 1) return;
    // if you have multiple listeners on the same instance randomize the order mainly for the sake of it, you know in case...
    // if (config.debug)
    //   console.log('Snub pmessage matches => ', pattern, e);

    e.sort(() => Math.round(Math.random() * 2) - 1).forEach(async (e) => {
      var data;
      // mono messages get delivered once.
      if (message.includes(prefix + '_mono:')) {
        // wait is in ms, it will give all handlers a fighting chance to grab the message.
        await justWait(Math.round(Math.random() * config.monoWait));
        var response = await $.pub
          .pipeline([
            ['get', message],
            ['del', message],
          ])
          .exec();
        var [getR, delR] = response;
        if (delR[1] && getR[1]) message = getR[1];
        else return;
      }
      try {
        data = JSON.parse(message);
      } catch (e) {
        if (config.debug) console.log('Snub Error => ' + e);
      }

      // console.log('Snub pmessage data => ', pattern, data);

      if (data.reply) {
        e.method(
          data.contents,
          (replyData) => {
            // console.log('Snub pmessage reply data => ', pattern, replyData);
            this.poly(prefix + '_monoReply:' + data.key, [replyData, e]).send();
            stat({
              pattern: e.pattern,
              replyTime: Date.now() - data.ts,
            });
          },
          channel,
          e.pattern
        );
      } else {
        e.method(data.contents, null, channel, e.pattern);
        stat({
          pattern: e.pattern,
          replyTime: 0,
        });
      }

      if (e.once) this.off(e.pattern + (e.namespace ? '.' + e.namespace : ''));
    });
  }
};

function justWait(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function generateUID() {
  var firstPart = (Math.random() * 46656) | 0;
  var secondPart = (Math.random() * 46656) | 0;
  firstPart = ('000' + firstPart.toString(36)).slice(-3);
  secondPart = ('000' + secondPart.toString(36)).slice(-3);
  return firstPart + secondPart;
}
