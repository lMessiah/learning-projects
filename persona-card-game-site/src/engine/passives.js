/**
 * Persona passives.
 *
 * A Persona card may print **at most one** passive, and most print none. A
 * passive is never an activated choice: it is always-on or auto-triggered, so
 * it never appears in `getLegalActions` and never costs an action.
 *
 * Every passive is declared here as a set of **hooks**. The engine calls
 * `runHook(persona, name, ctx)` at the relevant moment and acts on the returned
 * value; adding a passive is one entry in this table plus a `passive` field on
 * a card in cards.json.
 *
 * The handlers are deliberately *pure*: they read state and return a decision,
 * they never mutate. The mutation stays in effects.js, so there is still exactly
 * one implementation of "deal damage" / "knock down" / "level up" in the engine
 * and a passive can't quietly grow a second one. (It also keeps this module free
 * of a circular import back into effects.js.)
 *
 * Hooks
 *   onKnockdownAttempt ({ persona })                  -> 'prevent' | null
 *   onDamageTaken      ({ persona, damageType, dealt, wasStanding })
 *                                                     -> { reflect:number } | null
 *   onFatalDamage      ({ persona })                  -> { survive:true } | null
 *   onDamageDealt      ({ persona, defender })        -> { revealAll:true } | null
 *   onSkillUsed        ({ persona, skill, alreadyUsed }) -> { draw:number } | null
 *   onTurnStart        ({ persona, spRegen })         -> { spRegen:number } | null
 *   onFusionMaterial   ({ persona })                  -> { bonusLevels:number } | null
 *   damageMultiplier   ({ state, persona })           -> number
 *   oneMoreChain       ({ persona })                  -> boolean
 */
import { CONFIG } from './config.js';
import { getPersona } from '../data/cards.js';
import { opponentOf } from './state.js';

/**
 * A fusion `inherit` entry of `"passive:<id>"` means "take this parent's
 * passive instead of one of its skills".
 */
export const PASSIVE_CHOICE_PREFIX = 'passive:';

export const PASSIVE_DEFS = Object.freeze({
  trickster: {
    id: 'trickster',
    name: 'Trickster',
    description: 'Your One Mores can chain: knocking down a standing Persona during a One More grants another One More.',
    oneMoreChain: () => true,
  },

  stalwart: {
    id: 'stalwart',
    name: 'Stalwart',
    description: `Cannot be knocked down while above ${Math.round(CONFIG.STALWART_HP_RATIO * 100)}% HP.`,
    onKnockdownAttempt: ({ persona }) =>
      persona.hp > persona.maxHp * CONFIG.STALWART_HP_RATIO ? 'prevent' : null,
  },

  counter: {
    id: 'counter',
    name: 'Counter',
    description: `When hit by a physical skill while standing, reflects ${Math.round(
      CONFIG.COUNTER_REFLECT * 100
    )}% of the damage back to the attacker.`,
    onDamageTaken: ({ damageType, dealt, wasStanding }) => {
      if (damageType !== 'phys' || !wasStanding || dealt <= 0) return null;
      const reflect = Math.round(dealt * CONFIG.COUNTER_REFLECT);
      return reflect > 0 ? { reflect } : null;
    },
  },

  analyst: {
    id: 'analyst',
    name: 'Analyst',
    description: "When this Persona damages an enemy, that enemy's weaknesses and resists are revealed.",
    onDamageDealt: () => ({ revealAll: true }),
  },

  bloodlust: {
    id: 'bloodlust',
    name: 'Bloodlust',
    description: `Deals ${Math.round((CONFIG.BLOODLUST_MULT - 1) * 100)}% more damage while its owner is behind on the KO tally.`,
    damageMultiplier: ({ state, persona }) => (koDeficit(state, persona.owner) > 0 ? CONFIG.BLOODLUST_MULT : 1),
  },

  'soul-battery': {
    id: 'soul-battery',
    name: 'Soul Battery',
    description: `Regenerates x${CONFIG.SOUL_BATTERY_MULT} SP at the start of its owner's turn.`,
    onTurnStart: ({ spRegen }) => ({ spRegen: spRegen * CONFIG.SOUL_BATTERY_MULT }),
  },

  momentum: {
    id: 'momentum',
    name: 'Momentum',
    description: `After this Persona uses a skill costing ${CONFIG.MOMENTUM_SP_THRESHOLD} SP or less, draw a card. Once per turn.`,
    onSkillUsed: ({ skill, alreadyUsed }) => {
      if (alreadyUsed) return null;
      const cost = skill?.spCost ?? 0;
      if (!cost || cost > CONFIG.MOMENTUM_SP_THRESHOLD) return null;
      return { draw: CONFIG.MOMENTUM_DRAW };
    },
  },

  endure: {
    id: 'endure',
    name: 'Endure',
    description:
      'Survives an otherwise-fatal blow with 1 HP. Once per match, and it works against anything that deals damage — including a Burn tick or Fatigue.',
    // The once-per-match flag lives on the instance, so the hook stays pure: it
    // reads state and answers, and effects.js does the writing.
    onFatalDamage: ({ persona }) => (persona.endured ? null : { survive: true }),
  },

  'sacrificial-lamb': {
    id: 'sacrificial-lamb',
    name: 'Sacrificial Lamb',
    description: `When used as fusion material, the fusion result enters play at +${CONFIG.SACRIFICIAL_LAMB_LEVELS} levels.`,
    onFusionMaterial: () => ({ bonusLevels: CONFIG.SACRIFICIAL_LAMB_LEVELS }),
  },
});

