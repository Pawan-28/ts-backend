const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const KEY_LEN = 64;

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(String(plain), salt, KEY_LEN);
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = await scrypt(String(plain), salt, KEY_LEN);
  const a = Buffer.from(hash, "hex");
  const b = derived;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateTempPassword(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, generateTempPassword };
