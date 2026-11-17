'use strict';

/**
 * Admin "API probe": fetches every known character sub-endpoint (plus static item
 * data and icons for the equipped gear) and returns the raw Blizzard responses, so
 * we can see exactly what WoW: Forever exposes before building on it.
 *
 * Costs roughly 20 calls for the character plus 2 per equipped item (~60 total).
 */

const { BlizzardClient, RateLimitError } = require('./blizzard');

// Standard WoW profile API sub-resources. Some may 404 on Forever; that's what we want to learn.
const CHARACTER_PATHS = [
  '',
  '/status',
  '/equipment',
  '/statistics',
  '/specializations',
  '/professions',
  '/character-media',
  '/appearance',
  '/reputations',
  '/titles',
  '/achievements',
  '/achievements/statistics',
  '/quests',
  '/quests/completed',
  '/pvp-summary',
  '/encounters',
  '/encounters/dungeons',
  '/encounters/raids',
  '/collections',
  '/collections/mounts',
  '/collections/pets',
  '/hunter-pets',
  '/mythic-keystone-profile',
];

const MAX_ITEMS = 24;

/** Run fn over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function probeCharacter(client, region, slug) {
  const startedAt = Date.now();
  const results = {};
  let calls = 0;
  let rateLimited = false;

  const fetchOne = async (key, pathname, namespace) => {
    if (rateLimited) { results[key] = { path: pathname, namespace, status: 'skipped (rate limited)' }; return null; }
    const t = Date.now();
    calls++;
    try {
      const r = await client.request(region, pathname, { namespace });
      results[key] = { path: pathname, namespace: `${namespace}-forever-${region}`, status: r.status, ms: Date.now() - t, data: r.data };
      return r.data;
    } catch (err) {
      if (err instanceof RateLimitError) rateLimited = true;
      results[key] = { path: pathname, namespace: `${namespace}-forever-${region}`, status: 'error', ms: Date.now() - t, error: err.message };
      return null;
    }
  };

  // Reserve keys up front so the output is in a stable order, not completion order.
  const reserve = (keys) => { for (const k of keys) results[k] = null; };

  const base = BlizzardClient.slugPath(slug);
  const charKey = (p) => `character${p || ' (profile)'}`;
  reserve(CHARACTER_PATHS.map(charKey));
  await pool(CHARACTER_PATHS, 4, (p) => fetchOne(charKey(p), base + p, 'profile'));

  // Static item data + icon for each equipped item, and any item sets they belong to.
  const equipped = results['character/equipment']?.data?.equipped_items;
  const itemIds = [...new Set((Array.isArray(equipped) ? equipped : [])
    .map((e) => e?.item?.id).filter((id) => Number.isInteger(id)))].slice(0, MAX_ITEMS);
  const setIds = [...new Set((Array.isArray(equipped) ? equipped : [])
    .map((e) => e?.set?.item_set?.id).filter((id) => Number.isInteger(id)))];

  reserve(itemIds.flatMap((id) => [`item/${id}`, `item-media/${id}`]));
  reserve(setIds.map((id) => `item-set/${id}`));
  await pool(itemIds, 4, async (id) => {
    await fetchOne(`item/${id}`, `/data/wow/item/${id}`, 'static');
    await fetchOne(`item-media/${id}`, `/data/wow/media/item/${id}`, 'static');
  });
  await pool(setIds, 4, (id) => fetchOne(`item-set/${id}`, `/data/wow/item-set/${id}`, 'static'));

  return {
    probedAt: startedAt,
    region,
    slug,
    tookMs: Date.now() - startedAt,
    calls,
    rateLimited,
    quota: client.lastQuota,
    summary: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.status])),
    results,
  };
}

module.exports = { probeCharacter, CHARACTER_PATHS };
