'use strict';

/**
 * Minimal Battle.net API client for WoW: Forever.
 *
 * Forever is realmless: characters are addressed by "{first}-{surname}" in the
 * profile-forever-{region} namespace, e.g.
 *   GET https://us.api.blizzard.com/profile/wow/character/anduin-wrynn?namespace=profile-forever-us
 * Blizzard has not documented this namespace yet; it was found by the community
 * at launch, so it may change.
 */

class RateLimitError extends Error {}

class BlizzardClient {
  constructor(config) {
    this.config = config;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.lastQuota = null;
  }

  get configured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  async getToken(forceNew = false) {
    if (!this.configured) throw new Error('Blizzard API credentials are not configured');
    if (!forceNew && this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;

    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await fetch(this.config.oauthUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OAuth token request failed (HTTP ${res.status}) ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!json.access_token) throw new Error('OAuth response had no access_token');
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
    return this.token;
  }

  host(region) {
    return this.config.apiHostTemplate.replace('{region}', region);
  }

  async request(region, pathname, { ifModifiedSince = null, namespace = 'profile' } = {}) {
    const url = new URL(pathname, this.host(region));
    url.searchParams.set('namespace', `${namespace}-forever-${region}`);
    url.searchParams.set('locale', this.config.localeFor(region));

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken(attempt > 0);
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      this.recordQuota(res.headers);

      if (res.status === 401 && attempt === 0) continue; // token expired early: get a new one and retry once
      if (res.status === 429) throw new RateLimitError('Blizzard API rate limit hit (HTTP 429)');

      let data = null;
      if (res.status === 200) data = await res.json();
      else await res.arrayBuffer().catch(() => null); // drain
      return { status: res.status, data, headers: res.headers };
    }
    throw new Error('Blizzard API rejected our token twice (HTTP 401)');
  }

  recordQuota(headers) {
    const current = headers.get('x-plan-quota-current');
    const allotted = headers.get('x-plan-quota-allotted');
    if (current || allotted) {
      this.lastQuota = { current: Number(current) || null, allotted: Number(allotted) || null, at: Date.now() };
    }
  }

  static slugPath(slug) {
    return `/profile/wow/character/${encodeURIComponent(slug)}`;
  }

  getCharacter(region, slug, ifModifiedSince) {
    return this.request(region, BlizzardClient.slugPath(slug), { ifModifiedSince });
  }

  getCharacterMedia(region, slug) {
    return this.request(region, `${BlizzardClient.slugPath(slug)}/character-media`);
  }

  // Guilds are realmless too: /data/wow/guild/{guild-slug} in the profile namespace.
  getGuild(region, slug) {
    return this.request(region, `/data/wow/guild/${encodeURIComponent(slug)}`);
  }

  getGuildRoster(region, slug, ifModifiedSince) {
    return this.request(region, `/data/wow/guild/${encodeURIComponent(slug)}/roster`, { ifModifiedSince });
  }

  /** Game data (class / race names) from static-forever-{region}. */
  getStatic(region, pathname) {
    return this.request(region, pathname, { namespace: 'static' });
  }
}

// --- response mapping -------------------------------------------------------

function str(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    if (typeof x.name === 'string') return x.name;
    if (x.name && typeof x.name === 'object') return x.name.en_US || Object.values(x.name)[0] || null;
  }
  return null;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function mapCharacter(raw) {
  return {
    id: raw.id ?? null,
    name: typeof raw.name === 'string' ? raw.name : null,
    surname: typeof raw.surname === 'string' ? raw.surname : null,
    level: num(raw.level),
    experience: num(raw.experience),
    classId: raw.character_class?.id ?? null,
    className: str(raw.character_class),
    raceId: raw.race?.id ?? null,
    raceName: str(raw.race),
    faction: str(raw.faction),
    factionType: raw.faction?.type ?? null,
    gender: str(raw.gender),
    guild: raw.guild ? str(raw.guild) : null,
    ruleset: str(raw.ruleset),
    lastLogin: num(raw.last_login_timestamp),
    itemLevel: num(raw.average_item_level),
    equippedItemLevel: num(raw.equipped_item_level),
    achievementPoints: num(raw.achievement_points),
  };
}

function mapMedia(raw) {
  const out = {};
  for (const a of Array.isArray(raw?.assets) ? raw.assets : []) {
    if (!a || typeof a.value !== 'string' || !/^https:\/\//.test(a.value)) continue;
    if (a.key === 'avatar') out.avatar = a.value;
    else if (a.key === 'inset') out.inset = a.value;
    else if (a.key === 'main-raw') out.main = a.value;
    else if (a.key === 'main' && !out.main) out.main = a.value;
  }
  return Object.keys(out).length ? out : null;
}

function titleCase(s) {
  return typeof s === 'string' && s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : null;
}

/**
 * Roster entry -> flat object. Roster class/race objects usually carry only an id,
 * so names come from the static class/race index (`names`).
 */
function mapRosterMember(m, names = {}) {
  const c = m?.character;
  if (!c || typeof c.name !== 'string') return null;
  const surname = typeof c.surname === 'string' ? c.surname : '';
  const slug = typeof c.slug === 'string' && c.slug ? c.slug.toLowerCase() : `${c.name}-${surname}`.toLowerCase();
  const classId = c.playable_class?.id ?? null;
  const raceId = c.playable_race?.id ?? null;
  const factionType = c.faction?.type ?? null;
  return {
    name: c.name,
    surname,
    slug,
    id: c.id ?? null,
    level: num(c.level),
    classId,
    className: str(c.playable_class) || names.classes?.[classId] || null,
    raceId,
    raceName: str(c.playable_race) || names.races?.[raceId] || null,
    factionType,
    faction: str(c.faction) || titleCase(factionType),
    rank: num(m.rank),
  };
}

function mapGuild(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {
    name: typeof raw.name === 'string' ? raw.name : null,
    faction: str(raw.faction) || titleCase(raw.faction?.type),
    factionType: raw.faction?.type ?? null,
    ruleset: str(raw.ruleset),
    memberCount: num(raw.member_count),
    achievementPoints: num(raw.achievement_points),
    created: num(raw.created_timestamp),
  };
  // Drop empty fields so partial objects (e.g. the roster's "guild" stub) don't erase known values.
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/** "Legends of Azeroth" -> "legends-of-azeroth". Blizzard hasn't documented this; the admin can override it. */
function guildSlugFromName(name) {
  return String(name).trim().toLowerCase().replace(/['’`]/g, '').replace(/\s+/g, '-');
}

module.exports = {
  BlizzardClient, RateLimitError, mapCharacter, mapMedia, mapRosterMember, mapGuild, guildSlugFromName,
};