/** Every passive, for the gallery and the rules screen. */
export const PASSIVE_LIST = Object.freeze(Object.values(PASSIVE_DEFS));

/**
 * How far behind on the KO tally a player is. `koCount` counts the player's
 * OWN Personas that have been knocked out, so being behind means having lost
 * more than the opponent.
 */
export function koDeficit(state, playerId) {
  return state.players[playerId].koCount - state.players[opponentOf(playerId)].koCount;
}

/** The passive a Persona *instance* currently has (fusion can change it). */
export function passiveOf(persona) {
  if (!persona) return null;
  // `passive` is undefined on states written before passives existed; fall back
  // to the printed one so old saves and hand-built test fixtures still work.
  if (persona.passive !== undefined) return persona.passive || null;
  return printedPassive(persona.cardId);
}

/** The passive printed on a card, independent of any instance. */
export function printedPassive(cardId) {
  if (!cardId) return null;
  return getPersona(cardId).passive || null;
}

export function hasPassive(persona, id) {
  return passiveOf(persona) === id;
}

export function passiveDefinition(id) {
  return PASSIVE_DEFS[id] || null;
}

/**
 * Run one hook for a Persona. Returns the handler's result, or `fallback` when
 * the Persona has no passive or that passive doesn't implement the hook.
 */
export function runHook(persona, hookName, ctx = {}, fallback = null) {
  const def = PASSIVE_DEFS[passiveOf(persona)];
  const handler = def?.[hookName];
  if (!handler) return fallback;
  return handler({ ...ctx, persona });
}

/* --- Convenience wrappers, so callers read as rules rather than plumbing --- */

export const preventsKnockdown = (persona) => runHook(persona, 'onKnockdownAttempt', {}) === 'prevent';

export const chainsOneMore = (persona) => Boolean(runHook(persona, 'oneMoreChain', {}, false));

export const revealsAllAffinities = (attacker, defender) =>
  Boolean(runHook(attacker, 'onDamageDealt', { defender })?.revealAll);

export const counterReflection = (defender, { damageType, dealt, wasStanding }) =>
  runHook(defender, 'onDamageTaken', { damageType, dealt, wasStanding })?.reflect ?? 0;

export const passiveDamageMultiplier = (state, attacker) =>
  runHook(attacker, 'damageMultiplier', { state }, 1) ?? 1;

export const spRegenFor = (persona, spRegen) =>
  runHook(persona, 'onTurnStart', { spRegen }, null)?.spRegen ?? spRegen;

export const momentumDraw = (persona, { skill, alreadyUsed }) =>
  runHook(persona, 'onSkillUsed', { skill, alreadyUsed })?.draw ?? 0;

export const enduresFatalBlow = (persona) => Boolean(runHook(persona, 'onFatalDamage', {})?.survive);

export const fusionLevelBonus = (materials) =>
  materials.reduce((sum, persona) => sum + (runHook(persona, 'onFusionMaterial', {})?.bonusLevels ?? 0), 0);
