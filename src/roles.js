'use strict';

/**
 * Tank / Healer / DPS guess from talent points, plus a background job that keeps every
 * level 30+ character's talent split current (1 call each, only after they log out again).
 *
 * Each tree counts toward a role: Protection = tank; Holy, Discipline, Restoration = healer;
 * Feral = half tank, half DPS (bear or cat can't be told apart); every other tree = DPS.
 * The role with the most points wins. If the runner-up has at least half as many points
 * (and 10+), it's a hybrid, e.g. "Healer/DPS". Below level 30 there aren't enough points to tell.
 */

const { BlizzardClient, RateLimitError } = require('./blizzard');
const { mapTalents } = require('./character');

const MIN_LEVEL = 30;
const ROLE_NAMES = { tank: 'Tank', healer: 'Healer', dps: 'DPS' };

function treeRoles(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('protection')) return { tank: 1 };
  if (n.includes('holy') || n.includes('discipline') || n.includes('restoration')) return { healer: 1 };
  if (n.includes('feral')) return { tank: 0.5, dps: 0.5 };
  return { dps: 1 };
}

/** trees: [{ name, points }] -> { label, primary, secondary, split } or null */
function guessRole(trees, level) {
  if (!Array.isArray(trees) || (level ?? 0) < MIN_LEVEL) return null;
  const spent = trees.filter((t) => t && t.points > 0);
  const total = spent.reduce((s, t) => s + t.points, 0);
  if (total < 5) return null;
  const score = { tank: 0, healer: 0, dps: 0 };
  for (const t of spent) for (const [role, w] of Object.entries(treeRoles(t.name))) score[role] += t.points * w;
  const [first, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const hybrid = second[1] >= 10 && second[1] >= first[1] * 0.5;
  const split = spent.slice().sort((a, b) => b.points - a.points).map((t) => `${t.name} ${t.points}`).join(' / ');
  return {
    primary: first[0],
    secondary: hybrid ? second[0] : null,
    label: hybrid ? `${ROLE_NAMES[first[0]]}/${ROLE_NAMES[second[0]]}` : ROLE_NAMES[first[0]],
    split,
  };
}

/** The part of a talents mapping worth keeping on the player record. */
const slimTrees = (talents) => (talents?.trees || []).map((t) => ({ name: t.name, points: t.points || 0 }));

class RoleRefresher {
  constructor({ store, client, intervalMs = 2 * 60e3, batch = 25 }) {
    this.store = store;
    this.client = client;
    this.intervalMs = intervalMs;
    this.batch = batch;
    this.timer = null;
    this.running = false;
  }

  start() {
    const loop = () => { this.timer = setTimeout(async () => { await this.tick(); loop(); }, this.intervalMs); };
    this.timer = setTimeout(async () => { await this.tick(); loop(); }, 20e3);
    this.timer.unref?.();
  }

  stop() { clearTimeout(this.timer); }

  needs(p, now) {
    if (p.hidden || !p.data || (p.data.level ?? 0) < MIN_LEVEL || !p.slug) return false;
    const t = p.talentInfo;
    if (!t) return true;
    if (now - t.checkedAt < 10 * 60e3) return false; // just tried (or failed); wait a bit
    return t.lastLogin !== (p.data.lastLogin ?? null) || now - t.checkedAt > 7 * 24 * 3600e3;
  }

  /** Records talents fetched elsewhere (the character panel). Returns true if anything changed. */
  record(p, talents, persist = true) {
    const trees = slimTrees(talents);
    const prev = p.talentInfo;
    const info = { checkedAt: Date.now(), lastLogin: p.data?.lastLogin ?? null, trees };
    const changed = !prev || JSON.stringify(prev.trees) !== JSON.stringify(trees) || prev.lastLogin !== info.lastLogin;
    this.store.update(p.id, { talentInfo: info }, { persist: persist && changed });
    return changed;
  }

  async tick() {
    if (this.running || !this.client.configured) return;
    this.running = true;
    const now = Date.now();
    try {
      const todo = this.store.list().filter((p) => this.needs(p, now))
        .sort((a, b) => (a.talentInfo ? 1 : 0) - (b.talentInfo ? 1 : 0) || (b.data?.lastLogin ?? 0) - (a.data?.lastLogin ?? 0))
        .slice(0, this.batch);
      let next = 0;
      let stop = false;
      const worker = async () => {
        while (!stop && next < todo.length) {
          const p = todo[next++];
          try {
            const r = await this.client.request(p.region, `${BlizzardClient.slugPath(p.slug)}/specializations`);
            if (r.status === 200) this.record(p, mapTalents(r.data), false);
            else this.store.update(p.id, { talentInfo: { ...(p.talentInfo || { trees: null, lastLogin: null }), checkedAt: Date.now() } }, { persist: false });
          } catch (err) {
            if (err instanceof RateLimitError) stop = true;
            else console.error(`[roles] ${p.slug}: ${err.message}`);
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (todo.length) this.store.save();
    } finally {
      this.running = false;
    }
  }
}

module.exports = { guessRole, RoleRefresher, MIN_LEVEL };
