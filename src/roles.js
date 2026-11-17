'use strict';

/**
 * Tank / Healer / DPS guess from talent points. The talent splits are kept current for every
 * level 30+ character by the background refresher (src/refresh.js).
 *
 * Each tree counts toward a role: Protection = tank; Holy, Discipline, Restoration = healer;
 * Feral = half tank, half DPS (bear or cat can't be told apart); every other tree = DPS.
 * The role with the most points wins. If the runner-up has at least half as many points
 * (and 10+), it's a hybrid, e.g. "Healer/DPS". Below level 30 there aren't enough points to tell.
 */

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

module.exports = { guessRole, MIN_LEVEL };
