'use strict';

/**
 * Background refresh of per-character extras the roster pages need for everyone, not just
 * characters someone opened: talent splits (roles), in-game statistics (leaderboards) and
 * completed library-book quests (leaderboards).
 * Blizzard only updates these on logout, so each is fetched again only after the poller sees
 * a newer last login (or once a week). That's 1 call per kind per play session.
 */

const { BlizzardClient, RateLimitError } = require('./blizzard');
const { mapTalents, mapFun } = require('./character');
const { pickStats } = require('./leaderboards');
const { libraryQuests } = require('./library');

const slimTrees = (talents) => (talents?.trees || []).map((t) => ({ name: t.name, points: t.points || 0 }));

const KINDS = {
  // p.talentInfo = { checkedAt, lastLogin, trees: [{ name, points }] }
  talents: { field: 'talentInfo', minLevel: 30, path: '/specializations', fromRaw: (raw) => ({ trees: slimTrees(mapTalents(raw)) }) },
  // p.funStats = { checkedAt, lastLogin, s: { statId: qty } }
  fun: { field: 'funStats', minLevel: 10, path: '/achievements/statistics', fromRaw: (raw) => ({ s: pickStats(mapFun(raw)) }) },
  // p.libraryInfo = { checkedAt, lastLogin, q: [library quest ids] }
  library: { field: 'libraryInfo', minLevel: 10, path: '/quests/completed', fromRaw: (raw) => ({ q: libraryQuests(raw) }) },
};

class Refresher {
  constructor({ store, client, intervalMs = 2 * 60e3, batch = 40 }) {
    this.store = store;
    this.client = client;
    this.intervalMs = intervalMs;
    this.batch = batch;
    this.timer = null;
    this.running = false;
  }

  start() {
    const loop = () => {
      this.timer = setTimeout(async () => { await this.tick(); loop(); }, this.intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(async () => { await this.tick(); loop(); }, 20e3);
    this.timer.unref?.();
  }

  stop() { clearTimeout(this.timer); }

  needs(p, kind, now) {
    const k = KINDS[kind];
    if (p.hidden || !p.data || (p.data.level ?? 0) < k.minLevel || !p.slug) return false;
    const t = p[k.field];
    if (!t) return true;
    if (now - t.checkedAt < 10 * 60e3) return false; // just tried (or failed); wait a bit
    return t.lastLogin !== (p.data.lastLogin ?? null) || now - t.checkedAt > 7 * 24 * 3600e3;
  }

  /** Stores fresh data of one kind. Returns true if it differs from what was there. */
  record(p, kind, payload, persist = true) {
    const { field } = KINDS[kind];
    const prev = p[field];
    const info = { checkedAt: Date.now(), lastLogin: p.data?.lastLogin ?? null, ...payload };
    const strip = (o) => JSON.stringify({ ...o, checkedAt: 0 });
    const changed = !prev || strip(prev) !== strip(info);
    this.store.update(p.id, { [field]: info }, { persist: persist && changed });
    return changed;
  }

  /** From a character panel fetch (already mapped by character.js). */
  recordDetails(p, details) {
    if (details.stale) return;
    let changed = false;
    if (details.talents && (p.data?.level ?? 0) >= KINDS.talents.minLevel) changed = this.record(p, 'talents', { trees: slimTrees(details.talents) }, false) || changed;
    if (Array.isArray(details.fun)) changed = this.record(p, 'fun', { s: pickStats(details.fun) }, false) || changed;
    if (changed) this.store.save();
  }

  async tick() {
    if (this.running || !this.client.configured) return;
    this.running = true;
    const now = Date.now();
    try {
      const todo = [];
      for (const p of this.store.list()) {
        for (const kind of Object.keys(KINDS)) if (this.needs(p, kind, now)) todo.push({ p, kind });
      }
      // Never-fetched first, then whoever played most recently.
      todo.sort((a, b) => (a.p[KINDS[a.kind].field] ? 1 : 0) - (b.p[KINDS[b.kind].field] ? 1 : 0)
        || (b.p.data?.lastLogin ?? 0) - (a.p.data?.lastLogin ?? 0));
      const jobs = todo.slice(0, this.batch);
      let next = 0;
      let stop = false;
      const worker = async () => {
        while (!stop && next < jobs.length) {
          const { p, kind } = jobs[next++];
          const k = KINDS[kind];
          try {
            const r = await this.client.request(p.region, `${BlizzardClient.slugPath(p.slug)}${k.path}`);
            if (r.status === 200) this.record(p, kind, k.fromRaw(r.data), false);
            else this.store.update(p.id, { [k.field]: { ...(p[k.field] || { lastLogin: null }), checkedAt: Date.now() } }, { persist: false });
          } catch (err) {
            if (err instanceof RateLimitError) stop = true;
            else console.error(`[refresh] ${p.slug} ${kind}: ${err.message}`);
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (jobs.length) this.store.save();
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Refresher, slimTrees };
