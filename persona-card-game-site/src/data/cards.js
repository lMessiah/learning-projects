/**
 * Card database loader.
 *
 * Pure data layer: no DOM, no randomness, no game logic. Resolves the compact
 * `{ skill, unlockLevel }` references in cards.json into full skill objects so
 * consumers (engine, UI, tests) always see the documented card shape:
 *   { name, type, power, spCost | hpCost, unlockLevel, description, effect }
 *
 * Adding a card means editing cards.json only — nothing here or in the engine.
 */
import raw from './cards.json';
// The only engine import here: config holds no data, so this stays acyclic and
// keeps the deck level cap defined in exactly one place.
import { CONFIG } from '../engine/config.js';

const { DECK_MAX_PERSONA_LEVEL } = CONFIG;

/** Deep-freeze so neither the engine nor the UI can mutate card definitions. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function resolveSkill(ref, skillLibrary) {
  const base = skillLibrary[ref.skill];
  if (!base) throw new Error(`Unknown skill id "${ref.skill}" in cards.json`);
  // Card-level overrides (power/cost) win over the library defaults.
  const { skill: _id, ...overrides } = ref;
  return { id: ref.skill, ...base, ...overrides };
}

function buildPersona(persona, skillLibrary) {
  return {
    ...persona,
    fusionOnly: Boolean(persona.fusionOnly),
    skills: persona.skills.map((ref) => resolveSkill(ref, skillLibrary)),
  };
}

const skillLibrary = raw.skillLibrary;

export const META = raw.meta;
export const DAMAGE_TYPES = raw.meta.damageTypes;
export const ARCANA = raw.meta.arcana;

export const PERSONAS = raw.personas.map((p) => buildPersona(p, skillLibrary));
export const ITEMS = raw.items.map((i) => ({ ...i, usesAction: Boolean(i.usesAction) }));
export const SPECIALS = raw.specials.map((s) => ({ ...s, usesAction: Boolean(s.usesAction) }));
export const FUSION_RECIPES = raw.fusionRecipes;
export const DECKS = raw.decks;
export const STARTER_POOL = raw.starterPool;

/** Every card of every type, in one flat list. */
export const ALL_CARDS = [...PERSONAS, ...ITEMS, ...SPECIALS];

/** Every skill definition by id, straight from the library in cards.json. */
export const SKILLS = Object.fromEntries(
  Object.entries(skillLibrary).map(([id, skill]) => [id, { id, ...skill }])
);

/** Look up a skill definition by id. Returns null for an unknown id. */
export function getSkillDefinition(skillId) {
  return SKILLS[skillId] || null;
}

const BY_ID = new Map(ALL_CARDS.map((card) => [card.id, card]));

deepFreeze(PERSONAS);
deepFreeze(ITEMS);
deepFreeze(SPECIALS);
deepFreeze(FUSION_RECIPES);
deepFreeze(DECKS);
deepFreeze(STARTER_POOL);
deepFreeze(SKILLS);

/** Look up any card (persona/item/special) by id. Throws on typos. */
export function getCard(id) {
  const card = BY_ID.get(id);
  if (!card) throw new Error(`Unknown card id "${id}"`);
  return card;
}

export function getPersona(id) {
  const card = getCard(id);
  if (card.type !== 'persona') throw new Error(`Card "${id}" is not a Persona`);
  return card;
}

export function getDeck(id) {
  const deck = DECKS.find((d) => d.id === id);
  if (!deck) throw new Error(`Unknown deck id "${id}"`);
  return deck;
}

/** Expand a deck's { id, count } entries into a flat list of card ids. */
export function expandDeck(deckId) {
  const deck = getDeck(deckId);
  const out = [];
  for (const entry of deck.cards) {
    for (let i = 0; i < entry.count; i++) out.push(entry.id);
  }
  return out;
}

/** The low-level Personas offered as opening starters. */
export function getStarterPersonas() {
  return STARTER_POOL.map(getPersona);
}

