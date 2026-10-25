import { createHash, randomBytes, scrypt as callbackScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(callbackScrypt);
const SESSION_COOKIE = 'bsp_session';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const PASSWORD_HASH_BYTES = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class AuthService {
  constructor(database) {
    this.db = database;
  }

  async initialize() {
    if (this.db.getPanelSetting('admin_password_hash')) return null;
    const setupToken = randomBytes(32).toString('base64url');
    this.db.setPanelSetting('setup_token_hash', await hashSecret(setupToken));
    return setupToken;
  }

  isConfigured() {
    return Boolean(this.db.getPanelSetting('admin_password_hash'));
  }

  async setup(token, password, remoteAddress) {
    if (this.isConfigured()) throw authError('Initial setup has already been completed.', 409);
    validatePassword(password);
    const storedHash = this.db.getPanelSetting('setup_token_hash');
    if (this.isLocked(remoteAddress) || !storedHash || !await verifySecret(token, storedHash)) {
      await this.recordFailure(remoteAddress);
      throw authError('The setup token is invalid.', 401);
    }
    const passwordHash = await hashSecret(password);
    if (!this.db.completeAuthSetup(storedHash, passwordHash)) {
      throw authError('Initial setup has already been completed.', 409);
    }
    this.db.clearAuthFailures(remoteAddress);
    return this.createSession();
  }

  async login(password, remoteAddress) {
    if (this.isLocked(remoteAddress)) {
      throw authError('Too many failed attempts. Wait before trying again.', 429);
    }
    const storedHash = this.db.getPanelSetting('admin_password_hash');
    if (!storedHash || !await verifySecret(password, storedHash)) {
      await this.recordFailure(remoteAddress);
      throw authError('Incorrect password.', 401);
    }
    this.db.clearAuthFailures(remoteAddress);
    return this.createSession();
  }

  isLocked(remoteAddress) {
    const lock = this.db.getAuthFailure(remoteAddress);
    return Boolean(lock?.locked_until && lock.locked_until > new Date().toISOString());
  }

  async recordFailure(remoteAddress) {
    const prior = this.db.getAuthFailure(remoteAddress);
    const attempts = (prior?.attempts ?? 0) + 1;
    const lockedUntil = attempts >= 5
      ? new Date(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts - 5, 5))).toISOString()
      : null;
    this.db.recordAuthFailure(remoteAddress, attempts, lockedUntil);
  }

  createSession() {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    this.db.pruneAuthSessions(now.toISOString());
    this.db.createAuthSession(hashToken(token), now.toISOString(), expiresAt.toISOString());
    return { token, expiresAt: expiresAt.toISOString() };
  }

  authenticate(token) {
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return false;
    return Boolean(this.db.getAuthSession(hashToken(token), new Date().toISOString()));
  }

  logout(token) {
    if (token && /^[A-Za-z0-9_-]{40,60}$/.test(token)) this.db.deleteAuthSession(hashToken(token));
  }

  cookie(session, secure) {
    return `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

export function getSessionToken(request) {
  const cookie = request.headers.cookie ?? '';
  const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return token?.slice(SESSION_COOKIE.length + 1) ?? '';
}

async function hashSecret(secret) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(secret), salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifySecret(secret, encoded) {
  if (typeof secret !== 'string' || typeof encoded !== 'string') return false;
  const [algorithm, saltText, expectedText] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltText || !expectedText) return false;
  try {
    const expected = Buffer.from(expectedText, 'base64url');
    const actual = await scrypt(secret, Buffer.from(saltText, 'base64url'), expected.length, SCRYPT_OPTIONS);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256 || password.includes('\0')) {
    throw authError('Password must be 12-256 characters.', 400);
  }
}

function authError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
