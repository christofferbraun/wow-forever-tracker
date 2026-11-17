'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const config = require('./src/config');
const Store = require('./src/store');
const { BlizzardClient, mapGuild, guildSlugFromName } = require('./src/blizzard');
const Poller = require('./src/poller');
const createAuth = require('./src/auth');
const stats = require('./src/stats');
const Visits = require('./src/visits');
const { probeCharacter } = require('./src/probe');
const { CharacterDetails, NotVisibleError } = require('./src/character');
const TalentTrees = require('./src/talents');
const { raidsFor } = require('./src/raids');
const { guessRole, RoleRefresher } = require('./src/roles');

const store = new Store(config.dataDir);
const client = new BlizzardClient(config);
const poller = new Poller({ store, client, config });
const auth = createAuth(config);
const visits = new Visits(config.dataDir);
const characters = new CharacterDetails({ client, dataDir: config.dataDir });
const talentTrees = new TalentTrees({ client, dataDir: config.dataDir });
const roles = new RoleRefresher({ store, client });
// Visitor tracking must never break a page or API response.
const track = (fn) => { try { fn(); } catch (err) { console.error(`[visits] ${err.message}`); } };
const { mergedLevel } = Poller;

const app = express();
// cloudflared connects from localhost (bare metal) or a private Docker network address;
// trust its X-Forwarded-* headers so we see the real client IP and https.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: https://*.worldofwarcraft.com https://*.blizzard.com",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

app.use(express.json({ limit: '64kb' }));

// --- helpers ------------------------------------------------------------------

const NAME_RE = /^\p{L}{2,12}$/u;
const GUILD_SLUG_RE = /^[\p{L}\p{N}-]{1,64}$/u;

function tidyName(s) {
  const t = String(s ?? '').trim();
  return t ? t.charAt(0).toLocaleUpperCase() + t.slice(1).toLocaleLowerCase() : '';
}

/** Accepts {firstName, surname} or a single "First Surname" string in firstName. */
function parseName(firstName, surname) {
  let first = String(firstName ?? '').trim();
  let last = String(surname ?? '').trim();
  if (!last && /\s/.test(first)) [first, last] = first.split(/\s+/, 2);
  if (!NAME_RE.test(first) || !NAME_RE.test(last)) {
    return { error: 'Names must be a first name and a surname, each 2-12 letters (e.g. "Anduin Wrynn").' };
  }
  first = tidyName(first);
  last = tidyName(last);
  return { first, last, slug: `${first}-${last}`.toLowerCase() };
}

function parseRegion(r) {
  const region = String(r || config.defaultRegion).toLowerCase();
  return config.regions.includes(region) ? region : null;
}

function rankName(g, rank) {
  if (rank == null) return null;
  const custom = g?.rankNames?.[rank];
  if (custom) return custom;
  return rank === 0 ? 'Guild Master' : `Rank ${rank}`;
}

function inConfiguredGuild(p, g) {
  return Boolean(g && p.roster && p.roster.guildSlug === g.slug && p.region === g.region);
}

/** Profile data with roster data filled in where the profile is missing or older. */
function mergedData(p, g) {
  const r = p.roster;
  if (!r) return p.data;
  const out = p.data ? { ...p.data } : {
    name: p.firstName, surname: p.surname, level: null, classId: null, className: null, raceId: null,
    raceName: null, faction: null, factionType: null, guild: null, ruleset: null, lastLogin: null, itemLevel: null,
  };
  out.level = mergedLevel(p.data, r);
  for (const k of ['classId', 'className', 'raceId', 'raceName', 'faction', 'factionType']) {
    if (out[k] == null && r[k] != null) out[k] = r[k];
  }
  if (inConfiguredGuild(p, g)) {
    if (!out.guild) out.guild = g.info?.name || g.name;
    if (!out.ruleset && g.info?.ruleset) out.ruleset = g.info.ruleset;
  }
  return out;
}

