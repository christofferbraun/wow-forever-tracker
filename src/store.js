'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_EVENTS = 1000;

/**
 * Tiny JSON-file store. The player list is small, so a single file written
 * atomically (temp file + rename) is simpler and sturdier than a database.
 */
class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'players.json');
    this.state = { version: 1, players: [], meta: {}, events: [] };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = {
        version: 1,
        players: Array.isArray(raw.players) ? raw.players : [],
        meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
        events: Array.isArray(raw.events) ? raw.events : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a copy of an unreadable file instead of silently overwriting it.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(this.file, backup); } catch { /* ignore */ }
        console.error(`[store] Could not read ${this.file} (${err.message}); saved a copy to ${backup}`);
      }
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get meta() { return this.state.meta; }
  setMeta(patch) { Object.assign(this.state.meta, patch); this.save(); }

  list() { return this.state.players; }

  /** Guild joins/leaves for the activity feed (level-ups come from each player's levelHistory). */
  get events() { return this.state.events; }
  addEvent(event) {
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
  }
  get(id) { return this.state.players.find((p) => p.id === id) || null; }
  findBySlug(region, slug) {
    return this.state.players.find((p) => p.region === region && p.slug === slug) || null;
  }

  add(fields, { persist = true } = {}) {
    const player = {
      id: crypto.randomBytes(8).toString('hex'),
      addedAt: Date.now(),
      status: 'pending',
      statusMessage: null,
      lastCheckedAt: null,
      lastUpdatedAt: null,
      lastModified: null,
      data: null,
      media: null,
      mediaCheckedAt: null,
      levelHistory: [],
      source: 'manual',
      hidden: false,
      roster: null,
      ...fields,
    };
    this.state.players.push(player);
    if (persist) this.save();
    return player;
  }

  update(id, patch, { persist = true } = {}) {
    const p = this.get(id);
    if (!p) return null;
    Object.assign(p, patch);
    if (persist) this.save();
    return p;
  }

  remove(id, { persist = true } = {}) {
    const before = this.state.players.length;
    this.state.players = this.state.players.filter((p) => p.id !== id);
    if (this.state.players.length !== before) { if (persist) this.save(); return true; }
    return false;
  }
}

module.exports = Store;
