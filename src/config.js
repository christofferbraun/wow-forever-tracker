'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

// Node >= 20.12 can load .env files natively.
if (typeof process.loadEnvFile !== 'function') {
  console.error('This app needs Node.js 20.12 or newer (Node 22 LTS recommended). You have ' + process.version);
  process.exit(1);
}
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const REGIONS = ['us', 'eu', 'kr', 'tw'];
const REGION_LOCALES = { us: 'en_US', eu: 'en_GB', kr: 'ko_KR', tw: 'zh_TW' };

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : String(v).trim();
}

const dataDir = path.resolve(ROOT, env('DATA_DIR', './data'));
fs.mkdirSync(dataDir, { recursive: true });

// Session secret: use the env var if set, otherwise generate one and keep it in the data dir.
function loadSessionSecret() {
  const fromEnv = env('SESSION_SECRET');
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

let defaultRegion = env('DEFAULT_REGION', 'us').toLowerCase();
if (!REGIONS.includes(defaultRegion)) defaultRegion = 'us';

const pollSeconds = Math.max(60, parseInt(env('POLL_INTERVAL_SECONDS', '300'), 10) || 300);

const config = {
  root: ROOT,
  host: env('HOST', '127.0.0.1'),
  trustProxy: env('TRUST_PROXY', 'loopback, uniquelocal'),
  port: parseInt(env('PORT', '3000'), 10) || 3000,
  clientId: env('BLIZZARD_CLIENT_ID'),
  clientSecret: env('BLIZZARD_CLIENT_SECRET'),
  defaultRegion,
  regions: REGIONS,
  localeFor(region) {
    return env('LOCALE') || REGION_LOCALES[region] || 'en_US';
  },
  pollIntervalMs: pollSeconds * 1000,
  // Guild members get levels from the roster every poll; their full profile (item level,
  // last login, avatar) is fetched on this slower interval.
  guildProfileIntervalMs: Math.max(pollSeconds, parseInt(env('GUILD_PROFILE_INTERVAL_SECONDS', '1800'), 10) || 1800) * 1000,
  adminPassword: env('ADMIN_PASSWORD'),
  sessionSecret: loadSessionSecret(),
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  siteTitle: env('SITE_TITLE', 'WoW Forever Roster'),
  siteSubtitle: env('SITE_SUBTITLE', 'Our adventurers in World of Warcraft: Forever'),
  dataDir,
  // Overridable for testing only.
  apiHostTemplate: env('BLIZZARD_API_HOST_TEMPLATE', 'https://{region}.api.blizzard.com'),
  oauthUrl: env('BLIZZARD_OAUTH_URL', 'https://oauth.battle.net/token'),
  // Pause between API calls inside one poll cycle (keeps us far below 100 req/s).
  requestGapMs: 100,
  // Character renders lag behind profiles; retry missing ones every 30 min, refresh found ones every 6 h.
  mediaRetryMs: 30 * 60 * 1000,
  mediaRefreshMs: 6 * 60 * 60 * 1000,
};

if (!config.adminPassword || config.adminPassword.length < 12) {
  console.error('ADMIN_PASSWORD must be set in .env and be at least 12 characters long.');
  process.exit(1);
}
if (!config.clientId || !config.clientSecret) {
  console.warn('[config] BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET are not set; polling will fail until they are.');
}

module.exports = config;