function levelsGained24h(p, level, now) {
  const hist = p.levelHistory || [];
  if (level == null || !hist.length) return 0;
  const cutoff = now - 24 * 60 * 60 * 1000;
  let base = null;
  for (const h of hist) { if (h.at <= cutoff) base = h.level; }
  if (base == null) base = hist[0].initial ? hist[0].level : level;
  return Math.max(0, level - base);
}

function hintFor(p, data) {
  if (p.status === 'stale') return 'Last known data';
  if (p.data) return null;
  if (p.roster) {
    if ((data?.level ?? 0) < 10) return 'Under level 10 · full details appear at 10';
    return p.status === 'not_found' ? 'Full profile appears after their next logout' : 'Loading full profile…';
  }
  if (p.status === 'not_found') return 'Not visible yet. Characters appear at level 10 after logging out.';
  if (p.status === 'error') return 'Could not load from Blizzard yet';
  return 'Waiting for first update…';
}

function publicPlayer(p, g, now = Date.now()) {
  const data = mergedData(p, g);
  const dings = (p.levelHistory || []).filter((h) => !h.initial);
  const inGuild = inConfiguredGuild(p, g);
  return {
    id: p.id,
    firstName: p.firstName,
    surname: p.surname,
    slug: p.slug,
    region: p.region,
    note: p.note || '',
    nickname: p.nickname || '',
    status: p.status,
    hint: hintFor(p, data),
    hasProfile: Boolean(p.data),
    lastCheckedAt: p.lastCheckedAt,
    lastUpdatedAt: p.lastUpdatedAt,
    data,
    avatar: p.media?.avatar || null,
    // Tank/Healer/DPS guessed from talent points (level 30+); null until known.
    role: guessRole(p.talentInfo?.trees, data?.level),
    lastDingAt: dings.length ? dings[dings.length - 1].at : null,
    levelsToday: levelsGained24h(p, data?.level ?? null, now),
    inGuild,
    rank: inGuild ? p.roster.rank : null,
    rankName: inGuild ? rankName(g, p.roster.rank) : null,
    source: p.source || 'manual',
    addedAt: p.addedAt,
  };
}

function adminPlayer(p, g) {
  return {
    ...publicPlayer(p, g),
    rawStatusMessage: p.statusMessage,
    slug: p.slug,
    hidden: Boolean(p.hidden),
    mediaCheckedAt: p.mediaCheckedAt,
  };
}

function publicGuild(g) {
  if (!g) return null;
  return {
    name: g.info?.name || g.name,
    region: g.region,
    faction: g.info?.faction || null,
    factionType: g.info?.factionType || null,
    ruleset: g.info?.ruleset || null,
    memberCount: g.memberCount ?? g.info?.memberCount ?? null,
    achievementPoints: g.info?.achievementPoints ?? null,
    created: g.info?.created ?? null,
    lastSyncAt: g.lastSyncAt || null,
    ranks: (g.ranksSeen || []).map((r) => ({ rank: r, name: rankName(g, r) })),
  };
}

function adminGuild(g = store.meta.guild) {
  if (!g) return null;
  return {
    ...publicGuild(g),
    enteredName: g.name,
    slug: g.slug,
    status: g.status || 'pending',
    statusMessage: g.statusMessage || null,
    rankNames: g.rankNames || {},
    ranksSeen: g.ranksSeen || [],
  };
}

function pollInfo() {
  return {
    lastPoll: store.meta.lastPoll || null,
    nextPollAt: poller.nextPollAt,
    polling: poller.running,
    pollIntervalSeconds: config.pollIntervalMs / 1000,
    guildProfileIntervalSeconds: config.guildProfileIntervalMs / 1000,
  };
}

/** Removes the auto-added members of guild g; manually added players stay but lose their roster info. */
function removeGuildMembers(g) {
  let removed = 0;
  for (const p of store.list().slice()) {
    if (p.region !== g.region) continue;
    if (p.source === 'guild') { store.remove(p.id, { persist: false }); removed++; }
    else if (p.roster?.guildSlug === g.slug) store.update(p.id, { roster: null }, { persist: false });
  }
  store.save();
  return removed;
}

