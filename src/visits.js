'use strict';

/**
 * Cookieless visitor log for the admin page.
 *
 * Every load of the public page is recorded server-side with the visitor's IP, the
 * country Cloudflare reports, the user agent and the referring site. Nothing is stored
 * in the visitor's browser. The page then polls /api/players every 30 s while its tab
 * is visible; those polls are matched back to the latest page load from the same IP +
 * user agent to measure time on the page, to see which tabs were opened and to count
 * who is online right now.
 *
 * Kept in data/visits.json, separate from the roster, for 90 days.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEEP_MS = 90 * DAY;
const MAX_HITS = 30000;
const ONLINE_MS = 2.5 * MIN; // the page polls every 30 s while visible
const ACTIVE_GAP_MS = 90 * 1000; // a gap longer than this means the tab was hidden or closed
const ATTACH_MS = 12 * HOUR; // polls this long after a page load still count toward it
const SAVE_EVERY_MS = MIN;
const RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };

// Link previews (someone pasted the URL in a chat app) are worth seeing on their own.
const PREVIEWS = [
  [/Discordbot/i, 'Discord'], [/Slackbot|Slack-ImgProxy/i, 'Slack'], [/TelegramBot/i, 'Telegram'],
  [/WhatsApp/i, 'WhatsApp'], [/facebookexternalhit|Facebot|meta-externalagent/i, 'Facebook / iMessage'],
  [/Twitterbot/i, 'X / Twitter'], [/redditbot/i, 'Reddit'], [/SkypeUriPreview/i, 'Skype'],
  [/LinkedInBot/i, 'LinkedIn'], [/Embedly|vkShare|Iframely/i, 'Embed service'],
];
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|preview|curl|wget|python|httpclient|okhttp|go-http|axios|node-fetch|undici|headless|lighthouse|uptime|monitor|scanner|zgrab|masscan|libwww|java\/|ruby|php\//i;

function botName(ua) {
  if (!ua) return 'No user agent';
  for (const [re, name] of PREVIEWS) if (re.test(ua)) return `${name} link preview`;
  if (!BOT_RE.test(ua) && /Mozilla\/|Opera\//.test(ua)) return null;
  const m = ua.match(/([A-Za-z][\w.-]*(?:bot|crawler|spider))/i) || ua.match(/^([\w.-]+)/);
  return m ? m[1].slice(0, 40) : 'Other bot';
}

function parseUA(ua = '') {
  const os = /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /CrOS/.test(ua) ? 'ChromeOS'
          : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet'
    : /Mobi|iPhone|iPod|Android/.test(ua) ? 'Phone' : 'Desktop';
  return { os, browser, device };
}

const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '').slice(0, 45) || 'unknown';
const PRIVATE_RE = /^(::ffff:)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)|^::1$|^f[cd]/i;

/** The visitor's IP: Cloudflare's CF-Connecting-IP when the request came through cloudflared, else req.ip. */
function clientIp(req) {
  const cf = req.get('cf-connecting-ip');
  return cleanIp(cf && PRIVATE_RE.test(req.socket?.remoteAddress || '') ? cf : req.ip);
}

function referrerHost(req) {
  const ref = req.get('referer');
  if (!ref) return null;
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '');
    return host && host !== req.hostname ? host.slice(0, 80) : null;
  } catch { return null; }
}

function country(req) {
  const c = String(req.get('cf-ipcountry') || '').toUpperCase();
  return /^[A-Z][A-Z0-9]$/.test(c) && c !== 'XX' ? c : null;
}

