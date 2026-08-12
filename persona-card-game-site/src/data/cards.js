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
/** Passive ids a card is allowed to print. Implementations live in engine/passives.js. */
export const PASSIVE_IDS = raw.meta.passives ?? [];
/** Archetype tags every card must carry an `affinity` entry for. The archetype
 *  definitions themselves live in archetypes.js, which imports this file. */
export const ARCHETYPE_TAGS = raw.meta.archetypes ?? [];

export const PERSONAS = raw.personas.map((p) => buildPersona(p, skillLibrary));
export const ITEMS = raw.items.map((i) => ({ ...i, usesAction: Boolean(i.usesAction) }));
export const SPECIALS = raw.specials.map((s) => ({ ...s, usesAction: Boolean(s.usesAction) }));
export const FUSION_RECIPES = raw.fusionRecipes;

/**
 * What a fusion result is FOR, as a play pattern.
 *
 * Every recipe carries one of these. It is what lets a deck be built toward the
 * fusion its archetype actually wants: an Aggressive deck is dealt the material
 * for an aggressive result, a Defensive one the material for a defensive result.
 *
 * The tag describes the RESULT, not the parents — the parents are ordinary
 * Personas of whatever Arcana the recipe asks for, and most of them feed both
 * kinds of recipe. See FUSION_ALIGNMENT_EVIDENCE in archetypes.js for what each
 * verdict was read off.
 */
export const FUSION_ALIGNMENTS = Object.freeze(['aggressive', 'defensive']);
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

/**
 * Decks are GENERATED from a flavour + archetype rather than hand-written, so
 * the expansion lives in archetypes.js (which needs the seeded RNG). This file
 * stays the pure data layer.
 */

/** The low-level Personas offered as opening starters. */
export function getStarterPersonas() {
  return STARTER_POOL.map(getPersona);
}

/* ------------------------------------------------------------------ *
 * Card quality
 * ------------------------------------------------------------------ */

/**
 * How strong a card is, on a single 0..1 scale across the whole database.
 *
 * Momentum Draw needs to compare a Persona against an Item, so the two scales
 * have to meet somewhere. A Persona scores itself — printed level plus how many
 * skills it brings — normalised against the range of everything that can
 * legally sit in a deck. Items and Specials carry a hand-assigned `quality`
 * tag of 1..5 in cards.json, normalised the same way.
 *
 * Fusion-only Personas are excluded from the range: they never enter a deck, so
 * letting them stretch the scale would squash every card that actually can be
 * drawn down toward zero.
 */
const deckLegalPersonas = PERSONAS.filter((p) => !p.fusionOnly && p.level <= DECK_MAX_PERSONA_LEVEL);
const personaRaw = (persona) => persona.level + persona.skills.length;
const PERSONA_QUALITY_MIN = Math.min(...deckLegalPersonas.map(personaRaw));
const PERSONA_QUALITY_MAX = Math.max(...deckLegalPersonas.map(personaRaw));
const ITEM_QUALITY_MIN = 1;
const ITEM_QUALITY_MAX = 5;

const normalise = (value, min, max) => (max <= min ? 0.5 : Math.min(1, Math.max(0, (value - min) / (max - min))));

/** @returns {number} 0..1 */
export function cardQuality(cardId) {
  const card = getCard(cardId);
  if (card.type === 'persona') {
    return normalise(personaRaw(card), PERSONA_QUALITY_MIN, PERSONA_QUALITY_MAX);
  }
  return normalise(card.quality ?? 3, ITEM_QUALITY_MIN, ITEM_QUALITY_MAX);
}

/** Skills a Persona has access to at a given level. */
export function skillsAtLevel(persona, level) {
  return persona.skills.filter((s) => s.unlockLevel <= level);
}

/**
 * Data integrity check. Used by the gallery banner and by the engine tests so
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
    if (persona.passive && !PASSIVE_IDS.includes(persona.passive)) {
      errors.push(`${persona.name}: unknown passive "${persona.passive}"`);
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
    // Untagged is not allowed to mean "neither": deck building sorts recipes by
    // this, and a missing tag would quietly drop the recipe out of every
    // archetype's plan instead of failing loudly here.
    if (!FUSION_ALIGNMENTS.includes(recipe.alignment)) {
      errors.push(
        `Recipe ${recipe.id}: alignment must be one of ${FUSION_ALIGNMENTS.join(' | ')}, got ${JSON.stringify(recipe.alignment)}`
      );
    }
  }

  // Fusion-only Personas are unobtainable unless some recipe produces them.
  const fusionResults = new Set(FUSION_RECIPES.map((r) => r.result));
  for (const persona of PERSONAS) {
    if (persona.fusionOnly && !fusionResults.has(persona.id)) {
      errors.push(`${persona.name}: fusion-only but no recipe produces it`);
    }
  }

  for (const card of ALL_CARDS) {
    if (!card.affinity) {
      errors.push(`${card.name}: has no archetype affinity block`);
      continue;
    }
    for (const archetype of ARCHETYPE_TAGS) {
      const value = card.affinity[archetype];
      if (!Number.isInteger(value) || value < 0 || value > 3) {
        errors.push(`${card.name}: affinity.${archetype} must be an integer 0-3, got ${value}`);
      }
    }
  }

  // Decks are generated rather than listed, so their integrity is checked by
  // `validateDecks()` in archetypes.js — which imports this file, so it cannot
  // be called from here without a cycle. `validateAll()` runs both.

  // A Skill Card may only ever name a real entry in the skill library, which is
  // what makes "no passives" structural rather than a convention.
  for (const card of [...ITEMS, ...SPECIALS]) {
    if (card.effect?.kind !== 'teachSkill') continue;
    if (!SKILLS[card.effect.skillId]) {
      errors.push(`${card.name}: teaches unknown skill "${card.effect.skillId}"`);
    }
    if (card.deckGroup !== 'skill-card') errors.push(`${card.name}: a Skill Card must carry deckGroup "skill-card"`);
  }

  for (const id of STARTER_POOL) {
    if (!BY_ID.has(id)) errors.push(`Starter pool: unknown card "${id}"`);
    else if (getPersona(id).level > 10) errors.push(`Starter pool: ${id} is too strong to be a starter`);
  }

  return errors;
}