// --- public API ---------------------------------------------------------------

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/site', (req, res) => {
  const region = store.meta.guild?.region || config.defaultRegion;
  res.set('Cache-Control', 'no-store');
  res.json({
    title: config.siteTitle, subtitle: config.siteSubtitle, regions: config.regions, defaultRegion: config.defaultRegion,
    raids: raidsFor(region), raidRegion: region, now: Date.now(),
  });
});

app.get('/api/players', (req, res) => {
  track(() => visits.ping(req, auth.isAdmin(req)));
  const now = Date.now();
  const g = store.meta.guild;
  const entries = statEntries(g);
  const paceRows = stats.pace(entries, now);
  res.set('Cache-Control', 'no-store');
  res.json({
    players: store.list().filter((p) => !p.hidden).map((p) => publicPlayer(p, g, now)),
    guild: publicGuild(g),
    // Raw events; the page folds same-day level-ups together, so send enough to fill ~8 lines.
    recentActivity: stats.activity(entries, store.events, { limit: 60 }),
    topLevelers: paceRows.filter((r) => r.gained > 0).slice(0, 5),
    guildWeek: {
      levels: paceRows.reduce((sum, r) => sum + r.gained, 0),
      levelers: paceRows.filter((r) => r.gained > 0).length,
      days: paceRows.reduce((max, r) => Math.max(max, r.windowDays), 0),
    },
    ...pollInfo(),
    serverTime: now,
  });
});

/** Visible players in the shape src/stats.js works on. */
function statEntries(g = store.meta.guild) {
  return store.list().filter((p) => !p.hidden).map((p) => ({
    id: p.id, firstName: p.firstName, surname: p.surname, nickname: p.nickname || '', slug: p.slug, region: p.region,
    data: mergedData(p, g), levelHistory: p.levelHistory || [], loginHistory: p.loginHistory || [],
  }));
}

// Character panel: gear, character sheet, talents, professions, reputation and fun stats.
// :slug is "first-surname"; add ?region= when the same name exists in two regions.
app.get('/api/characters/:slug', async (req, res) => {
  track(() => visits.ping(req, auth.isAdmin(req), 'character'));
  const slug = String(req.params.slug).toLowerCase();
  const region = parseRegion(req.query.region);
  const matches = store.list().filter((p) => !p.hidden && p.slug === slug && (!req.query.region || p.region === region));
  const p = matches.find((m) => m.region === config.defaultRegion) || matches[0];
  if (!p) return res.status(404).json({ error: 'That character is not on the roster' });
  const g = store.meta.guild;
  const player = publicPlayer(p, g);
  res.set('Cache-Control', 'no-store');
  if (!p.data) return res.status(404).json({ error: player.hint || 'No details from Blizzard yet', player });
  try {
    const keep = new Set(store.list().map((x) => x.id));
    const details = await characters.get(p, keep);
    if (details.talents && !details.stale && (p.data?.level ?? 0) >= 30) roles.record(p, details.talents);
    // The class's talent tree layouts (static data, cached); the panel falls back to a list without them.
    let talentLayout = null;
    try {
      const specIds = (details.talents?.trees || []).map((t) => t.specId).filter(Boolean);
      talentLayout = await talentTrees.forClass(p.region, { specIds, className: p.data?.className });
    } catch (err) {
      console.error(`[talents] ${p.slug}: ${err.message}`);
    }
    res.json({ player, render: p.media?.main || null, ...details, talentLayout });
  } catch (err) {
    const status = err instanceof NotVisibleError ? 404 : 502;
    if (status === 502) console.error(`[characters] ${p.slug}: ${err.message}`);
    res.status(status).json({ error: status === 404 ? err.message : 'Could not load this character from Blizzard right now. Try again in a minute.', player });
  }
});

// Activity feed, newest first. Page back with ?before=<timestamp of the last item>.
app.get('/api/activity', (req, res) => {
  if (!req.query.before) track(() => visits.ping(req, auth.isAdmin(req), 'activity'));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const before = Number(req.query.before) || Infinity;
  res.set('Cache-Control', 'no-store');
  res.json({ items: stats.activity(statEntries(), store.events, { limit, before }), serverTime: Date.now() });
});

