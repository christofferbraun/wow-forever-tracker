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

/*
 * Leveling effort model for the "level 60 by" estimate.
 *
 * Levels don't take equal time. WoW Forever uses the Classic XP table (400 XP for
 * 1→2 up to 209,800 for 59→60; 4,084,700 total), but XP also comes in faster at
 * higher levels: a same-level mob gives 45 + 5 × level XP, and quest rewards scale
 * similarly. So the time a level takes is modelled as
 *     effort(L) = XP to go from L to L+1  /  (45 + 5 × L)
 * By bracket that puts 1–10 at ~2% of the time to 60, 30–40 at ~18% and 50–60 at
 * ~34%, within a few points of community /played estimates per bracket, where raw
 * XP alone would say 1%, 16% and 44%.
 *
 * Each character's pace is measured in effort per day over their last 7 days and
 * projected over the effort they still have left, so someone doing 3 levels a day
 * at 20 is not assumed to keep doing 3 a day in their 50s.
 */
const XP_TO_NEXT = [0,
  400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600,
  8800, 10100, 11400, 12900, 14400, 16000, 17700, 19400, 21300, 23200,
  25200, 27300, 29400, 31700, 34000, 36400, 38900, 41400, 44300, 47400,
  50800, 54500, 58600, 62800, 67100, 71600, 76100, 80800, 85700, 90700,
  95800, 101000, 106300, 111800, 117500, 123200, 129100, 135100, 141200, 147500,
  153900, 160400, 167100, 173900, 180800, 187900, 195000, 202300, 209800,
];
const EFFORT = XP_TO_NEXT.map((xp, level) => (level ? xp / (45 + 5 * level) : 0));
const EFFORT_BEFORE = [0]; // EFFORT_BEFORE[L] = effort to get from level 1 to the start of level L
for (let l = 1; l <= MAX_LEVEL; l++) EFFORT_BEFORE[l] = EFFORT_BEFORE[l - 1] + (EFFORT[l - 1] || 0);

/**
 * Position on the effort scale for a character at `level`, `fraction` of the way to the next.
 * When we don't know how far into the level they are, the middle (0.5) is the unbiased guess.
 */
function effortAt(level, fraction = 0.5) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  if (l >= MAX_LEVEL) return EFFORT_BEFORE[MAX_LEVEL];
  return EFFORT_BEFORE[l] + Math.max(0, Math.min(1, fraction)) * EFFORT[l];
}

/** Fraction of the current level done, from the profile's experience field when it looks valid. */
function levelFraction(level, experience) {
  const need = XP_TO_NEXT[level];
  return need && Number.isFinite(experience) && experience >= 0 && experience < need ? experience / need : 0.5;
}

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
    slug: e.slug || null,
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

/**
 * Levels gained over the last 7 days (or since tracking began), levels/day, and an
 * estimated date to reach 60 that allows for later levels taking longer (see EFFORT).
 */
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
    // Under a day of data, rates would be wildly overstated, so leave them out.
    const perDay = days >= 1 ? gained / days : null;

    let eta = null;
    if (days >= 1 && gained > 0 && level < MAX_LEVEL) {
      // If the window starts exactly on a level-up, they were at the very start of that level.
      const startsOnDing = hist.some((h) => h.at === start && !h.initial);
      const effortThen = effortAt(base, startsOnDing ? 0 : 0.5);
      const effortNow = effortAt(level, levelFraction(level, e.data?.experience));
      const effortPerDay = (effortNow - effortThen) / days;
      if (effortPerDay > 0) eta = now + ((effortAt(MAX_LEVEL) - effortNow) / effortPerDay) * DAY;
    }
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

module.exports = { activity, pace, trend, distribution, heatmap, trackingSince, levelAt, effortAt, XP_TO_NEXT };
