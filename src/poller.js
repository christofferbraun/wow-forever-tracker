'use strict';

const { RateLimitError, mapCharacter, mapMedia, mapRosterMember, mapGuild } = require('./blizzard');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_HISTORY = 120;
const MAX_LOGINS = 300;                          // logout timestamps kept per character (activity heatmap)
const PROFILE_MIN_LEVEL = 10;                    // Forever profiles 404 below level 10
const GUILD_INFO_REFRESH_MS = 60 * 60 * 1000;    // guild summary (member count etc.) hourly
const STATIC_REFRESH_MS = 24 * 60 * 60 * 1000;   // class/race names daily
const MISSING_GRACE_MS = 30 * 60 * 1000;         // remove departed members after 30 min (guards against API blips)

const FALLBACK_CLASSES = {
  1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid',
};

function mergedLevel(data, roster) {
  const a = data?.level, b = roster?.level;
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b); // levels only go up; take whichever source is fresher
}

function updateHistory(history, level, now) {
  const list = Array.isArray(history) ? history.slice() : [];
  if (level == null) return list;
  const last = list[list.length - 1];
  if (!last) list.push({ level, at: now, initial: true });
  else if (last.level !== level) list.push({ level, at: now });
  return list.slice(-MAX_HISTORY);
}

/**
 * Each cycle (every POLL_INTERVAL_SECONDS):
 *  1. If a guild is configured, fetch its roster (1 request): adds new members, removes
 *     departed ones, and updates everyone's level / class / race / rank.
 *  2. Fetch full profiles for players that are due:
 *       - manually added players: every cycle
 *       - guild members level 10+: every GUILD_PROFILE_INTERVAL_SECONDS
 *
 * Community findings (Nov 2026): profiles appear at level 10 after a logout and
 * update on logout; renders (avatars) can lag by hours.
 */
class Poller {
  constructor({ store, client, config }) {
    this.store = store;
    this.client = client;
    this.config = config;
    this.running = false;
    this.rerun = false;
    this.timer = null;
    this.nextPollAt = null;
    this.lastManualAt = 0;
    this.staticNames = {};
  }

  start() {
    const schedule = (delay) => {
      this.nextPollAt = Date.now() + delay;
      this.timer = setTimeout(async () => {
        await this.runCycle('scheduled');
        schedule(this.config.pollIntervalMs);
      }, delay);
    };
    schedule(2_000);
  }

  stop() { if (this.timer) clearTimeout(this.timer); }

  /** Manual "refresh all" from the admin page; throttled to once a minute. Forces every profile. */
  async triggerManual() {
    if (this.running) return { started: false, reason: 'A refresh is already running' };
    if (Date.now() - this.lastManualAt < 60_000) return { started: false, reason: 'Please wait a minute between manual refreshes' };
    this.lastManualAt = Date.now();
    this.runCycle('manual', { force: true }); // fire and forget
    return { started: true };
  }

  /** Run soon (e.g. after the guild changes); queues behind a running cycle. */
  requestRun(reason) {
    if (this.running) { this.rerun = true; return; }
    this.runCycle(reason);
  }

  async runCycle(reason, { force = false } = {}) {
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    const startedAt = Date.now();
    const stats = { ok: 0, notFound: 0, errors: 0, checked: 0, guildMembers: null, guildError: null };
    let error = null;

    try {
      if (!this.client.configured) throw new Error('Blizzard API credentials are not configured');

      if (this.store.meta.guild) {
        try {
          stats.guildMembers = await this.syncGuild();
        } catch (err) {
          if (err instanceof RateLimitError) throw err;
          stats.guildError = err.name === 'TimeoutError' ? 'Blizzard API timed out' : err.message;
          this.store.meta.guild.status = 'error';
          this.store.meta.guild.statusMessage = stats.guildError;
        }
      }

      const now = Date.now();
      const due = this.store.list().filter((p) => this.profileDue(p, now, force)).map((p) => p.id);
      for (const id of due) {
        const result = await this.refreshPlayer(id, { persist: false });
        stats.checked++;
        if (result === 'ok') stats.ok++;
        else if (result === 'not_found') stats.notFound++;
        else if (result === 'error') stats.errors++;
        await sleep(this.config.requestGapMs);
      }
    } catch (err) {
      error = err instanceof RateLimitError ? err.message + ' — will retry next cycle' : err.message;
      console.error(`[poller] cycle aborted: ${error}`);
    } finally {
      // setMeta also persists the per-player updates made with persist:false
      this.store.setMeta({ lastPoll: { reason, startedAt, finishedAt: Date.now(), ...stats, error } });
      this.running = false;
      if (this.rerun) { this.rerun = false; setImmediate(() => this.runCycle('rerun')); }
    }
  }

