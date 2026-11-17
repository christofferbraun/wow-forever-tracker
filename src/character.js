'use strict';

/**
 * Character panel data: gear, character sheet, talents, professions, reputations,
 * achievements and fun statistics for one character, fetched on demand.
 *
 * Blizzard only updates these when a character logs out, so a fetch is kept until
 * the poller sees a newer last login (or for MAX_AGE at most). That keeps the cost
 * to about 7 calls per character per play session, however often the panel is opened.
 * Item icons never change, so they're cached for good in item-icons.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const { BlizzardClient, RateLimitError } = require('./blizzard');

const MAX_AGE = 6 * 3600e3;        // refetch at least this often, even without a new login
const MIN_AGE = 2 * 60e3;          // never refetch one character more often than this
const ICON_RETRY = 24 * 3600e3;    // retry an item whose icon lookup failed after this long
const MAX_PARALLEL = 3;            // characters fetched at the same time

const SECTIONS = {
  equipment: '/equipment',
  statistics: '/statistics',
  specializations: '/specializations',
  professions: '/professions',
  reputations: '/reputations',
  achievements: '/achievements',
  fun: '/achievements/statistics',
};

class NotVisibleError extends Error {}

// --- mapping: keep only what the panel shows ------------------------------------

const str = (x) => (typeof x === 'string' && x ? x : null);
const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
const arr = (x) => (Array.isArray(x) ? x : []);

function hexColor(c) {
  if (!c || !Number.isFinite(c.r)) return null;
  return `#${[c.r, c.g, c.b].map((n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0')).join('')}`;
}

function mapSet(set) {
  if (!set) return null;
  const items = arr(set.items).map((i) => ({ name: str(i.item?.name), equipped: Boolean(i.is_equipped) }));
  const worn = items.filter((i) => i.equipped).length;
  return {
    name: str(set.item_set?.name),
    display: str(set.display_string),
    items,
    effects: arr(set.effects).map((f) => ({
      text: str(f.display_string),
      active: typeof f.is_active === 'boolean' ? f.is_active : worn >= (num(f.required_count) ?? Infinity),
    })).filter((f) => f.text),
  };
}

function mapItem(e) {
  const sell = e.sell_price?.display_strings;
  return {
    slot: str(e.slot?.type),
    slotName: str(e.slot?.name),
    id: num(e.item?.id),
    name: str(e.name),
    quality: str(e.quality?.type)?.toLowerCase() || 'common',
    ilvl: num(e.level?.value),
    ilvlText: str(e.level?.display_string),
    binding: str(e.binding?.name),
    unique: str(e.unique_equipped),
    type: str(e.inventory_type?.name),
    subclass: e.is_subclass_hidden ? null : str(e.item_subclass?.name),
    armor: str(e.armor?.display?.display_string),
    weapon: e.weapon ? {
      damage: str(e.weapon.damage?.display_string),
      speed: str(e.weapon.attack_speed?.display_string),
      dps: str(e.weapon.dps?.display_string),
    } : null,
    stats: arr(e.stats).map((s) => ({
      text: str(s.display?.display_string) || `+${s.value} ${s.type?.name || ''}`.trim(),
      color: hexColor(s.display?.color),
      equip: Boolean(s.is_equip_bonus),
    })),
    enchants: arr(e.enchantments).map((x) => str(x.display_string)).filter(Boolean),
    sockets: arr(e.sockets).map((s) => str(s.display_string) || str(s.item?.name) || str(s.socket_type?.name)).filter(Boolean),
    spells: arr(e.spells).map((s) => ({ text: str(s.description), color: hexColor(s.display_color) })).filter((s) => s.text),
    set: mapSet(e.set),
    durability: str(e.durability?.display_string),
    reqLevel: str(e.requirements?.level?.display_string),
    reqClasses: str(e.requirements?.playable_classes?.display_string),
    description: str(e.description),
    sell: sell ? { g: num(sell.gold) || 0, s: num(sell.silver) || 0, c: num(sell.copper) || 0 } : null,
  };
}

function mapStatistics(s) {
  if (!s) return null;
  const pair = (x) => (x && typeof x === 'object' ? { base: num(x.base), eff: num(x.effective) } : null);
  const pct = (x) => (x && typeof x === 'object' ? num(x.value) : num(x));
  return {
    health: num(s.health),
    power: num(s.power),
    powerType: str(s.power_type?.name),
    strength: pair(s.strength),
    agility: pair(s.agility),
    stamina: pair(s.stamina),
    intellect: pair(s.intellect),
    spirit: pair(s.spirit),
    armor: pair(s.armor),
    defense: pair(s.defense),
    attackPower: num(s.attack_power),
    rangedAttackPower: num(s.ranged_attack_power),
    mainHand: { min: num(s.main_hand_damage_min), max: num(s.main_hand_damage_max), speed: num(s.main_hand_speed), dps: num(s.main_hand_dps) },
    offHand: { min: num(s.off_hand_damage_min), max: num(s.off_hand_damage_max), speed: num(s.off_hand_speed), dps: num(s.off_hand_dps) },
    ranged: { min: num(s.ranged_damage_min), max: num(s.ranged_damage_max), speed: num(s.ranged_speed), dps: num(s.ranged_dps) },
    meleeCrit: pct(s.melee_crit),
    meleeHit: pct(s.melee_hit),
    rangedCrit: pct(s.ranged_crit),
    rangedHit: pct(s.ranged_hit),
    spellPower: num(s.spell_power),
    spellHealing: num(s.spell_healing),
    spellCrit: pct(s.spell_crit),
    spellHit: pct(s.spell_hit),
    spellPenetration: num(s.spell_penetration),
    manaRegen: num(s.mana_regen),
    manaRegenCombat: num(s.mana_regen_combat),
    dodge: pct(s.dodge),
    parry: pct(s.parry),
    block: pct(s.block),
    resist: {
      fire: pair(s.fire_resistance),
      frost: pair(s.frost_resistance),
      nature: pair(s.nature_resistance),
      shadow: pair(s.shadow_resistance),
      arcane: pair(s.arcane_resistance),
    },
  };
}

function mapTalents(raw) {
  const groups = arr(raw?.specialization_groups);
  const g = groups.find((x) => x.is_active) || groups[0];
  if (!g) return null;
  return {
    groups: groups.length,
    trees: arr(g.specializations).map((s) => ({
      specId: num(s.specialization?.id),
      name: str(s.specialization_name) || str(s.specialization?.name),
      points: num(s.spent_points) || 0,
      talents: arr(s.talents).map((t) => ({
        id: num(t.talent?.id),
        name: str(t.talent?.name) || str(t.spell_tooltip?.spell?.name),
        rank: num(t.talent_rank),
        desc: str(t.spell_tooltip?.description),
      })).filter((t) => t.name),
    })).filter((t) => t.name),
  };
}

function mapProfession(x) {
  const tiers = arr(x.tiers);
  const top = tiers.reduce((best, t) => ((num(t.max_skill_points) || 0) > (num(best?.max_skill_points) || 0) ? t : best), tiers[0] || x);
  return {
    name: str(x.profession?.name),
    skill: num(top?.skill_points),
    max: num(top?.max_skill_points),
    recipes: tiers.flatMap((t) => arr(t.known_recipes).map((r) => str(r.name))).filter(Boolean).sort((a, b) => a.localeCompare(b)),
  };
}

function mapProfessions(raw) {
  if (!raw) return null;
  return {
    primary: arr(raw.primaries).map(mapProfession).filter((p) => p.name),
    secondary: arr(raw.secondaries).map(mapProfession).filter((p) => p.name),
  };
}

function mapReputations(raw) {
  if (!raw) return null;
  return arr(raw.reputations).map((r) => ({
    name: str(r.faction?.name),
    standing: str(r.standing?.name),
    tier: num(r.standing?.tier),
    value: num(r.standing?.value),
    max: num(r.standing?.max),
    raw: num(r.standing?.raw),
  })).filter((r) => r.name).sort((a, b) => (b.raw ?? 0) - (a.raw ?? 0) || a.name.localeCompare(b.name));
}

function mapAchievements(raw) {
  if (!raw) return null;
  return {
    count: arr(raw.achievements).filter((a) => a.completed_timestamp).length || num(raw.total_quantity) || 0,
    points: num(raw.total_points) || 0,
    recent: arr(raw.recent_events).slice(0, 10)
      .map((e) => ({ name: str(e.achievement?.name), at: num(e.timestamp) })).filter((e) => e.name),
  };
}

/** Achievement statistics, flattened: [{ id, name, qty, desc, cat }]. */
function mapFun(raw) {
  if (!raw) return null;
  const out = [];
  const walk = (cat, parent) => {
    const name = parent ? `${parent} › ${cat.name}` : cat.name;
    for (const s of arr(cat.statistics)) {
      if (!str(s.name)) continue;
      out.push({ id: num(s.id), name: s.name, qty: num(s.quantity), desc: str(s.description), cat: name });
    }
    for (const sub of arr(cat.sub_categories)) walk(sub, cat.name);
  };
  for (const c of arr(raw.categories)) walk(c, null);
  return out;
}

