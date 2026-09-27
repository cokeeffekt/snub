import { Redis } from 'ioredis';

export type ReplyFn = (data: unknown) => void;

export type InterceptorFn = (
  payload: unknown,
  reply: ReplyFn,
  listener: string,
  eventName: string
) => Promise<boolean> | boolean;

export type ListenerFn = (
  payload: unknown,
  reply: ReplyFn,
  channel: string,
  eventPattern: string
) => void;

export type StatsFn = (obj: { pattern: string; replyTime: number }) => void;

export interface SnubConfig {
  /** Redis key prefix. Default: 'snub' */
  prefix?: string;
  /** Enable debug logging. Default: false */
  debug?: boolean;
  /** Max random wait (ms) given to mono handlers before racing to claim. Default: 50 */
  monoWait?: number;
  /** Default reply timeout in ms. Default: 5000 */
  timeout?: number;
  /** Separator between event name and namespace. Default: '.' */
  nsSeparator?: string;
  /** Delay queue poll interval in ms. Default: 1000 */
  delayResolution?: number;
  /** Set false to skip delay queue polling on this instance. Default: true */
  processDelayQueue?: boolean;
  /**
   * Poly payloads larger than this many bytes are stored in redisStore and only the
   * key is published on the bus. Applies to replies too, since they travel as poly.
   * Set 0 or null to disable. Default: 524288 (512 KB)
   */
  offloadThreshold?: number | null;
  /** Called after each event is handled. Filtered to user events only. */
  stats?: StatsFn;
  /** ioredis connection options or URL for pub/sub connections. */
  redisAuth?: object | string | null;
  /** ioredis connection options or URL for the storage connection. Falls back to redisAuth. */
  redisStore?: object | string | null;
  /** Interceptor function(s) run before each handler. Return false to block. */
  interceptor?: InterceptorFn | InterceptorFn[];
  /** Any additional ioredis connection options passed directly. */
  [key: string]: unknown;
}

export interface EmitObject {
  /** Unique message key (hex string). */
  key: string;
  /** Message payload. */
  contents: unknown;
  /** Whether a reply is expected. */
  reply: boolean;
  /** Message creation timestamp (ms). */
  ts: number;
  /** Number of pub/sub subscribers that received the message after send(). */
  listened: number;
  /**
   * Publish the message immediately.
   * @param cb Optional callback receiving the subscriber count.
   * @returns Number of subscribers that received the message.
   */
  send(cb?: (count: number) => void): Promise<number>;
  /**
   * Schedule the message for delivery after a delay. Mono only.
   * Note: replies are not supported across the delay boundary.
   * @param seconds Delay in seconds.
   * @returns Job ID that can be passed to snub.cancelDelay().
   */
  sendDelay(seconds: number): Promise<string>;
  /**
   * Wait for reply(ies) or timeout.
   * For mono, resolves with the single reply value.
   * For poly, resolves with an array of all replies received before timeout.
   * @param timeout Override timeout in ms.
   * @param expectedReplies Resolve early once this many replies arrive (poly only).
   */
  awaitReply(timeout?: number, expectedReplies?: number): Promise<unknown>;
  /**
   * Register a callback-based reply handler. Chainable with send().
   * For mono, the callback fires once. For poly, it fires for every reply until timeout.
   * @param callback Called with (data, err). err is set on timeout (mono only).
   * @param timeout Override timeout in ms.
   */
  replyAt(
    callback: (data: unknown, err?: string) => void,
    timeout?: number
  ): EmitObject;
}

export default class Snub {
  constructor(config: SnubConfig);

  /** Current status of listeners and Redis connections. */
  get status(): {
    listeners: number;
    patterns: number;
    redisPub: string;
    redisSub: string;
    redis: string;
  };

  /** Total number of registered event listeners. */
  get eventListenerCount(): number;

  /**
   * The normalised Redis key namespace, always ending in ':'.
   * Middleware that writes its own keys should build them on this.
   */
  get prefix(): string;

  /** The storage Redis connection. */
  get redis(): Redis;
  /** The publish Redis connection. */
  get pub(): Redis;
  /** The subscribe Redis connection. */
  get sub(): Redis;

  /** Access to the generateUID utility function. */
  get generateUID(): () => string;
  static generateUID(): () => string;

  /** Access to the JSON serializer (handles Map/Set). */
  get stringifyJson(): (obj: unknown) => string;
  /** Access to the JSON deserializer (handles Map/Set). */
  get parseJson(): (json: string) => unknown;

  /**
   * Register a setup plugin. The function receives the Snub instance.
   * Resolves to whatever the plugin returns, e.g. a handle with close().
   */
  use<T = void>(method: (snub: Snub) => T | Promise<T>): Promise<T>;

  /**
   * Subscribe to an event or glob pattern.
   * Optionally namespace with a dot suffix: 'event.namespace'
   */
  on(pattern: string, callback: ListenerFn): Promise<void>;

  /**
   * Subscribe to an event once — automatically unsubscribes after first delivery.
   */
  once(pattern: string, callback: ListenerFn): Promise<void>;

  /**
   * Unsubscribe from an event pattern or namespace.
   * 'event' removes all listeners for the pattern.
   * 'event.namespace' removes only that namespace's listener.
   */
  off(pattern: string): Promise<void>;

  /**
   * Emit a single-delivery message. Only one listener across all instances receives it.
   */
  mono(channel: string, data?: unknown): EmitObject;

  /**
   * Emit a broadcast message. All listeners across all instances receive it.
   */
  poly(channel: string, data?: unknown): EmitObject;

  /**
   * Gracefully shut down: clears the delay interval and quits all Redis connections.
   */
  close(): Promise<void>;

  /**
   * Cancel a scheduled delay message by job ID.
   * @param jobId The job ID returned by sendDelay().
   * @returns true if the job was found and cancelled, false if already fired or not found.
   */
  cancelDelay(jobId: string): Promise<boolean>;
}
