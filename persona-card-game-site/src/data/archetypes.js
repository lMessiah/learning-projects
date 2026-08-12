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
  FUSION_ALIGNMENTS,
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

/**
 * Traesto is worth exactly as much as there are Personas to pull back with it,
 * so its weight rides on how many Persona slots the deck being built actually
 * holds. A deck of five Personas has almost nothing to retreat and should
 * hardly ever see the card; a Persona-heavy one gets it at full strength.
 *
 * DESIGN NOTE: DECK_SHAPE currently fixes that count at 16 for every archetype,
 * so today this always evaluates to 1 and the card's real weighting comes from
 * its Tactical affinity plus the one-per-deck cap. It is written as a live
 * function of the deck anyway — if the shape ever stops being uniform, the card
 * follows it instead of quietly becoming a dead draw in a low-Persona deck.
 */
const RETREAT_PIVOT = DECK_SHAPE.persona;

function retreatScale(personaCount) {
  return Math.min(1, personaCount / RETREAT_PIVOT);
}

/* ------------------------------------------------------------------ *
 * Fusion material weighting
 * ------------------------------------------------------------------ */

/**
 * Why each fusion result is tagged the way it is in cards.json.
 *
 * Kept next to the code that spends the tag so the reasoning is auditable
 * rather than folklore. Every verdict was read off the printed card: its
 * Endurance measured against its Strength + Magic, how many distinct damage
 * types it can threaten, whether its kit heals or hurts, which direction its
 * buffs point (Tarukaja/Rakunda push damage out, Rakukaja/Tarunda soak it), and
 * what its passive does. The four closest calls are named because they are the
 * ones a reasonable person could argue with.
 */
export const FUSION_ALIGNMENT_EVIDENCE = Object.freeze({
  // Clear-cut aggressive: no healing, offensive buffs, low Endurance share.
  'fuse-mithra': 'Lowest Endurance share in the set (16 vs 40 offence), two offensive buffs, no healing.',
  'fuse-rangda': 'Lowest Endurance share of all (18 vs 48), four damage skills, no healing.',
  'fuse-black-frost': 'Trickster — a combo passive — plus four damage types, the widest coverage in the game.',
  'fuse-surt': 'Three damage types and Ragnarok at 110 power, on the second-lowest Endurance share.',
  'fuse-thanatos': 'Bloodlust, an attack passive, on three damage types and no healing.',
  'fuse-yoshitsune': 'Two offensive buffs and Hassou Tobi at 132; pure physical pressure.',
  'fuse-satanael': 'Riot Gun and Megidolaon, three damage types, no healing.',
  // Clear-cut defensive: healing, defensive buffs, or a high Endurance share.
  'fuse-kikuri-hime': 'Three healing skills including Diarahan, Rakukaja, and the highest Endurance share.',
  'fuse-titania': 'Mediarama and Diarahan — a healer that happens to hit.',
  'fuse-vasuki': 'The only result with two defensive buffs (Rakukaja and Tarunda) and no healing to distract from them.',
  // The close calls, decided on the single strongest defensive signal each.
  'fuse-girimehkala':
    'CLOSE CALL. Its kit is all offence, but it is the only result whose Endurance (24) exceeds its Magic (16) — it is built to be hit.',
  'fuse-odin':
    'CLOSE CALL. Counter is a purely reactive passive, and Rakukaja backs it up; the offence is real but it wins by being attacked.',
  'fuse-messiah':
    'CLOSE CALL. Diarahan AND Salvation — it is the only result that can undo a whole turn of damage, which outweighs its Megidolaon.',
  'fuse-izanagi-no-okami':
    'CLOSE CALL. The only Persona in the game with NO weakness, so it can never be knocked down for a One More; highest Endurance (32) and Rakukaja.',
});