/** Skills a Persona has access to at a given level. */
export function skillsAtLevel(persona, level) {
  return persona.skills.filter((s) => s.unlockLevel <= level);
}

/**
 * Data integrity check. Used by the gallery banner and by the Phase 2 tests so
 * a bad card edit fails loudly instead of producing a weird match.
 */
export function validateDatabase() {
  const errors = [];
  const seen = new Set();

  for (const card of ALL_CARDS) {
    if (seen.has(card.id)) errors.push(`Duplicate card id: ${card.id}`);
    seen.add(card.id);
    if (!card.name) errors.push(`Card ${card.id} has no name`);
  }

  for (const persona of PERSONAS) {
    if (!ARCANA.includes(persona.arcana)) {
      errors.push(`${persona.name}: unknown arcana "${persona.arcana}"`);
    }
    for (const list of ['weaknesses', 'resists']) {
      for (const dt of persona[list]) {
        if (!DAMAGE_TYPES.includes(dt)) errors.push(`${persona.name}: unknown damage type "${dt}" in ${list}`);
        if (dt === 'almighty') errors.push(`${persona.name}: almighty cannot appear in ${list}`);
      }
    }
    const overlap = persona.weaknesses.filter((w) => persona.resists.includes(w));
    if (overlap.length) errors.push(`${persona.name}: ${overlap.join(', ')} is both a weakness and a resist`);
    if (!persona.skills.some((s) => s.unlockLevel <= persona.level)) {
      errors.push(`${persona.name}: has no skill available at its printed level`);
    }
    for (const skill of persona.skills) {
      const isPhys = skill.type === 'phys';
      if (isPhys && skill.hpCost == null) errors.push(`${persona.name}/${skill.name}: physical skill needs hpCost`);
      if (!isPhys && skill.spCost == null) errors.push(`${persona.name}/${skill.name}: skill needs spCost`);
    }
  }

  for (const recipe of FUSION_RECIPES) {
    if (!BY_ID.has(recipe.result)) errors.push(`Recipe ${recipe.id}: unknown result "${recipe.result}"`);
    for (const arcana of recipe.arcana) {
      if (!ARCANA.includes(arcana)) errors.push(`Recipe ${recipe.id}: unknown arcana "${arcana}"`);
    }
  }

  // Fusion-only Personas are unobtainable unless some recipe produces them.
  const fusionResults = new Set(FUSION_RECIPES.map((r) => r.result));
  for (const persona of PERSONAS) {
    if (persona.fusionOnly && !fusionResults.has(persona.id)) {
      errors.push(`${persona.name}: fusion-only but no recipe produces it`);
    }
  }

  for (const deck of DECKS) {
    let total = 0;
    for (const entry of deck.cards) {
      if (!BY_ID.has(entry.id)) errors.push(`Deck ${deck.id}: unknown card "${entry.id}"`);
      else if (BY_ID.get(entry.id).fusionOnly) errors.push(`Deck ${deck.id}: ${entry.id} is fusion-only and cannot be in a deck`);
      // Keeps the power curve honest: no turn-3 level 46 draws.
      else if ((BY_ID.get(entry.id).level ?? 0) > DECK_MAX_PERSONA_LEVEL) {
        errors.push(`Deck ${deck.id}: ${entry.id} is level ${BY_ID.get(entry.id).level}, above the deck cap of ${DECK_MAX_PERSONA_LEVEL}`);
      }
      if (entry.count > 2) errors.push(`Deck ${deck.id}: ${entry.id} x${entry.count} exceeds the 2-copy limit`);
      total += entry.count;
    }
    if (total !== 30) errors.push(`Deck ${deck.id}: has ${total} cards, expected 30`);
  }

  for (const id of STARTER_POOL) {
    if (!BY_ID.has(id)) errors.push(`Starter pool: unknown card "${id}"`);
    else if (getPersona(id).level > 10) errors.push(`Starter pool: ${id} is too strong to be a starter`);
  }

  return errors;
}
