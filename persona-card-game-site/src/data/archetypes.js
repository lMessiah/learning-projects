/**
 * Deck archetypes.
 *
 * A deck is not a hand-built list. It is a **flavour** (P3 / P4 / P5, which
 * decides the card pool and the theme) plus an **archetype** (which decides
 * how that pool is weighted when the 30 slots are filled). Four archetypes
 * across three flavours is twelve decks with no twelve lists to maintain: add
 * a card to cards.json with an `affinity` block and it enters circulation.
 *
 * Generation is deterministic. It takes the match's seeded RNG and hands back
 * the advanced one, exactly like everything else in the engine, so both sides
 * of an online match build identical decks from the same seed.
 */
import {
  PERSONAS,
  ITEMS,
  SPECIALS,
  DECKS,
  META,
  FUSION_RECIPES,
  getCard,
  getDeck,
  validateDatabase,
} from './cards.js';
import { CONFIG } from '../engine/config.js';
import { createRng, nextFloat } from '../engine/rng.js';

export const ARCHETYPES = Object.freeze([
  {
    id: 'aggressive',
    name: 'Aggressive',
    icon: '⚔️',
    blurb: 'Attack skills, damage Specials and cheap offence. Bank knockouts before they set up.',
  },
  {
    id: 'defensive',
    name: 'Defensive',
    icon: '🛡️',
    blurb: 'Healing, Guard and Rakukaja behind high-Endurance walls. Outlast them.',
  },
  {
    id: 'tactical',
    name: 'Tactical',
    icon: '🎴',
    blurb: 'Buffs, debuffs, ailments and utility. Make every enemy turn worse than the last.',
  },
  {
    id: 'swift',
    name: 'Swift',
    icon: '💨',
    blurb: 'Low-cost skills, low-level Personas and extra draws. Act more often than they do.',
  },
]);

export const ARCHETYPE_IDS = Object.freeze(ARCHETYPES.map((a) => a.id));

export function getArchetype(id) {
  return ARCHETYPES.find((a) => a.id === id) || null;
}

/* ------------------------------------------------------------------ *
 * Deck shape
 * ------------------------------------------------------------------ */

/**
 * How the 30 slots are split. Deliberately identical for every archetype: the
 * archetype changes WHICH cards fill the slots, not how many of each type, so
 * no archetype can win by simply running more Personas than the others.
 */
export const DECK_SHAPE = Object.freeze({ persona: 16, item: 8, special: 6 });
export const DECK_SIZE = Object.freeze(Object.values(DECK_SHAPE).reduce((a, b) => a + b, 0));
export const MAX_COPIES = 2;

/** How hard an affinity point pulls. 0 would make archetypes meaningless; a
 *  huge value would make every deck of an archetype identical. */
const AFFINITY_WEIGHT = 1.6;
const BASE_WEIGHT = 1;

const affinityOf = (card, archetype) => (archetype ? card.affinity?.[archetype] ?? 0 : 0);

/** Shared per-deck limits, keyed by a card's `deckGroup`. */
export const DECK_GROUP_CAPS = Object.freeze({ ...(META.deckGroupCaps ?? {}) });

/**
 * How hard a flavour's own lean pulls, on top of the archetype the player
 * chose. Smaller than AFFINITY_WEIGHT on purpose: it colours a deck, it does
 * not overrule the play style you asked for.
 */
const FLAVOUR_LEAN_WEIGHT = 0.9;
/** Exclusives are a flavour's identity, so they show up more often than not. */
const EXCLUSIVE_WEIGHT = 2.5;

const leanOf = (flavour) => DECKS.find((d) => d.id === flavour)?.flavourLean ?? null;

function weightOf(card, archetype, flavour) {
  let weight = BASE_WEIGHT + AFFINITY_WEIGHT * affinityOf(card, archetype);
  const lean = leanOf(flavour);
  if (lean && lean !== archetype) weight += FLAVOUR_LEAN_WEIGHT * affinityOf(card, lean);
  if (card.exclusive) weight += EXCLUSIVE_WEIGHT;
  return weight;
}