app.get('/api/stats', (req, res) => {
  track(() => visits.ping(req, auth.isAdmin(req), 'stats'));
  const now = Date.now();
  const entries = statEntries();
  res.set('Cache-Control', 'no-store');
  res.json({
    pace: stats.pace(entries, now),
    trend: stats.trend(entries, now),
    distribution: stats.distribution(entries),
    heatmap: stats.heatmap(entries, now),
    trackingSince: stats.trackingSince(entries),
    serverTime: now,
  });
});

// --- admin API ----------------------------------------------------------------

app.post('/api/admin/login', auth.login);
app.post('/api/admin/logout', auth.logout);
app.get('/api/admin/me', (req, res) => res.json({ authenticated: auth.isAdmin(req) }));

const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/status', (req, res) => {
  res.json({
    credentialsConfigured: client.configured,
    quota: client.lastQuota,
    playerCount: store.list().length,
    ...pollInfo(),
  });
});

admin.get('/players', (req, res) => {
  const g = store.meta.guild;
  res.set('Cache-Control', 'no-store');
  res.json({ players: store.list().map((p) => adminPlayer(p, g)) });
});

function addOne(body) {
  const name = parseName(body.firstName, body.surname);
  if (name.error) return { error: name.error, status: 400 };
  const region = parseRegion(body.region);
  if (!region) return { error: 'Unknown region', status: 400 };
  const existing = store.findBySlug(region, name.slug);
  if (existing) {
    // A guild member added by hand becomes "manual": profile polled every cycle, kept if they leave.
    if (existing.source === 'guild') {
      const note = String(body.note ?? '').trim().slice(0, 80);
      store.update(existing.id, { source: 'manual', hidden: false, ...(note ? { note } : {}) });
      return { player: existing };
    }
    return { error: `${name.first} ${name.last} (${region.toUpperCase()}) is already on the list`, status: 409 };
  }
  const note = String(body.note ?? '').trim().slice(0, 80);
  return { player: store.add({ firstName: name.first, surname: name.last, slug: name.slug, region, note }) };
}

admin.post('/players', async (req, res) => {
  const r = addOne(req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  try { await poller.refreshPlayer(r.player.id, { force: true }); } catch { /* rate limited; next cycle picks it up */ }
  res.status(201).json({ player: adminPlayer(store.get(r.player.id), store.meta.guild) });
});

// Bulk add: { lines: "First Surname [region] [note...]\n..." }
admin.post('/players/bulk', (req, res) => {
  const lines = String(req.body?.lines ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  const added = [], failed = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const hasRegion = parts[2] && config.regions.includes(parts[2].toLowerCase());
    const region = hasRegion ? parts[2].toLowerCase() : config.defaultRegion;
    const r = addOne({ firstName: parts[0], surname: parts[1], region, note: parts.slice(hasRegion ? 3 : 2).join(' ') });
    if (r.error) failed.push({ line, error: r.error }); else added.push(r.player.id);
  }
  if (added.length) poller.requestRun('bulk-add');
  res.json({ added: added.length, failed });
});

const tidyNickname = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);

// Bulk nicknames: { lines: "Character name = Nickname\n..." }
// The name can be shortened (e.g. "Goramu" or "Stinklemor") as long as it matches
// exactly one tracked character. An empty nickname clears it.
admin.post('/nicknames', (req, res) => {
  const lines = String(req.body?.lines ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 1000);
  const fullName = (p) => `${p.data?.name || p.firstName} ${p.data?.surname || p.surname}`.trim().toLowerCase();
  let updated = 0;
  const failed = [];
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*[=:\t]\s*(.*)$/);
    if (!m) { failed.push({ line, error: 'Use "Character name = Nickname"' }); continue; }
    const key = m[1].trim().replace(/\s+/g, ' ').toLowerCase();
    let hits = store.list().filter((p) => fullName(p).startsWith(key));
    if (hits.length > 1) {
      const exact = hits.filter((p) => fullName(p) === key || String(p.firstName).toLowerCase() === key);
      if (exact.length === 1) hits = exact;
    }
    if (!hits.length) { failed.push({ line, error: 'No tracked character matches' }); continue; }
    if (hits.length > 1) {
      failed.push({ line, error: `Matches ${hits.length} characters (${hits.slice(0, 3).map(fullName).join(', ')}); type more of the name` });
      continue;
    }
    store.update(hits[0].id, { nickname: tidyNickname(m[2]) }, { persist: false });
    updated++;
  }
  if (updated) store.save();
  res.json({ updated, failed });
});

