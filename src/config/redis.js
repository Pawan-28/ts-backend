const Redis = require("ioredis");
const { logger } = require("./logger");

let redis = null;

function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    redis.on("error", (err) => logger.warn(`Redis error: ${err.message}`));
  }
  return redis;
}

async function cacheGet(key) {
  const client = getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn(`Redis cache get failed: ${err.message}`);
    return null;
  }
}

async function cacheSet(key, value, ttlSec = 300) {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), "EX", ttlSec);
  } catch (err) {
    logger.warn(`Redis cache set failed: ${err.message}`);
  }
}

module.exports = { getRedis, cacheGet, cacheSet };
