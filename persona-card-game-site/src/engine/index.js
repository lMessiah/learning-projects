/**
 * Engine public API.
 *
 * The whole game is `newState = applyAction(state, action)` plus
 * `getLegalActions(state, player)`. Nothing in here touches the DOM or calls
 * Math.random(), so the identical module can run on a server for online play.
 */
export { CONFIG, skillCategory, MAGIC_TYPES } from './config.js';
export { createRng, nextFloat, nextInt, rollChance, shuffle, sample } from './rng.js';
export {
  createMatch,
  createPersonaInstance,
  opponentOf,
  getActive,
  findPersona,
  livingField,
  benchOf,
  koedField,
  fieldCount,
  hasFieldRoom,
  highestFieldLevel,
  playableLevelCap,
  canPlayPersonaCard,
  personaSkills,
  getSkill,
  buffOf,
  hasAilment,
  totalRemainingHp,
  handCard,
  handCardDefinition,
  visibleAffinities,
} from './state.js';
export { computeDamage, instakillChance, affinityOf, attackStatOf } from './damage.js';
export {
  applyBuff,
  applyAilment,
  cureAilments,
  dispelBuffs,
  addCharge,
  healPersona,
  restoreSp,
  revivePersona,
  levelUp,
  koPersona,
  drawCards,
  evaluateGameEnd,
  runStartOfTurn,
  runEndOfTurn,
} from './effects.js';
export { applyAction } from './actions.js';
export { redactStateFor, isRedacted, findLeaks, HIDDEN_CARD } from './redact.js';
export { getLegalActions, describeFusions, fusionCandidates } from './legal.js';