admin.patch('/players/:id', (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  if (req.body?.note !== undefined) patch.note = String(req.body.note).trim().slice(0, 80);
  if (req.body?.nickname !== undefined) patch.nickname = tidyNickname(req.body.nickname);
  if (req.body?.hidden !== undefined) patch.hidden = Boolean(req.body.hidden);
  if (req.body?.region !== undefined) {
    if (p.source === 'guild') return res.status(400).json({ error: "Guild members use the guild's region" });
    const region = parseRegion(req.body.region);
    if (!region) return res.status(400).json({ error: 'Unknown region' });
    if (region !== p.region) Object.assign(patch, { region, status: 'pending', data: null, media: null, lastModified: null, levelHistory: [], roster: null });
  }
  res.json({ player: adminPlayer(store.update(p.id, patch), store.meta.guild) });
});

admin.delete('/players/:id', (req, res) => {
  if (!store.remove(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

admin.post('/players/:id/refresh', async (req, res) => {
  if (!store.get(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    await poller.refreshPlayer(req.params.id, { force: true });
  } catch (err) {
    return res.status(429).json({ error: err.message });
  }
  res.json({ player: adminPlayer(store.get(req.params.id), store.meta.guild) });
});

admin.post('/refresh-all', async (req, res) => {
  const r = await poller.triggerManual();
  res.status(r.started ? 202 : 429).json(r);
});

// --- guild admin ---

admin.get('/guild', (req, res) => res.json({ guild: adminGuild() }));

admin.put('/guild', async (req, res) => {
  const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) return res.status(400).json({ error: 'Enter the guild name (up to 40 characters).' });
  const region = parseRegion(req.body?.region);
  if (!region) return res.status(400).json({ error: 'Unknown region' });
  const slug = String(req.body?.slug ?? '').trim().toLowerCase() || guildSlugFromName(name);
  if (!GUILD_SLUG_RE.test(slug)) return res.status(400).json({ error: 'The slug may only contain letters, numbers and hyphens.' });
  if (!client.configured) return res.status(400).json({ error: 'Set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET first.' });

  let found;
  try {
    found = await client.getGuild(region, slug);
  } catch (err) {
    return res.status(502).json({ error: `Couldn't reach Blizzard: ${err.message}` });
  }
  if (found.status === 404) {
    return res.status(404).json({ error: `No guild found at "${slug}" in ${region.toUpperCase()}. Check the spelling or region, or set the slug yourself.` });
  }
  if (found.status !== 200) return res.status(502).json({ error: `Blizzard API returned HTTP ${found.status}` });

  const old = store.meta.guild;
  const same = old && old.slug === slug && old.region === region;
  if (old && !same) removeGuildMembers(old);
  store.setMeta({
    guild: {
      name, slug, region,
      rankNames: same ? old.rankNames || {} : {},
      ranksSeen: same ? old.ranksSeen || [] : [],
      info: mapGuild(found.data),
      infoCheckedAt: Date.now(),
      status: 'pending',
      statusMessage: null,
      setAt: Date.now(),
    },
  });
  poller.requestRun('guild-set');
  res.json({ guild: adminGuild() });
});

admin.delete('/guild', (req, res) => {
  const g = store.meta.guild;
  if (!g) return res.status(404).json({ error: 'No guild is set' });
  const removed = removeGuildMembers(g);
  store.setMeta({ guild: null });
  res.json({ ok: true, removed });
});

admin.patch('/guild/ranks', (req, res) => {
  const g = store.meta.guild;
  if (!g) return res.status(404).json({ error: 'No guild is set' });
  const rankNames = {};
  for (const [k, v] of Object.entries(req.body?.rankNames || {})) {
    const n = Number(k);
    const label = String(v ?? '').trim().slice(0, 30);
    if (Number.isInteger(n) && n >= 0 && n <= 20 && label) rankNames[n] = label;
  }
  g.rankNames = rankNames;
  store.save();
  res.json({ guild: adminGuild() });
});

// --- visitors ---

admin.get('/visits', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(visits.summary({
    range: String(req.query.range || '7d'),
    hideMine: req.query.mine !== '1',
    tzOffset: Math.max(-900, Math.min(900, Number(req.query.tz) || 0)),
  }));
});

admin.put('/visits/labels', (req, res) => {
  const ip = String(req.body?.ip ?? '').trim();
  if (!ip || ip.length > 45) return res.status(400).json({ error: 'Missing IP' });
  visits.setLabel(ip, req.body?.label);
  res.json({ ok: true });
});

admin.delete('/visits', (req, res) => {
  visits.clear();
  res.json({ ok: true });
});

// --- API probe: raw Blizzard responses for one character ---

let probeRunning = false;
admin.post('/probe', async (req, res) => {
  const region = parseRegion(req.body?.region);
  if (!region) return res.status(400).json({ error: 'Unknown region' });
  // Accept "first-surname" or "First Surname".
  const slug = String(req.body?.slug ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[\p{L}\p{M}'’]+-[\p{L}\p{M}'’]+$/u.test(slug)) return res.status(400).json({ error: 'Enter a character as "First Surname"' });
  if (!client.configured) return res.status(503).json({ error: 'Blizzard API credentials are not configured' });
  if (probeRunning) return res.status(429).json({ error: 'A probe is already running' });
  probeRunning = true;
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await probeCharacter(client, region, slug, req.body?.mode === 'talents' ? 'talents' : 'all'));
  } catch (err) {
    res.status(502).json({ error: err.message });
  } finally {
    probeRunning = false;
  }
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- pages --------------------------------------------------------------------

const pub = path.join(__dirname, 'public');

// Cache busting: pages are served with "?v=<content hash>" on every script and
// stylesheet link, so a deploy can never mix a new page with old cached JS/CSS
// (browser or Cloudflare). Versioned assets are cached for a year; pages are
// always revalidated.
const assetVersions = new Map();
for (const file of fs.readdirSync(pub)) {
  if (/\.(js|css|svg)$/.test(file)) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(pub, file))).digest('hex').slice(0, 10);
    assetVersions.set(file, hash);
  }
}
function renderPage(file) {
  return fs.readFileSync(path.join(pub, file), 'utf8').replace(
    /(href|src)="\/([\w.-]+\.(?:js|css|svg))"/g,
    (m, attr, name) => (assetVersions.has(name) ? `${attr}="/${name}?v=${assetVersions.get(name)}"` : m),
  );
}
const pages = { index: renderPage('index.html'), admin: renderPage('admin.html') };
const sendPage = (name, status = 200) => (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.status(status).type('html').send(pages[name]);
};

app.get(['/', '/index.html'], (req, res, next) => {
  track(() => visits.pageView(req, auth.isAdmin(req)));
  next();
}, sendPage('index'));
app.get(['/admin', '/admin.html'], sendPage('admin'));
app.use(express.static(pub, {
  index: false,
  setHeaders(res) {
    res.set('Cache-Control', res.req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
}));
app.use(sendPage('index', 404));

const server = app.listen(config.port, config.host, () => {
  console.log(`WoW Forever tracker listening on http://${config.host}:${config.port} (polling every ${config.pollIntervalMs / 1000}s)`);
  poller.start();
  roles.start();
});

function shutdown() {
  poller.stop();
  roles.stop();
  visits.save();
  characters.save();
  talentTrees.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
