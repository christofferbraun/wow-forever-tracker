'use strict';

/**
 * Library books: 40 books found around the world, each handed in to the librarian in Stormwind
 * or Undercity as its own quest. So the number of books a character has handed in is how many of
 * these quest IDs appear in /profile/wow/character/{slug}/quests/completed.
 * The background refresher keeps `libraryInfo: { checkedAt, lastLogin, q: [questId] }` per player.
 * Quest IDs from WoW Forever's quest data.
 */

const BOOK_QUESTS = {
  // Level 20
  79092: "Archmage Theocritus' Research Journal", 78146: 'Goaz Scrolls',
  79091: 'Archmage Antonidas: The Unabridged Autobiography', 78148: 'Runes of the Sorcerer-Kings',
  79093: 'Rumi of Gnomeregan: The Collected Works', 78142: 'Bewitchments and Glamours',
  78147: 'Crimes Against Anatomy', 79095: "The Apothecary's Metaphysical Primer",
  78127: 'The Dalaran Digest, Vol. 23', 79096: 'Ataeric: On Arcane Curiosities',
  79094: "The Lessons of Ta'zo", 79097: 'Baxtan: On Destructive Magics',
  78143: 'Secrets of the Dreamers', 78145: 'Arcanic Systems Manual',
  78124: "Nar'thalas Almanac, Vol. 74", 78149: 'Fury of the Land',
  // Level 35
  79948: 'Defensive Magics 101', 79949: 'A Web of Lies: Debunking Myths and Legends',
  79535: 'Basilisks: Should Petrification be Feared?', 79953: "A Luddite's Guide to Caring for Your Demonic Pet",
  79951: 'Mummies: A Guide to the Unsavory Undead', 79947: 'Geomancy: The Stone-Cold Truth',
  79950: 'Demons and You', 79952: 'RwlRwlRwlRwl!',
  // Level 45
  81955: 'A Mind of Metal', 81953: 'Stonewrought Design', 81956: "Conjurer's Codex", 81947: 'Sanguine Sorcery',
  81954: 'Venomous Journeys', 81951: 'The Liminal and the Arcane', 81949: 'Legends of the Tidesages', 81952: 'Everyday Etiquette',
  // Level 60
  84396: 'Magma or Lava?', 84398: 'A Study of the Light', 84401: 'Scourge: Undead Menace or Misunderstood?',
  84400: 'The Knight and the Lady', 84402: 'Necromancy 101', 84395: 'Undead Potatoes',
  84397: 'Northern Kalimdor - A Comprehensive Guide', 84399: 'Ka-Boom!',
};

const BOOK_IDS = new Set(Object.keys(BOOK_QUESTS).map(Number));
const BOOKS = BOOK_IDS.size; // 40

/** Raw /quests/completed response -> sorted IDs of the library books handed in. */
function libraryQuests(raw) {
  const quests = Array.isArray(raw?.quests) ? raw.quests : [];
  return [...new Set(quests.map((q) => Number(q?.id)).filter((id) => BOOK_IDS.has(id)))].sort((a, b) => a - b);
}

/** Number of books from stored quest IDs (null if not checked yet). */
function bookCount(ids) {
  return Array.isArray(ids) ? ids.filter((id) => BOOK_IDS.has(id)).length : null;
}

module.exports = { BOOK_QUESTS, BOOKS, libraryQuests, bookCount };
