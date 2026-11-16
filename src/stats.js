'use strict';

/**
 * Activity feed and guild analytics, computed on request from what the poller
 * already stores: each character's levelHistory (level + timestamp on every
 * change), loginHistory (logout timestamps) and the store's join/leave events.
 * Nothing here calls Blizzard.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_LEVEL = 60;
const PACE_WINDOW = 7 * DAY;
const HEATMAP_WINDOW = 28 * DAY;
const MAX_TREND_POINTS = 120;

/** Level at time t from a level history, or null if tracking started after t. */
function levelAt(history, t) {
  let level = null;
  for (const h of history) {
    if (h.at > t) break;
    level = h.level;
  }
  return level;
}

/** Who an entry is about, in the shape the pages need to render a name. */
function who(e) {
  const d = e.data || {};
  return {
    playerId: e.id,
    name: `${d.name || e.firstName} ${d.surname || e.surname}`.trim(),
    nickname: e.nickname || '',
    classId: d.classId ?? null,
    className: d.className ?? null,
  };
}

/**
 * entries: [{ id, firstName, surname, nickname, data, levelHistory, loginHistory, slug, region }]
 *   (visible players only, with `data` already merged with roster data)
 */
function activity(entries, events, { limit = 50, before = Infinity } = {}) {
  const out = [];
  for (const e of entries) {
    const hist = e.levelHistory || [];
    for (let i = 1; i < hist.length; i++) {
      const gained = hist[i].level - hist[i - 1].level;
      if (gained <= 0 || hist[i].at >= before) continue;
      const level = hist[i].level;
      out.push({
        type: level >= MAX_LEVEL ? 'max' : level % 10 === 0 ? 'milestone' : 'ding',
        at: hist[i].at, level, gained, ...who(e),
      });
    }
  }
  const bySlug = new Map(entries.map((e) => [`${e.region}/${e.slug}`, e]));
  for (const ev of events) {
    if (ev.at >= before) continue;
    const current = ev.type === 'join' ? bySlug.get(`${ev.region}/${ev.slug}`) : null;
    out.push({
      type: ev.type, at: ev.at, level: ev.level ?? null,
      ...(current ? who(current) : {
        playerId: null, name: `${ev.name} ${ev.surname}`.trim(), nickname: ev.nickname || '',
        classId: ev.classId ?? null, className: ev.className ?? null,
      }),
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Levels gained over the last 7 days (or since tracking began), levels/day and a naive ETA to 60. */
function pace(entries, now) {
  const rows = [];
  for (const e of entries) {
    const hist = e.levelHistory || [];
    const level = e.data?.level;
    if (level == null || !hist.length) continue;
    const start = Math.max(now - PACE_WINDOW, hist[0].at);
    const base = levelAt(hist, start) ?? hist[0].level;
    const gained = Math.max(0, level - base);
    const days = (now - start) / DAY;
    // Under a day of data, a rate would be wildly overstated, so leave it out.
    const perDay = days >= 1 ? gained / days : null;
    const eta = perDay && level < MAX_LEVEL ? now + ((MAX_LEVEL - level) / perDay) * DAY : null;
    rows.push({ ...who(e), level, gained, perDay, eta, windowDays: days });
  }
  return rows.sort((a, b) => b.gained - a.gained || b.level - a.level || a.name.localeCompare(b.name));
}

/** Average and highest level over time, rebuilt from level histories. */
function trend(entries, now) {
  const starts = entries.map((e) => e.levelHistory?.[0]?.at).filter(Boolean);
  if (!starts.length) return { points: [], bucketHours: 0 };
  const first = Math.min(...starts);
  const span = now - first;
  let bucket = span < 2 * DAY ? HOUR : span < 7 * DAY ? 6 * HOUR : DAY;
  while (span / bucket > MAX_TREND_POINTS) bucket += DAY;

  const points = [];
  const times = [];
  for (let t = first + bucket; t < now; t += bucket) times.push(t);
  times.push(now);
  for (const t of times) {
    let sum = 0, n = 0, max = 0;
    for (const e of entries) {
      const l = levelAt(e.levelHistory || [], t);
      if (l == null) continue;
      sum += l; n++; if (l > max) max = l;
    }
    if (n) points.push({ t, avg: Math.round((sum / n) * 10) / 10, max, count: n });
  }
  return { points, bucketHours: bucket / HOUR };
}

/** Current level spread in 10-level bands, with 60 on its own. */
function distribution(entries) {
  const bands = [
    { label: '1–9', min: 1, max: 9 }, { label: '10–19', min: 10, max: 19 }, { label: '20–29', min: 20, max: 29 },
    { label: '30–39', min: 30, max: 39 }, { label: '40–49', min: 40, max: 49 }, { label: '50–59', min: 50, max: 59 },
    { label: '60', min: 60, max: 60 },
  ].map((b) => ({ ...b, count: 0 }));
  for (const e of entries) {
    const l = e.data?.level;
    const b = l == null ? null : bands.find((x) => l >= x.min && l <= x.max);
    if (b) b.count++;
  }
  return bands;
}

/** Logouts in the last 28 days by UTC weekday (0 = Sunday) and hour; the page shifts them to local time. */
function heatmap(entries, now) {
  const counts = new Array(7 * 24).fill(0);
  let total = 0, earliest = null;
  for (const e of entries) {
    for (const t of e.loginHistory || []) {
      if (t < now - HEATMAP_WINDOW || t > now) continue;
      const d = new Date(t);
      counts[d.getUTCDay() * 24 + d.getUTCHours()]++;
      total++;
      if (earliest == null || t < earliest) earliest = t;
    }
  }
  return { counts, total, since: earliest };
}

function trackingSince(entries) {
  const starts = entries.map((e) => e.levelHistory?.[0]?.at).filter(Boolean);
  return starts.length ? Math.min(...starts) : null;
}

module.exports = { activity, pace, trend, distribution, heatmap, trackingSince, levelAt };