/**
 * Every card a flavour may draw on: its own plus everything marked `common`,
 * minus anything another game holds exclusively.
 */
export function poolFor(flavour) {
  const mine = (card) => !card.exclusive || card.exclusive === flavour;
  const personas = PERSONAS.filter(
    (p) =>
      !p.fusionOnly &&
      p.level <= CONFIG.DECK_MAX_PERSONA_LEVEL &&
      (p.game === flavour || p.game === 'common') &&
      mine(p)
  );
  return { persona: personas, item: ITEMS.filter(mine), special: SPECIALS.filter(mine) };
}

/** The cards only this flavour can play. Used by the gallery and the tests. */
export function exclusivesFor(flavour) {
  return [...ITEMS, ...SPECIALS, ...PERSONAS].filter((c) => c.exclusive === flavour);
}

/** Weighted pick without replacement, through the seeded RNG. */
function pickWeighted(cards, weights, rng) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  const [roll, next] = nextFloat(rng);
  let cursor = roll * total;
  for (let i = 0; i < cards.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) return [cards[i], next];
  }
  return [cards[cards.length - 1], next];
}

function fillSlots(cards, count, archetype, rng, groups = new Map(), flavour = null) {
  const copies = new Map();
  const out = [];
  let state = rng;

  const atCap = (card) => {
    if ((copies.get(card.id) ?? 0) >= MAX_COPIES) return true;
    // Shared caps: SP-restore items are limited between them, not each, so a
    // deck cannot paper over the SP economy by running both.
    const cap = card.deckGroup ? DECK_GROUP_CAPS[card.deckGroup] : undefined;
    return cap !== undefined && (groups.get(card.deckGroup) ?? 0) >= cap;
  };

  for (let i = 0; i < count; i++) {
    const available = cards.filter((card) => !atCap(card));
    if (!available.length) break; // pool too small; the caller validates the size
    const weights = available.map((card) => weightOf(card, archetype, flavour));
    const [picked, next] = pickWeighted(available, weights, state);
    state = next;
    copies.set(picked.id, (copies.get(picked.id) ?? 0) + 1);
    if (picked.deckGroup) groups.set(picked.deckGroup, (groups.get(picked.deckGroup) ?? 0) + 1);
    out.push(picked.id);
  }

  return [out, state];
}

/* ------------------------------------------------------------------ *
 * Fusion material guarantee
 * ------------------------------------------------------------------ */

/**
 * Levels a pair of Personas can be expected to have gained by the mid-game.
 * A recipe counts as reachable if the printed levels plus this clear its
 * combined-level bar — otherwise "your deck can make Titania" would be true on
 * paper and false in every actual match.
 */
export const FUSION_GROWTH_ALLOWANCE = 8;

/** Every recipe a given multiset of Persona cards could realistically complete. */
export function completableRecipes(cardIds) {
  const personas = cardIds.map(getCard).filter((c) => c.type === 'persona');
  const byArcana = new Map();
  for (const card of personas) {
    if (!byArcana.has(card.arcana)) byArcana.set(card.arcana, []);
    byArcana.get(card.arcana).push(card);
  }
  for (const list of byArcana.values()) list.sort((a, b) => b.level - a.level);

  return FUSION_RECIPES.filter((recipe) => {
    const [first, second] = recipe.arcana;
    const a = byArcana.get(first) ?? [];
    const b = byArcana.get(second) ?? [];
    // Same-arcana recipes need two distinct bodies from one pile.
    const pair = first === second ? [a[0], a[1]] : [a[0], b[0]];
    if (!pair[0] || !pair[1]) return false;
    return pair[0].level + pair[1].level + FUSION_GROWTH_ALLOWANCE >= recipe.minCombinedLevel;
  });
}

/** How many completable recipes a deck must contain before it is dealt. */
export const MIN_COMPLETABLE_RECIPES = 2;