  profileDue(p, now, force) {
    if (p.hidden) return false;
    if (p.source !== 'guild') return true;
    if ((mergedLevel(p.data, p.roster) ?? 0) < PROFILE_MIN_LEVEL) return false;
    if (force || !p.lastCheckedAt) return true;
    return now - p.lastCheckedAt >= this.config.guildProfileIntervalMs;
  }

  // --- guild ------------------------------------------------------------------

  async loadStaticNames(region) {
    const cached = this.staticNames[region];
    if (cached && Date.now() - cached.at < STATIC_REFRESH_MS) return cached;
    const out = { classes: { ...FALLBACK_CLASSES }, races: {}, at: Date.now() };
    try {
      const c = await this.client.getStatic(region, '/data/wow/playable-class/index');
      if (c.status === 200) for (const x of c.data?.classes || []) if (x?.id && typeof x.name === 'string') out.classes[x.id] = x.name;
      await sleep(this.config.requestGapMs);
      const r = await this.client.getStatic(region, '/data/wow/playable-race/index');
      if (r.status === 200) for (const x of r.data?.races || []) if (x?.id && typeof x.name === 'string') out.races[x.id] = x.name;
      if (c.status !== 200 || r.status !== 200) out.at = Date.now() - STATIC_REFRESH_MS + 30 * 60 * 1000; // retry in 30 min
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      out.at = Date.now() - STATIC_REFRESH_MS + 30 * 60 * 1000;
    }
    this.staticNames[region] = out;
    return out;
  }

  /** Syncs the configured guild's roster into the player list. Returns the member count. */
  async syncGuild() {
    const g = this.store.meta.guild;
    const now = Date.now();
    const names = await this.loadStaticNames(g.region);

    if (!g.info || now - (g.infoCheckedAt || 0) > GUILD_INFO_REFRESH_MS) {
      const info = await this.client.getGuild(g.region, g.slug);
      if (info.status === 200) { g.info = { ...(g.info || {}), ...mapGuild(info.data) }; g.infoCheckedAt = now; }
      await sleep(this.config.requestGapMs);
    }

    // No If-Modified-Since here: it's one request, and we don't know whether the roster's
    // Last-Modified changes when only members' levels change.
    const res = await this.client.getGuildRoster(g.region, g.slug);
    g.lastSyncAt = now;

    if (res.status === 404) {
      g.status = 'not_found';
      g.statusMessage = 'Blizzard returned "not found" for this guild. Check the name or slug.';
      this.store.save();
      return 0;
    }
    if (res.status !== 200 || !Array.isArray(res.data?.members)) {
      throw new Error(`Guild roster request returned HTTP ${res.status}`);
    }

    if (res.data.guild) g.info = { ...(g.info || {}), ...mapGuild(res.data.guild) };
    const seen = new Set();
    const ranks = new Set();

    for (const m of res.data.members) {
      const r = mapRosterMember(m, names);
      if (!r || !r.surname) continue;
      seen.add(r.slug);
      if (r.rank != null) ranks.add(r.rank);
      const roster = {
        level: r.level, classId: r.classId, className: r.className, raceId: r.raceId, raceName: r.raceName,
        faction: r.faction, factionType: r.factionType, rank: r.rank, guildSlug: g.slug, seenAt: now,
      };
      const existing = this.store.findBySlug(g.region, r.slug);
      if (existing) {
        const patch = { roster, missingSince: null };
        if (!existing.data) {
          patch.firstName = r.name;
          patch.surname = r.surname;
          if (existing.status === 'pending') patch.status = 'roster';
        }
        patch.levelHistory = updateHistory(existing.levelHistory, mergedLevel(existing.data, roster), now);
        this.store.update(existing.id, patch, { persist: false });
      } else {
        this.store.add({
          source: 'guild', firstName: r.name, surname: r.surname, slug: r.slug, region: g.region, note: '',
          status: 'roster', roster, levelHistory: updateHistory([], r.level, now),
        }, { persist: false });
        // The first sync of a guild finds everyone, so only later additions count as joins.
        if (g.rosterSyncedAt) {
          this.store.addEvent({
            type: 'join', at: now, region: g.region, slug: r.slug, name: r.name, surname: r.surname,
            classId: r.classId, className: r.className, level: r.level,
          });
        }
      }
    }

    // Members who are no longer on the roster.
    for (const p of this.store.list().slice()) {
      if (p.region !== g.region || seen.has(p.slug) || p.roster?.guildSlug !== g.slug) continue;
      if (p.source === 'guild') {
        const missingSince = p.missingSince || now;
        if (now - missingSince >= MISSING_GRACE_MS) {
          this.store.remove(p.id, { persist: false });
          this.store.addEvent({
            type: 'leave', at: missingSince, region: p.region, slug: p.slug,
            name: p.data?.name || p.firstName, surname: p.data?.surname || p.surname, nickname: p.nickname || '',
            classId: p.data?.classId ?? p.roster?.classId ?? null, className: p.data?.className ?? p.roster?.className ?? null,
            level: mergedLevel(p.data, p.roster),
          });
        }
        else this.store.update(p.id, { missingSince }, { persist: false });
      } else {
        this.store.update(p.id, { roster: null }, { persist: false }); // manually added: keep, just not in the guild any more
      }
    }

    g.status = 'ok';
    g.statusMessage = null;
    g.rosterSyncedAt = now;
    g.memberCount = res.data.members.length;
    g.ranksSeen = [...ranks].sort((a, b) => a - b);
    this.store.save();
    return g.memberCount;
  }