// --- cache + fetching -------------------------------------------------------------

class CharacterDetails {
  constructor({ client, dataDir }) {
    this.client = client;
    this.file = path.join(dataDir, 'characters.json');
    this.iconFile = path.join(dataDir, 'item-icons.json');
    this.cache = {};               // playerId -> { slug, region, lastLogin, fetchedAt, data }
    this.icons = {};               // itemId -> icon URL, or { miss: timestamp }
    this.inflight = new Map();
    this.active = 0;
    this.queue = [];
    this.saveTimer = null;
    this.load();
  }

  load() {
    for (const [file, key] of [[this.file, 'cache'], [this.iconFile, 'icons']]) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && typeof raw === 'object') this[key] = raw;
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[characters] Could not read ${file}: ${err.message}`);
      }
    }
  }

  /** Writes both caches (debounced); drops characters that are no longer on the roster. */
  scheduleSave(keepIds) {
    if (keepIds) this.keepIds = keepIds;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 3000);
    this.saveTimer.unref?.();
  }

  save() {
    clearTimeout(this.saveTimer);
    if (this.keepIds) {
      for (const id of Object.keys(this.cache)) if (!this.keepIds.has(id)) delete this.cache[id];
    }
    for (const [file, data] of [[this.file, this.cache], [this.iconFile, this.icons]]) {
      try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
      } catch (err) {
        console.error(`[characters] Could not write ${file}: ${err.message}`);
      }
    }
  }

  isFresh(entry, player, now) {
    if (!entry || entry.slug !== player.slug || entry.region !== player.region) return false;
    if (now - entry.fetchedAt < MIN_AGE) return true;
    const lastLogin = player.data?.lastLogin ?? null;
    return entry.lastLogin === lastLogin && now - entry.fetchedAt < MAX_AGE;
  }

  /**
   * Details for a store player. Serves the cache while it's current; otherwise
   * fetches (one request per character at a time, a few characters in parallel).
   * Falls back to the cached copy (marked stale) if Blizzard fails.
   */
  async get(player, keepIds) {
    const now = Date.now();
    const cached = this.cache[player.id];
    if (this.isFresh(cached, player, now)) return { ...cached.data, fetchedAt: cached.fetchedAt };

    if (!this.inflight.has(player.id)) {
      const job = this.limit(() => this.fetch(player))
        .then((data) => {
          this.cache[player.id] = { slug: player.slug, region: player.region, lastLogin: player.data?.lastLogin ?? null, fetchedAt: Date.now(), data };
          this.scheduleSave(keepIds);
          return this.cache[player.id];
        })
        .finally(() => this.inflight.delete(player.id));
      this.inflight.set(player.id, job);
    }
    try {
      const entry = await this.inflight.get(player.id);
      return { ...entry.data, fetchedAt: entry.fetchedAt };
    } catch (err) {
      if (cached && cached.slug === player.slug && !(err instanceof NotVisibleError)) {
        return { ...cached.data, fetchedAt: cached.fetchedAt, stale: true };
      }
      throw err;
    }
  }

  async limit(fn) {
    if (this.active >= MAX_PARALLEL) await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  async fetch(player) {
    const base = BlizzardClient.slugPath(player.slug);
    const raw = {};
    const status = {};
    await Promise.all(Object.entries(SECTIONS).map(async ([key, suffix]) => {
      const r = await this.client.request(player.region, base + suffix);
      status[key] = r.status;
      raw[key] = r.status === 200 ? r.data : null;
    }));
    if (Object.values(status).every((s) => s === 404)) {
      throw new NotVisibleError('Blizzard has no details for this character yet. They show up at level 10, after logging out.');
    }
    const failed = Object.entries(status).filter(([, s]) => s !== 200 && s !== 404);
    if (failed.length === Object.keys(SECTIONS).length) throw new Error(`Blizzard API error (HTTP ${failed[0][1]})`);

    const gear = arr(raw.equipment?.equipped_items).map(mapItem).filter((i) => i.slot && i.name);
    await this.fillIcons(player.region, gear);
    return {
      gear,
      sheet: mapStatistics(raw.statistics),
      talents: mapTalents(raw.specializations),
      professions: mapProfessions(raw.professions),
      reputations: mapReputations(raw.reputations),
      achievements: mapAchievements(raw.achievements),
      fun: mapFun(raw.fun),
      missing: Object.entries(status).filter(([, s]) => s !== 200).map(([k]) => k),
    };
  }

  /** Adds `icon` to each item, looking up (and caching) icons we haven't seen. */
  async fillIcons(region, gear) {
    const now = Date.now();
    const todo = [...new Set(gear.map((i) => i.id).filter((id) => {
      const c = this.icons[id];
      return id && (c === undefined || (typeof c === 'object' && now - c.miss > ICON_RETRY));
    }))];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++];
        try {
          const r = await this.client.request(region, `/data/wow/media/item/${id}`, { namespace: 'static' });
          const icon = arr(r.data?.assets).find((a) => a.key === 'icon' && /^https:\/\//.test(a.value));
          this.icons[id] = icon ? icon.value : { miss: now };
        } catch (err) {
          if (!(err instanceof RateLimitError)) this.icons[id] = { miss: now }; // rate limited: just try next time
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    for (const item of gear) item.icon = typeof this.icons[item.id] === 'string' ? this.icons[item.id] : null;
  }
}

module.exports = { CharacterDetails, NotVisibleError };