/**
 * Make sure a generated deck can actually fuse.
 *
 * Archetype weighting is free to ignore whole Arcana — a Swift deck has no
 * reason to want a level 19 Priestess — and the result was decks that could
 * never complete a single recipe. This swaps the deck's most redundant Persona
 * slots for the missing pieces, cheapest recipe first, until the deck can
 * complete MIN_COMPLETABLE_RECIPES of them. It only ever touches Persona slots,
 * so the 16/8/6 shape and the copy limits survive.
 */
function repairFusionMaterial(cards, flavour, archetype) {
  const pool = poolFor(flavour).persona;
  const recipes = [...FUSION_RECIPES].sort((a, b) => a.minCombinedLevel - b.minCombinedLevel);

  for (const recipe of recipes) {
    if (completableRecipes(cards).length >= MIN_COMPLETABLE_RECIPES) break;

    // The best available body of each required Arcana, if the pool has one.
    const wanted = [];
    const used = new Set();
    for (const arcana of recipe.arcana) {
      const candidate = pool
        .filter((c) => c.arcana === arcana && !used.has(c.id))
        .sort((a, b) => b.level - a.level)[0];
      if (!candidate) break;
      used.add(candidate.id);
      wanted.push(candidate);
    }
    if (wanted.length !== recipe.arcana.length) continue; // this flavour simply cannot

    for (const card of wanted) {
      const counts = new Map();
      for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
      if ((counts.get(card.id) ?? 0) >= MAX_COPIES) continue;

      // Evict the most redundant Persona: the one we hold most copies of, then
      // the one this archetype cares least about, then the highest level (the
      // clunkiest to actually play).
      let evictIndex = -1;
      let evictScore = -Infinity;
      for (const [index, id] of cards.entries()) {
        const held = getCard(id);
        if (held.type !== 'persona') continue;
        if (wanted.some((w) => w.id === id)) continue;
        const score = (counts.get(id) ?? 1) * 10 - affinityOf(held, archetype) * 3 + held.level / 10;
        if (score > evictScore) {
          evictScore = score;
          evictIndex = index;
        }
      }
      if (evictIndex === -1) break;
      cards[evictIndex] = card.id;
    }
  }

  return cards;
}

/**
 * Cards a flavour must always be dealt, whatever the archetype weighting wants.
 *
 * Only one thing qualifies so far: the affinity-rewrite Special. It is the
 * counter both to a memorised card database and to the Brutal bot reading that
 * database, and a counter you hold roughly a third of the time is not a counter
 * — it is a lucky break. Everything else stays at the mercy of the weighting,
 * which is the point of the weighting.
 */
function signatureCardsFor(flavour) {
  return SPECIALS.filter((card) => card.exclusive === flavour && card.effect.kind === 'rewriteAffinities');
}

/**
 * Make sure the flavour's signature cards are actually in the deck, swapping
 * out the most redundant Special slot for each one that is missing.
 *
 * Only ever touches Special slots, so the 16/8/6 shape survives; the evicted
 * card is the one we hold most copies of and the archetype cares least about.
 */
function guaranteeSignatureCards(cards, flavour, archetype) {
  for (const wanted of signatureCardsFor(flavour)) {
    if (cards.includes(wanted.id)) continue;

    const counts = new Map();
    for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);

    let evictIndex = -1;
    let evictScore = -Infinity;
    for (const [index, id] of cards.entries()) {
      const held = getCard(id);
      if (held.type !== 'special') continue;
      if (signatureCardsFor(flavour).some((c) => c.id === id)) continue;
      const score = (counts.get(id) ?? 1) * 10 - affinityOf(held, archetype) * 3;
      if (score > evictScore) {
        evictScore = score;
        evictIndex = index;
      }
    }
    if (evictIndex === -1) break; // no Special slot to give up; leave it alone
    cards[evictIndex] = wanted.id;
  }
  return cards;
}

