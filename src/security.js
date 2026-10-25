import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "./database.js";

const scrypt = promisify(crypto.scrypt);
const sessions = new Map();
const sessionLifetimeMs = 12 * 60 * 60 * 1000;

export function hasPassword() {
  return Boolean(db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get());
}

export async function setPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new Error("Choose a password between 12 and 1024 characters");
  }
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('password_hash', ?)").run(
    `${salt.toString("hex")}:${hash.toString("hex")}`,
  );
}

export async function authenticate(password) {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get();
  if (!setting || typeof password !== "string") return undefined;
  const [saltHex, hashHex] = setting.value.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createSession() {
  const id = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  sessions.set(id, { csrf, expires: Date.now() + sessionLifetimeMs });
  return { id, csrf };
}

export function getSession(id) {
  const session = sessions.get(id);
  if (!session || session.expires <= Date.now()) {
    if (id) sessions.delete(id);
    return undefined;
  }
  session.expires = Date.now() + sessionLifetimeMs;
  return session;
}

export function removeSession(id) {
  if (id) sessions.delete(id);
}

export function invalidateOtherSessions(keepId) {
  for (const id of sessions.keys()) {
    if (id !== keepId) sessions.delete(id);
  }
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").flatMap((cookie) => {
      const separator = cookie.indexOf("=");
      if (separator < 0) return [];
      return [[cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim()]];
    }),
  );
}