/** Which fusion results each archetype is trying to build toward. */
const WANTS_RECIPES = Object.freeze({
  // Fusion IS the tactical plan, so it is dealt material for every recipe.
  tactical: () => true,
  aggressive: (recipe) => recipe.alignment === 'aggressive',
  defensive: (recipe) => recipe.alignment === 'defensive',
  // Swift wins by acting more often than you, not by spending a turn fusing.
  swift: () => false,
});

/**
 * How hard the fusion lean pulls, per archetype.
 *
 * Tactical pulls hardest because fusion is its plan rather than a bonus — it is
 * the archetype with no damage race and no wall to hide behind, and turning two
 * bodies into a better one is what it does instead. Aggressive and Defensive get
 * a real lean toward their own results without it deciding what the deck is for.
 *
 * These sit ABOVE AFFINITY_WEIGHT (1.6) on purpose, which looks wrong until you
 * notice the affinity term is multiplied by an affinity of up to 3 and this one
 * by a score capped at 1 — so at full tilt the archetype's own identity still
 * outweighs its fusion plan roughly two to one. At 1.3 the fusion lean lost
 * outright: a P3 Defensive deck ended up reaching FEWER defensive fusions than
 * an unweighted deck, because Defensive affinity kept buying it Unicorn, and
 * Strength is one of the only two Arcana no recipe asks for.
 *
 * DESIGN NOTE: these started equal, and Tactical came out reaching FEWER recipes
 * than Swift — which wants none at all. Wanting every recipe makes the score
 * flatter, not stronger, because almost every Arcana feeds something; the
 * archetype that wants everything needs the bigger multiplier to actually lead.
 * Swift's incidental reach is real, by the way, and not a bug: a Swift deck is
 * full of cheap low-level bodies spread thinly across Arcana, which is exactly
 * the shape that satisfies the cheap recipes by accident.
 *
 * 3.2 was measured, not guessed. 2.4 still left Tactical behind Swift in P3;
 * 4.0 bought almost nothing over 3.2 and starts making every Tactical deck look
 * the same, which is the failure mode AFFINITY_WEIGHT's comment warns about.
 */
const FUSION_MATERIAL_WEIGHT = Object.freeze({
  tactical: 3.2,
  aggressive: 2.0,
  defensive: 2.0,
  swift: 0,
});

const recipesWantedBy = (archetype) => FUSION_RECIPES.filter(WANTS_RECIPES[archetype] ?? (() => false));

/** Credit for a card that finishes a recipe the deck was one body short of. */
const COMPLETES_PAIR = 1;
/** Credit for a card that is only ever half of one. */
const HALF_A_PAIR = 0.45;

/**
 * How much this Persona advances a fusion the archetype actually wants, given
 * what the deck is already holding.
 *
 * Returns 0..1. A card scores full marks when it COMPLETES a recipe — the deck
 * already holds a partner of the other Arcana, and the two of them clear the
 * combined-level bar. Failing that it scores a fraction of how much of that bar
 * it could carry on its own, so a deck with nothing yet still drifts toward
 * usable material instead of picking at random.
 *
 * DESIGN NOTE: two earlier versions of this did not work, and both failed the
 * same way. Scoring "does this Arcana feed any recipe at all" moved every weight
 * by the same amount, because every Arcana but Strength and Empress feeds
 * something. Scoring the card's level against the bar was flatter still, since
 * any mid-level body maxes out the cheap recipes. What is scarce is not material
 * and not levels — it is a MATCHING PAIR, and a pair is a fact about the deck,
 * not about the card. That is why this reads `held`, and why it is the only
 * weighting term in this file that does.
 */