  // --- individual profiles ----------------------------------------------------

  /** Refreshes one player's profile. Returns 'ok' | 'not_found' | 'error'. Throws on rate limiting. */
  async refreshPlayer(id, { persist = true, force = false } = {}) {
    const p = this.store.get(id);
    if (!p) return null;
    const now = Date.now();
    const patch = { lastCheckedAt: now };
    let outcome;

    try {
      const res = await this.client.getCharacter(p.region, p.slug, force || !p.data ? null : p.lastModified);

      if (res.status === 200 && res.data) {
        const data = mapCharacter(res.data);
        Object.assign(patch, {
          status: 'ok',
          statusMessage: null,
          data,
          lastUpdatedAt: now,
          lastModified: res.headers.get('last-modified') || null,
        });
        if (data.name) patch.firstName = data.name;
        if (data.surname) patch.surname = data.surname;
        patch.levelHistory = updateHistory(p.levelHistory, mergedLevel(data, p.roster), now);
        if (data.lastLogin && data.lastLogin !== p.data?.lastLogin) {
          patch.loginHistory = [...(p.loginHistory || []), data.lastLogin].slice(-MAX_LOGINS);
        }
        outcome = 'ok';
      } else if (res.status === 304) {
        patch.status = 'ok';
        patch.statusMessage = null;
        outcome = 'ok';
      } else if (res.status === 404) {
        if (p.data) {
          patch.status = 'stale';
          patch.statusMessage = 'Blizzard returned "not found"; showing last known data';
        } else {
          patch.status = 'not_found';
          patch.statusMessage = 'Not visible yet. Characters appear at level 10 after logging out.';
        }
        outcome = 'not_found';
      } else {
        patch.status = p.data ? 'stale' : 'error';
        patch.statusMessage = `Blizzard API returned HTTP ${res.status}`;
        outcome = 'error';
      }

      if (outcome === 'ok') await this.maybeRefreshMedia(p, patch, now);
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.store.update(id, patch, { persist });
        throw err;
      }
      patch.status = p.data ? 'stale' : 'error';
      patch.statusMessage = err.name === 'TimeoutError' ? 'Blizzard API timed out' : err.message;
      outcome = 'error';
    }

    this.store.update(id, patch, { persist });
    return outcome;
  }

  async maybeRefreshMedia(p, patch, now) {
    const last = p.mediaCheckedAt || 0;
    const due = p.media?.avatar ? now - last > this.config.mediaRefreshMs : now - last > this.config.mediaRetryMs;
    if (!due) return;
    await sleep(this.config.requestGapMs);
    patch.mediaCheckedAt = now;
    try {
      const res = await this.client.getCharacterMedia(p.region, p.slug);
      if (res.status === 200) {
        const media = mapMedia(res.data);
        if (media) patch.media = media;
      }
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
    }
  }
}

Poller.mergedLevel = mergedLevel;
module.exports = Poller;
