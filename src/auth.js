'use strict';

const crypto = require('node:crypto');

const COOKIE = 'wft_admin';
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function createAuth(config) {
  const failures = new Map(); // ip -> { count, first }

  const hmac = (value) => crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');

  function issue(res, req) {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + config.sessionTtlMs })).toString('base64url');
    const token = `${payload}.${hmac(payload)}`;
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure, // true behind cloudflared (X-Forwarded-Proto: https)
      maxAge: config.sessionTtlMs,
      path: '/',
    });
  }

  function readCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }

  function isAdmin(req) {
    const token = readCookie(req);
    if (!token) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = hmac(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof exp === 'number' && exp > Date.now();
    } catch {
      return false;
    }
  }

  function passwordMatches(input) {
    const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
    const b = crypto.createHash('sha256').update(config.adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function tooManyFailures(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.first > FAIL_WINDOW_MS) { failures.delete(ip); return false; }
    return f.count >= MAX_FAILS;
  }

  function recordFailure(ip) {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
    else f.count++;
  }

  function login(req, res) {
    const ip = req.ip;
    if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    if (!passwordMatches(req.body?.password)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Wrong password' });
    }
    failures.delete(ip);
    issue(res, req);
    res.json({ ok: true });
  }

  function logout(req, res) {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }

  /** Requires a valid session; mutating requests also need the X-Requested-With header (CSRF guard). */
  function requireAdmin(req, res, next) {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Not logged in' });
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'fetch') {
      return res.status(403).json({ error: 'Missing request header' });
    }
    next();
  }

  return { login, logout, isAdmin, requireAdmin };
}

module.exports = createAuth;
