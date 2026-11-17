'use strict';

/**
 * Talent tree layouts from Blizzard's static data, for drawing trees like the game:
 *   /data/wow/talent-tree/index                                   which trees exist
 *   /data/wow/talent-tree/{tree}/playable-specialization/{spec}   one spec tree: nodes with
 *        display_row/display_col, ranks (one tooltip per rank), locked_by/unlocks
 *   /data/wow/media/spell/{id}                                    talent icons
 * Static data only changes with game patches, so trees are kept for a week and icons for good.
 */

const fs = require('node:fs');
const path = require('node:path');
const { RateLimitError } = require('./blizzard');

const TREE_TTL = 7 * 24 * 3600e3;
const ICON_RETRY = 24 * 3600e3;

const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === 'string' && x.trim() ? x.replace(/\r\n/g, '\n').trim() : null);

function mapNode(node) {
  const ranks = arr(node.ranks);
  const tip = ranks[0]?.tooltip || {};
  const spell = tip.spell_tooltip || {};
  return {
    id: node.id,
    row: Number(node.display_row) || 1,
    col: Number(node.display_col) || 1,
    // Blizzard's own canvas position (600 units per cell); more reliable than row/col for some trees.
    x: Number.isFinite(node.raw_position_x) ? node.raw_position_x : null,
    y: Number.isFinite(node.raw_position_y) ? node.raw_position_y : null,
    max: ranks.length || 1,
    talentId: tip.talent?.id ?? null,
    name: str(tip.talent?.name) || str(spell.spell?.name) || '?',
    spellId: spell.spell?.id ?? null,
    ranks: ranks.map((r) => str(r.tooltip?.spell_tooltip?.description)),
    cast: str(spell.cast_time),
    cost: str(spell.power_cost),
    range: str(spell.range),
    cooldown: str(spell.cooldown),
    lockedBy: arr(node.locked_by),
    unlocks: arr(node.unlocks),
  };
}

class TalentTrees {
  constructor({ client, dataDir }) {
    this.client = client;
    this.file = path.join(dataDir, 'talent-trees.json');
    this.state = { index: {}, trees: {}, icons: {} };
    this.inflight = new Map();
    this.saveTimer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.state = { index: raw.index || {}, trees: raw.trees || {}, icons: raw.icons || {} };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[talents] Could not read ${this.file}: ${err.message}`);
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 3000);
    this.saveTimer.unref?.();
  }

  save() {
    clearTimeout(this.saveTimer);
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[talents] Could not write ${this.file}: ${err.message}`);
    }
  }

  /** One request per key at a time. */
  once(key, fn) {
    if (!this.inflight.has(key)) this.inflight.set(key, fn().finally(() => this.inflight.delete(key)));
    return this.inflight.get(key);
  }

  /** { specs: [{ treeId, specId, name }], classes: [{ treeId, name }] } for a region, in Blizzard's order. */
  async index(region) {
    const cached = this.state.index[region];
    if (cached && Date.now() - cached.fetchedAt < TREE_TTL) return cached;
    return this.once(`index:${region}`, async () => {
      const r = await this.client.request(region, '/data/wow/talent-tree/index', { namespace: 'static' });
      if (r.status !== 200) {
        if (cached) return cached;
        throw new Error(`talent tree index: HTTP ${r.status}`);
      }
      const specs = arr(r.data?.spec_talent_trees).map((t) => {
        const m = /talent-tree\/(\d+)\/playable-specialization\/(\d+)/.exec(t?.key?.href || '');
        return m ? { treeId: Number(m[1]), specId: Number(m[2]), name: str(t.name) } : null;
      }).filter(Boolean);
      const classes = arr(r.data?.class_talent_trees).map((t) => {
        const m = /talent-tree\/(\d+)/.exec(t?.key?.href || '');
        return m ? { treeId: Number(m[1]), name: str(t.name) } : null;
      }).filter(Boolean);
      this.state.index[region] = { fetchedAt: Date.now(), specs, classes };
      this.scheduleSave();
      return this.state.index[region];
    });
  }

  async tree(region, treeId, specId) {
    const key = `${region}:${specId}`;
    const cached = this.state.trees[key];
    // Entries cached before positions were kept (no "x") are refetched.
    if (cached && Date.now() - cached.fetchedAt < TREE_TTL && cached.nodes.every((n) => 'x' in n)) return cached;
    return this.once(`tree:${key}`, async () => {
      const r = await this.client.request(region, `/data/wow/talent-tree/${treeId}/playable-specialization/${specId}`, { namespace: 'static' });
      if (r.status !== 200) {
        if (cached) return cached;
        throw new Error(`talent tree ${treeId}/${specId}: HTTP ${r.status}`);
      }
      const nodes = arr(r.data?.spec_talent_nodes).map(mapNode);
      this.state.trees[key] = { fetchedAt: Date.now(), specId, name: str(r.data?.name), nodes };
      this.scheduleSave();
      return this.state.trees[key];
    });
  }

  async fillIcons(region, nodes) {
    const now = Date.now();
    const icons = this.state.icons;
    const todo = [...new Set(nodes.map((n) => n.spellId).filter((id) => {
      const c = icons[id];
      return id && (c === undefined || (typeof c === 'object' && now - c.miss > ICON_RETRY));
    }))];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++];
        try {
          const r = await this.client.request(region, `/data/wow/media/spell/${id}`, { namespace: 'static' });
          const icon = arr(r.data?.assets).find((a) => a.key === 'icon' && /^https:\/\//.test(a.value));
          icons[id] = icon ? icon.value : { miss: now };
        } catch (err) {
          if (!(err instanceof RateLimitError)) icons[id] = { miss: now };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    if (todo.length) this.scheduleSave();
  }

  /**
   * All spec trees of a character's class, in game order, with icons.
   * The class is found from the character's spec ids, or by class name if no points are spent.
   */
  async forClass(region, { specIds = [], className = null } = {}) {
    const idx = await this.index(region);
    let treeId = idx.specs.find((s) => specIds.includes(s.specId))?.treeId;
    if (!treeId && className) treeId = idx.classes.find((c) => c.name?.toLowerCase() === className.toLowerCase())?.treeId;
    if (!treeId) return null;
    const specs = idx.specs.filter((s) => s.treeId === treeId);
    // One missing tree shouldn't hide the others.
    const loaded = await Promise.all(specs.map((s) => this.tree(region, treeId, s.specId).catch((err) => {
      console.error(`[talents] ${err.message}`);
      return null;
    })));
    const trees = loaded.map((t, i) => (t ? { ...t, name: t.name || specs[i].name } : null)).filter((t) => t?.nodes.length);
    if (!trees.length) return null;
    await this.fillIcons(region, trees.flatMap((t) => t.nodes));
    const icon = (id) => (typeof this.state.icons[id] === 'string' ? this.state.icons[id] : null);
    return trees.map((t) => ({
      specId: t.specId,
      name: t.name,
      nodes: t.nodes.map((n) => ({ ...n, icon: icon(n.spellId) })),
    }));
  }
}

module.exports = TalentTrees;
