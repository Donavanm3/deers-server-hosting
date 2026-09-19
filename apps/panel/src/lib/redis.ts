import Redis from "ioredis";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const globalForRedis = globalThis as unknown as {
  redis?: Redis;
  redisSubscriber?: Redis;
};

export const redis = globalForRedis.redis ?? new Redis(url, { maxRetriesPerRequest: null });
// A subscriber connection cannot issue normal commands, so it is kept separate.
export const redisSubscriber =
  globalForRedis.redisSubscriber ?? new Redis(url, { maxRetriesPerRequest: null });

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
  globalForRedis.redisSubscriber = redisSubscriber;
}