function fusionMaterialScore(card, archetype, held) {
  if (card.type !== 'persona' || !archetype) return 0;
  const wanted = recipesWantedBy(archetype);
  if (!wanted.length) return 0;

  let best = 0;
  for (const recipe of wanted) {
    if (!recipe.arcana.includes(card.arcana)) continue;

    // The other half of this recipe — the same Arcana again for the same-Arcana
    // recipes, which is why this removes one match rather than filtering it out.
    const partnerArcana = recipe.arcana[recipe.arcana.indexOf(card.arcana) === 0 ? 1 : 0];
    const partners = held.filter((c) => c.arcana === partnerArcana);
    const partner = partners.find((c) => c !== card) ?? partners[0];

    if (partner && card.level + partner.level + FUSION_GROWTH_ALLOWANCE >= recipe.minCombinedLevel) {
      return COMPLETES_PAIR; // nothing scores higher, so stop looking
    }
    // Half the growth allowance, because this body is only one of the two.
    const carried = (card.level + FUSION_GROWTH_ALLOWANCE / 2) / recipe.minCombinedLevel;
    best = Math.max(best, HALF_A_PAIR * Math.min(1, carried));
  }
  return best;
}

function weightOf(card, archetype, flavour, personaCount = RETREAT_PIVOT, held = []) {
  let weight = BASE_WEIGHT + AFFINITY_WEIGHT * affinityOf(card, archetype);
  const lean = leanOf(flavour);
  if (lean && lean !== archetype) weight += FLAVOUR_LEAN_WEIGHT * affinityOf(card, lean);
  if (card.exclusive) weight += EXCLUSIVE_WEIGHT;
  weight += (FUSION_MATERIAL_WEIGHT[archetype] ?? 0) * fusionMaterialScore(card, archetype, held);
  if (card.effect?.kind === 'retreat') weight *= retreatScale(personaCount);
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

function fillSlots(cards, count, archetype, rng, groups = new Map(), flavour = null, personaCount = RETREAT_PIVOT) {
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

  // The Personas chosen so far, so the fusion weighting can see a half-finished
  // pair and reach for the body that completes it. Rebuilding this from `out`
  // on every slot would be quadratic over the pool for no benefit.
  const held = [];

  for (let i = 0; i < count; i++) {
    const available = cards.filter((card) => !atCap(card));
    if (!available.length) break; // pool too small; the caller validates the size
    const weights = available.map((card) => weightOf(card, archetype, flavour, personaCount, held));
    const [picked, next] = pickWeighted(available, weights, state);
    state = next;
    copies.set(picked.id, (copies.get(picked.id) ?? 0) + 1);
    if (picked.deckGroup) groups.set(picked.deckGroup, (groups.get(picked.deckGroup) ?? 0) + 1);
    if (picked.type === 'persona') held.push(picked);
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
 * slots for the missing pieces, until the deck can complete
 * MIN_COMPLETABLE_RECIPES of them. It only ever touches Persona slots, so the
 * 16/8/6 shape and the copy limits survive.
 *
 * Recipes the archetype WANTS are repaired toward first, and only then the
 * cheapest of the rest. This matters more than the weighting does: the repair
 * is what actually guarantees a deck can fuse, so sorting it purely by cost —
 * which is what it used to do — handed several flavours a guaranteed defensive
 * fusion and left their Aggressive decks with nothing to build toward. Cost
 * still breaks ties, so a deck is never pushed at a recipe it cannot reach.
 */
function repairFusionMaterial(cards, flavour, archetype) {
  const pool = poolFor(flavour).persona;
  const wanted = new Set(recipesWantedBy(archetype).map((r) => r.id));
  const recipes = [...FUSION_RECIPES].sort(
    (a, b) =>
      Number(wanted.has(b.id)) - Number(wanted.has(a.id)) || a.minCombinedLevel - b.minCombinedLevel
  );

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

  // Personas are filled first (DECK_SHAPE's key order), so by the time the
  // Special slots are picked the deck already knows how many bodies it holds —
  // which is what Traesto's weight reads.
  for (const [type, count] of Object.entries(DECK_SHAPE)) {
    const personaCount = cards.filter((id) => getCard(id).type === 'persona').length;
    const [picked, next] = fillSlots(pool[type], count, archetype, state, groups, flavour, personaCount);
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