/**
 * Build one 30-card deck.
 *
 * @param flavour   'p3' | 'p4' | 'p5' — decides the pool
 * @param archetype one of ARCHETYPE_IDS, or null for an unweighted pool draw
 * @param rng       seeded RNG state
 * @returns {[string[], object]} the card ids and the advanced RNG
 */
export function buildDeck({ flavour, archetype = null, rng }) {
  if (archetype && !ARCHETYPE_IDS.includes(archetype)) {
    throw new Error(`Unknown deck archetype "${archetype}"`);
  }
  const pool = poolFor(flavour);
  const cards = [];
  const groups = new Map(); // shared caps span the whole deck, not one slot type
  let state = rng;

  for (const [type, count] of Object.entries(DECK_SHAPE)) {
    const [picked, next] = fillSlots(pool[type], count, archetype, state, groups, flavour);
    state = next;
    cards.push(...picked);
  }

  // Signature cards first — the fusion repair reads the deck it is given, and
  // this only ever swaps Special slots, which the fusion repair never touches.
  guaranteeSignatureCards(cards, flavour, archetype);
  return [repairFusionMaterial(cards, flavour, archetype), state];
}

/**
 * A concrete 30-card list for a flavour + archetype, from a fixed seed.
 *
 * For the gallery and for tests that just want *a* deck. A real match builds
 * its decks from the match RNG in `createMatch`, so both players' decks come
 * out of the same reproducible stream.
 */
export function expandDeck(flavour, { archetype = null, seed = 12345 } = {}) {
  getDeck(flavour); // validates the id
  const [cards] = buildDeck({ flavour, archetype, rng: createRng(seed) });
  return cards;
}

/**
 * Check that every flavour x archetype combination produces a legal deck.
 * Called by validateDatabase, so adding a card can never quietly make one of
 * the twelve decks unbuildable.
 */
export function validateDecks() {
  const errors = [];
  for (const flavour of DECKS) {
    for (const archetype of [null, ...ARCHETYPE_IDS]) {
      const label = `${flavour.id}/${archetype ?? 'unweighted'}`;
      const counts = new Map();
      // A few seeds, because the pick is random within the weights.
      for (const seed of [1, 7, 99, 4242]) {
        const cards = expandDeck(flavour.id, { archetype, seed });
        if (cards.length !== DECK_SIZE) errors.push(`Deck ${label}: built ${cards.length} cards, expected ${DECK_SIZE}`);
        counts.clear();
        for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
        for (const [id, count] of counts) {
          if (count > MAX_COPIES) errors.push(`Deck ${label}: ${id} x${count} exceeds the ${MAX_COPIES}-copy limit`);
        }
      }
    }
    for (const archetype of [null, ...ARCHETYPE_IDS]) {
      for (const seed of [1, 7, 99, 4242, 31337]) {
        const reachable = completableRecipes(expandDeck(flavour.id, { archetype, seed }));
        if (reachable.length < MIN_COMPLETABLE_RECIPES) {
          errors.push(
            `Deck ${flavour.id}/${archetype ?? 'unweighted'} seed ${seed}: only ${reachable.length} ` +
              `completable fusion recipe(s), needs ${MIN_COMPLETABLE_RECIPES}`
          );
        }
      }
    }
    const pool = poolFor(flavour.id);
    for (const [type, needed] of Object.entries(DECK_SHAPE)) {
      const capacity = pool[type].length * MAX_COPIES;
      if (capacity < needed) {
        errors.push(`Deck ${flavour.id}: only ${capacity} ${type} slots available, needs ${needed}`);
      }
    }
  }
  return errors;
}

/**
 * The whole data integrity check: the card database plus the twelve decks it
 * has to be able to generate. This is the one the gallery banner and the tests
 * call; `validateDatabase` alone cannot see the decks without an import cycle.
 */
export function validateAll() {
  return [...validateDatabase(), ...validateDecks()];
}

/**
 * The flavours a player can pick, straight from cards.json. Kept here so the
 * setup screens import decks and archetypes from one place.
 */
export const FLAVOURS = DECKS;