class Visits {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'visits.json');
    // hits: { t, ip, u (index into uas), c, r, a (admin), b (bot name), dur, last, tabs }
    this.state = { version: 1, hits: [], uas: [], labels: {}, mine: [] };
    this.uaIndex = new Map();
    this.latest = new Map(); // ip|u -> most recent page-load hit
    this.online = new Map(); // ip|u -> { at, ip, u, admin }
    this.mine = new Set(); // ip|u keys seen with an admin session
    this.dirty = false;
    this.load();
    this.timer = setInterval(() => this.save(), SAVE_EVERY_MS);
    this.timer.unref();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = {
        version: 1,
        hits: Array.isArray(raw.hits) ? raw.hits : [],
        uas: Array.isArray(raw.uas) ? raw.uas : [],
        labels: raw.labels && typeof raw.labels === 'object' ? raw.labels : {},
        mine: Array.isArray(raw.mine) ? raw.mine : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[visits] Could not read ${this.file} (${err.message}); starting a new log`);
    }
    this.state.uas.forEach((ua, i) => this.uaIndex.set(ua, i));
    for (const hit of this.state.hits) if (!hit.b) this.latest.set(`${hit.ip}|${hit.u}`, hit);
    this.mine = new Set(this.state.mine);
  }

  save() {
    if (!this.dirty) return;
    const cutoff = Date.now() - KEEP_MS;
    let hits = this.state.hits.filter((h) => h.t >= cutoff);
    if (hits.length > MAX_HITS) hits = hits.slice(hits.length - MAX_HITS);
    // Drop user agents nothing refers to any more, renumbering the rest.
    const used = [...new Set(hits.map((h) => h.u))].sort((a, b) => a - b);
    const remap = new Map(used.map((old, i) => [old, i]));
    const uas = used.map((i) => this.state.uas[i]);
    for (const h of hits) h.u = remap.get(h.u);
    const remapKey = (k) => {
      const [ip, u] = k.split('|');
      return remap.has(Number(u)) ? `${ip}|${remap.get(Number(u))}` : null;
    };
    this.state = { ...this.state, hits, uas, mine: [...this.mine].map(remapKey).filter(Boolean) };
    this.uaIndex = new Map(uas.map((ua, i) => [ua, i]));
    this.mine = new Set(this.state.mine);
    this.latest = new Map();
    for (const h of hits) if (!h.b) this.latest.set(`${h.ip}|${h.u}`, h);
    const online = new Map();
    for (const [k, o] of this.online) {
      const nk = remapKey(k);
      if (nk) online.set(nk, { ...o, u: remap.get(o.u) });
    }
    this.online = online;

    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.error(`[visits] Could not save: ${err.message}`);
    }
  }

  uaId(ua) {
    const s = String(ua || '').slice(0, 400);
    let i = this.uaIndex.get(s);
    if (i === undefined) {
      i = this.state.uas.push(s) - 1;
      this.uaIndex.set(s, i);
    }
    return i;
  }

  /** A load of the public page. */
  pageView(req, isAdmin) {
    const now = Date.now();
    const ip = clientIp(req);
    const ua = req.get('user-agent') || '';
    const u = this.uaId(ua);
    const key = `${ip}|${u}`;
    const hit = { t: now, ip, u, c: country(req), r: referrerHost(req), dur: 0, last: now };
    const bot = botName(ua);
    if (bot) hit.b = bot;
    if (isAdmin) { hit.a = 1; this.mine.add(key); }
    this.state.hits.push(hit);
    if (!bot) this.latest.set(key, hit);
    this.dirty = true;
  }

  /** The page's own API calls: extend time on page, note tabs, mark online. */
  ping(req, isAdmin, tab = null) {
    const now = Date.now();
    const ip = clientIp(req);
    const ua = req.get('user-agent') || '';
    const u = this.uaIndex.get(String(ua).slice(0, 400));
    if (u === undefined) return; // never loaded the page (or a script hitting the API)
    const key = `${ip}|${u}`;
    const hit = this.latest.get(key);
    if (!hit || now - hit.t > ATTACH_MS) return;
    if (isAdmin && !this.mine.has(key)) { this.mine.add(key); this.dirty = true; }
    if (now - hit.last <= ACTIVE_GAP_MS) hit.dur += now - hit.last;
    hit.last = now;
    if (tab && !(hit.tabs || []).includes(tab)) hit.tabs = [...(hit.tabs || []), tab];
    this.online.set(key, { at: now, ip, u, since: this.online.get(key)?.at > now - ONLINE_MS ? this.online.get(key).since : now });
    this.dirty = true;
  }

  setLabel(ip, label) {
    const k = cleanIp(ip);
    const v = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (v) this.state.labels[k] = v; else delete this.state.labels[k];
    this.dirty = true;
    this.save();
  }

  clear() {
    this.state = { version: 1, hits: [], uas: [], labels: this.state.labels, mine: [] };
    this.uaIndex = new Map(); this.latest = new Map(); this.online = new Map(); this.mine = new Set();
    this.dirty = true;
    this.save();
  }

  /**
   * Aggregates for the admin page.
   * range: '24h' | '7d' | '30d' | '90d'; hideMine: skip the admin's own visits;
   * tzOffset: the browser's Date#getTimezoneOffset(), so days split at local midnight.
   */
  summary({ range = '7d', hideMine = true, tzOffset = 0, now = Date.now() } = {}) {
    const span = RANGES[range] || RANGES['7d'];
    const from = now - span;
    const offset = -Number(tzOffset || 0) * MIN; // local = utc + offset
    const dayOf = (t) => Math.floor((t + offset) / DAY);
    const isMine = (h) => h.a === 1 || this.mine.has(`${h.ip}|${h.u}`);
    const labels = this.state.labels;
    const describe = (u) => parseUA(this.state.uas[u]);

    const inRange = this.state.hits.filter((h) => h.t >= from);
    const humans = inRange.filter((h) => !h.b && !(hideMine && isMine(h)));
    const bots = inRange.filter((h) => h.b);

    // Chart buckets: hours for 24h, local days otherwise.
    const hourly = span <= DAY;
    const step = hourly ? HOUR : DAY;
    const bucketOf = hourly ? (t) => Math.floor(t / HOUR) : dayOf;
    const firstBucket = bucketOf(from + (hourly ? HOUR : 0));
    const lastBucket = bucketOf(now);
    const series = [];
    for (let b = firstBucket; b <= lastBucket; b++) series.push({ t: hourly ? b * HOUR : b * DAY - offset, views: 0, ips: new Set() });
    for (const h of humans) {
      const s = series[bucketOf(h.t) - firstBucket];
      if (s) { s.views++; s.ips.add(h.ip); }
    }

    // Per IP.
    const byIp = new Map();
    for (const h of humans) {
      let v = byIp.get(h.ip);
      if (!v) byIp.set(h.ip, v = { ip: h.ip, label: labels[h.ip] || '', views: 0, days: new Set(), first: h.t, last: h.t, time: 0, country: null, u: h.u, tabs: new Set(), mine: false });
      v.views++;
      v.days.add(dayOf(h.t));
      v.first = Math.min(v.first, h.t);
      if (h.t >= v.last) { v.last = h.t; v.u = h.u; }
      v.time += h.dur || 0;
      if (h.c) v.country = h.c;
      for (const t of h.tabs || []) v.tabs.add(t);
      if (isMine(h)) v.mine = true;
    }
    // Seen before this range started?
    const seenBefore = new Set(this.state.hits.filter((h) => h.t < from && !h.b).map((h) => h.ip));
    const visitors = [...byIp.values()].map((v) => ({
      ip: v.ip, label: v.label, views: v.views, days: v.days.size, first: v.first, last: v.last, time: v.time,
      country: v.country, ...describe(v.u), tabs: [...v.tabs], mine: v.mine, returning: v.days.size > 1 || seenBefore.has(v.ip),
    })).sort((a, b) => b.views - a.views || b.last - a.last);

    const count = (key) => {
      const m = new Map();
      for (const h of humans) {
        const k = key(h);
        if (k) m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
    };
    const durations = humans.map((h) => h.dur || 0).sort((a, b) => a - b);
    const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;

    const online = [...this.online.values()]
      .filter((o) => now - o.at <= ONLINE_MS && !(hideMine && this.mine.has(`${o.ip}|${o.u}`)))
      .map((o) => ({ ip: o.ip, label: labels[o.ip] || '', since: o.since, ...describe(o.u) }))
      .sort((a, b) => a.since - b.since);

    return {
      range, from, now, hourly, stepMs: step,
      totals: {
        views: humans.length,
        visitors: byIp.size,
        returning: visitors.filter((v) => v.returning).length,
        medianTime: median,
        totalTime: durations.reduce((s, d) => s + d, 0),
        openedActivity: humans.filter((h) => h.tabs?.includes('activity')).length,
        openedStats: humans.filter((h) => h.tabs?.includes('stats')).length,
        bots: bots.length,
        online: online.length,
      },
      online,
      series: series.map((s) => ({ t: s.t, views: s.views, visitors: s.ips.size })),
      visitors: visitors.slice(0, 100),
      recent: humans.slice(-60).reverse().map((h) => ({
        t: h.t, ip: h.ip, label: labels[h.ip] || '', country: h.c || null, referrer: h.r || null,
        dur: h.dur || 0, tabs: h.tabs || [], mine: isMine(h), ...describe(h.u),
      })),
      breakdown: {
        countries: count((h) => h.c),
        devices: count((h) => describe(h.u).device),
        os: count((h) => describe(h.u).os),
        browsers: count((h) => describe(h.u).browser),
        referrers: count((h) => h.r),
        bots: (() => {
          const m = new Map();
          for (const h of bots) m.set(h.b, (m.get(h.b) || 0) + 1);
          return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
        })(),
      },
      trackingSince: this.state.hits[0]?.t ?? null,
    };
  }
}

module.exports = Visits;
module.exports.parseUA = parseUA;
module.exports.botName = botName;
