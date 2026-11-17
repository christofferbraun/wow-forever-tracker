'use strict';

/**
 * Guild leaderboards from each character's in-game statistics
 * (/profile/wow/character/{slug}/achievements/statistics), kept per player as
 * `funStats: { checkedAt, lastLogin, s: { statId: quantity } }` by the background refresher,
 * plus library books handed in (src/library.js, from completed quests).
 */

const { BOOKS } = require('./library');

// [key, emoji, title, what it counts, stat ids summed]
const BOARDS = [
  ['deaths', '💀', 'Spirit Healer Regulars', 'Total deaths', [60]],
  ['falls', '🪂', 'Gravity Always Wins', 'Deaths from falling', [114]],
  ['wipes', '🧟', 'Wipe Magnets', 'Deaths in dungeons', [918]],
  ['ganked', '🗡️', 'Ganked', 'Killed by other players', [1501]],
  ['kills', '⚔️', 'Exterminators', 'Creatures killed', [107]],
  ['critters', '🐇', 'Critter Menace', 'Critters killed', [108]],
  ['quests', '📜', 'Errand Runners', 'Quests completed', [98]],
  ['abandoned', '🗑️', 'Commitment Issues', 'Quests abandoned', [94]],
  ['dungeons', '🏰', 'Dungeon Crawlers', 'Dungeons entered', [932]],
  ['drinks', '🍺', 'Bottomless Thirst', 'Drinks consumed', [346]],
  ['food', '🍗', 'Snack Attack', 'Food eaten', [347]],
  ['potions', '🧪', 'Potion Chuggers', 'Health & mana potions', [345, 922]],
  ['flights', '🦅', 'Frequent Flyers', 'Flight paths taken', [349]],
  ['hearth', '🏠', 'Homesick', 'Times hearthed', [353]],
  ['camped', '⛺', 'Happy Campers', 'Times camped', [64222]],
  ['fish', '🎣', "Gone Fishin'", 'Fish caught', [1518]],
  ['need', '🎲', 'Need Before Greed', 'Need rolls', [1044]],
  ['greed', '💰', 'Greedy Goblins', 'Greed rolls', [1043]],
  ['social', '👋', 'Social Butterflies', 'Cheers & waves', [1045, 1065]],
];

// Guild-wide totals shown above the boards: [label, emoji, stat ids]
const TOTALS = [
  ['Creatures slain', '⚔️', [107]],
  ['Deaths', '💀', [60]],
  ['Quests done', '📜', [98]],
  ['Dungeons run', '🏰', [932]],
  ['Flights taken', '🦅', [349]],
  ['Drinks downed', '🍺', [346]],
];

const TRACKED = [...new Set([...BOARDS.flatMap((b) => b[4]), ...TOTALS.flatMap((t) => t[2]), 60])];
const TOP = 5;

/** Flattened statistics ([{ id, qty }]) -> { id: qty } for the stats we use. */
function pickStats(list) {
  const out = {};
  for (const s of Array.isArray(list) ? list : []) {
    if (TRACKED.includes(s.id) && Number.isFinite(s.qty)) out[s.id] = s.qty;
  }
  return out;
}

const sum = (s, ids) => ids.reduce((n, id) => n + (s?.[id] || 0), 0);

/**
 * rows: [{ who: { playerId, slug, name, nickname, classId, className }, level, s, books }]
 * Characters without statistics yet are left out (counted in `coverage`). `books` is null until checked.
 */
function build(rows, total) {
  const have = rows.filter((r) => r.s && Object.keys(r.s).length);
  const boards = BOARDS.map(([key, icon, title, stat, ids]) => {
    const ranked = have.map((r) => ({ ...r.who, level: r.level, value: sum(r.s, ids) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value || (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
    return { key, icon, title, stat, top: ranked.slice(0, TOP), total: ranked.reduce((n, r) => n + r.value, 0), count: ranked.length };
  }).filter((b) => b.top.length);

  // Fewest deaths per 10 levels among level 30+: the guild's survivors.
  const careful = have.filter((r) => (r.level ?? 0) >= 30)
    .map((r) => ({ ...r.who, level: r.level, deaths: sum(r.s, [60]), value: Math.round((sum(r.s, [60]) / r.level) * 100) / 10 }))
    .sort((a, b) => a.value - b.value || b.level - a.level)
    .slice(0, TOP);
  // Library books handed in, out of 40.
  const readers = rows.filter((r) => r.books > 0)
    .map((r) => ({ ...r.who, level: r.level, value: r.books }))
    .sort((a, b) => b.value - a.value || (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
  if (readers.length) {
    boards.splice(Math.min(2, boards.length), 0, { key: 'books', icon: '📚', title: 'Bookworms', stat: `Library books handed in (of ${BOOKS})`, top: readers.slice(0, TOP), total: readers.reduce((n, r) => n + r.value, 0), count: readers.length });
  }

  if (careful.length) {
    boards.splice(1, 0, { key: 'careful', icon: '😇', title: 'Untouchables', stat: 'Fewest deaths per 10 levels (30+)', top: careful, lowerIsBetter: true, total: null, count: careful.length });
  }

  return {
    totals: TOTALS.map(([label, icon, ids]) => ({ label, icon, value: have.reduce((n, r) => n + sum(r.s, ids), 0) })),
    boards,
    coverage: { have: have.length, of: total },
  };
}

module.exports = { pickStats, build, TRACKED };
