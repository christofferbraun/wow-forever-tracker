'use strict';

/**
 * Raid opening schedule for the "Raids open in" countdown in the page header.
 * Times are ISO 8601 in UTC, per region. Edit and redeploy when Blizzard announces changes;
 * the card hides itself 3 days after the last raid has opened.
 */
// Blizzard confirmed December 9, 2026 for all three (news posts of 2026-09-12, 2026-10-20, 2026-11-04)
// but not the hour. 23:00 UTC (3 PM PST, midnight CET) is Wowhead's "Forever Global Raid Launch" timer
// and matches the game's global launch time, so it's marked unconfirmed.
const TIME_NOTE = 'Date confirmed by Blizzard; time not announced yet (3 PM PST per Wowhead, like the launch).';
const DEC9 = '2026-12-09T23:00:00Z';
const RAIDS = [
  { name: 'The Barrow Deeps', size: 10, opens: { us: DEC9, eu: DEC9 }, note: TIME_NOTE },
  { name: 'Hyjal Summit', size: 20, opens: { us: DEC9, eu: DEC9 }, note: TIME_NOTE },
  { name: "Onyxia's Lair", size: 40, opens: { us: DEC9, eu: DEC9 }, note: TIME_NOTE },
];

/** [{ name, size, at }] for a region (falls back to the US time if a region has none). */
function raidsFor(region) {
  return RAIDS.map((r) => {
    const iso = r.opens[region] || r.opens.us;
    const at = Date.parse(iso);
    return Number.isFinite(at) ? { name: r.name, size: r.size, at, note: r.note || null } : null;
  }).filter(Boolean).sort((a, b) => a.at - b.at);
}

module.exports = { RAIDS, raidsFor };
