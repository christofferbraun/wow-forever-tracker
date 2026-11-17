'use strict';

/**
 * Admin "API probe": fetches every known character sub-endpoint (plus static item
 * data and icons for the equipped gear) and returns the raw Blizzard responses, so
 * we can see exactly what WoW: Forever exposes before building on it.
 *
 * Costs roughly 20 calls for the character, 2 per equipped item and up to ~35 for talent
 * data (~100 total). mode 'talents' fetches only the profile, talents and talent static data.
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

async function probeCharacter(client, region, slug, mode = 'all') {
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
  const charPaths = mode === 'talents' ? ['', '/specializations'] : CHARACTER_PATHS;
  reserve(charPaths.map(charKey));
  await pool(charPaths, 4, (p) => fetchOne(charKey(p), base + p, 'profile'));

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

  // Talent tree layout: what static data exists for drawing trees like the game does
  // (positions, max ranks, icons)? The character data only has names and ranks.
  const groups = results['character/specializations']?.data?.specialization_groups;
  const specs = (Array.isArray(groups) ? groups : []).flatMap((g) => (Array.isArray(g.specializations) ? g.specializations : []));
  const specIds = [...new Set(specs.map((s) => s.specialization?.id).filter(Number.isInteger))];
  const talents = specs.flatMap((s) => (Array.isArray(s.talents) ? s.talents : []));
  const talentIds = [...new Set(talents.map((t) => t.talent?.id).filter(Number.isInteger))].slice(0, 4);
  const spellIds = [...new Set(talents.map((t) => t.spell_tooltip?.spell?.id).filter(Number.isInteger))].slice(0, MAX_ITEMS);
  const classId = results['character (profile)']?.data?.character_class?.id;

  const staticPaths = [
    ['talent-tree/index', '/data/wow/talent-tree/index'],
    ['talent/index', '/data/wow/talent/index'],
    ...(Number.isInteger(classId) ? [[`playable-class/${classId}`, `/data/wow/playable-class/${classId}`]] : []),
    ...specIds.map((id) => [`playable-specialization/${id}`, `/data/wow/playable-specialization/${id}`]),
    ...talentIds.map((id) => [`talent/${id}`, `/data/wow/talent/${id}`]),
    ...spellIds.slice(0, 2).map((id) => [`spell/${id}`, `/data/wow/spell/${id}`]),
    ...spellIds.map((id) => [`spell-media/${id}`, `/data/wow/media/spell/${id}`]),
  ];
  reserve(staticPaths.map(([k]) => k));
  await pool(staticPaths, 4, ([key, p]) => fetchOne(key, p, 'static'));

  // Follow the tree index to this character's class/spec trees, if it lists any.
  // The talent index can list thousands of talents; a sample is enough to see the shape.
  const talentIndex = results['talent/index']?.data;
  if (Array.isArray(talentIndex?.talents) && talentIndex.talents.length > 25) {
    talentIndex.talents_total = talentIndex.talents.length;
    talentIndex.talents = talentIndex.talents.slice(0, 25);
  }

  // Every spec tree of the character's class (found via a spec they have points in, or the class
  // name), including trees with no points: those are drawn too.
  const index = results['talent-tree/index']?.data;
  const specTrees = Array.isArray(index?.spec_talent_trees) ? index.spec_talent_trees : [];
  const treeOf = (href) => /talent-tree\/(\d+)/.exec(href || '')?.[1];
  const className = results['character (profile)']?.data?.character_class?.name;
  const classTreeId = treeOf(specTrees.find((t) => specIds.some((id) => t?.key?.href?.includes(`playable-specialization/${id}`)))?.key?.href)
    || treeOf((Array.isArray(index?.class_talent_trees) ? index.class_talent_trees : []).find((t) => className && t?.name === className)?.key?.href);
  const treeLinks = specTrees.map((t) => t?.key?.href)
    .filter((href) => typeof href === 'string' && classTreeId && treeOf(href) === classTreeId);
  const treePaths = [...new Set(treeLinks.map((href) => { try { return new URL(href).pathname; } catch { return null; } }).filter(Boolean))].slice(0, 6);
  reserve(treePaths.map((p) => `talent-tree:${p}`));
  await pool(treePaths, 3, (p) => fetchOne(`talent-tree:${p}`, p, 'static'));
  // Trees repeat a full tooltip per rank; keep one full node as a sample and compact the rest to
  // the fields that matter for layout, so the file stays small enough to send.
  for (const p of treePaths) {
    const data = results[`talent-tree:${p}`]?.data;
    const nodes = Array.isArray(data?.spec_talent_nodes) ? data.spec_talent_nodes : null;
    if (!nodes?.length) continue;
    data.sample_node = nodes[0];
    data.spec_talent_nodes = nodes.map((n) => {
      const { ranks, ...rest } = n;
      const tip = Array.isArray(ranks) ? ranks[0]?.tooltip : null;
      return {
        ...rest,
        name: tip?.talent?.name ?? tip?.spell_tooltip?.spell?.name ?? null,
        talent_id: tip?.talent?.id ?? null,
        rank_count: Array.isArray(ranks) ? ranks.length : null,
        rank_keys: Array.isArray(ranks) && ranks[0] ? Object.keys(ranks[0]) : null,
      };
    });
  }

  return {
    probedAt: startedAt,
    mode,
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
