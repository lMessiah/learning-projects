/**
 * Game state construction and read-only selectors.
 *
 * State is a plain JSON-serialisable object: no class instances, no functions,
 * no DOM references. `applyAction` (actions.js) always returns a fresh copy.
 */
import { CONFIG } from './config.js';
import { createRng, shuffle, sample } from './rng.js';
import { getCard, getPersona, expandDeck, getSkillDefinition, STARTER_POOL } from '../data/cards.js';

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export function createPersonaInstance(state, cardId, owner, opts = {}) {
  const card = getPersona(cardId);
  const level = opts.level ?? card.level;
  const uid = `p${state.nextUid++}`;
  return {
    uid,
    cardId,
    owner,
    level,
    strength: card.strength,
    magic: card.magic,
    endurance: card.endurance,
    maxHp: card.hp,
    hp: card.hp,
    maxSp: card.sp,
    sp: card.sp,
    ko: false,
    knockedDown: false,
    guarding: false,
    buffs: [], // [{ stat:'atk'|'def', direction:'up'|'down', turnsLeft }]
    ailments: [], // [{ type:'burn'|'shock', turnsLeft }]
    charges: [], // ['concentrate'|'charge']
    inheritedSkills: opts.inheritedSkills ? [...opts.inheritedSkills] : [],
    // Damage types the OPPONENT has already struck this Persona with. Its
    // weakness/resist to those types is public knowledge from then on.
    revealedTypes: [],
  };
}

function createPlayer(id, { name, deckId, controller = 'human', difficulty = null }) {
  return {
    id,
    name,
    deckId,
    controller, // 'human' | 'bot'
    difficulty, // bot only
    deck: [],
    hand: [], // [{ uid, cardId }]
    discard: [],
    field: [], // persona instances, including KO'd ones (KO'd don't occupy the cap)
    activeUid: null,
    koCount: 0, // how many of THIS player's Personas have been KO'd
    fatigue: 0,
    reshuffles: 0,
  };
}

/**
 * Start a match. The result sits in the `starterSelect` phase: each player is
 * offered 3 random low-level Personas and must CHOOSE_STARTER before play.
 */
export function createMatch({ seed = 1, players }) {
  if (!players || players.length !== 2) throw new Error('createMatch needs exactly 2 players');

  const state = {
    version: 1,
    config: { ...CONFIG },
    rng: createRng(seed),
    seed,
    nextUid: 1,
    phase: 'starterSelect',
    turn: 0,
    activePlayer: 0,
    players: players.map((p, i) => createPlayer(i, p)),
    turnState: null,
    starterOptions: [[], []],
    winner: null,
    endReason: null,
    suddenDeath: null,
    log: [],
  };

  for (const player of state.players) {
    const [deck, rng] = shuffle(state.rng, expandDeck(player.deckId));
    state.rng = rng;
    player.deck = deck;
  }

  for (let i = 0; i < 2; i++) {
    const [options, rng] = sample(state.rng, STARTER_POOL, 3);
    state.rng = rng;
    state.starterOptions[i] = options;
  }

  pushLog(state, 'Match start. Choose your starting Persona.', 'system');
  return state;
}

export function createTurnState() {
  return {
    actionsRemaining: CONFIG.ACTIONS_PER_TURN,
    personaChangesRemaining: CONFIG.PERSONA_CHANGES_PER_TURN,
    oneMoreUsed: false,
    itemsPlayed: 0,
    specialsPlayed: 0,
    canTargetBench: false,
    personasPlayed: 0,
  };
}

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

/**
 * Every action deep-copies the state, so an unbounded log would make a long
 * match quadratic in memory and time. Only the recent tail is retained; ids
 * keep counting so the UI can still tell entries apart.
 */
export const MAX_LOG_ENTRIES = 400;

export function pushLog(state, text, kind = 'info') {
  const id = (state.log[state.log.length - 1]?.id ?? 0) + 1;
  state.log.push({ id, turn: state.turn, kind, text });
  if (state.log.length > MAX_LOG_ENTRIES) {
    state.log.splice(0, state.log.length - MAX_LOG_ENTRIES);
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export const opponentOf = (playerId) => (playerId === 0 ? 1 : 0);

export function findPersona(state, uid) {
  for (const player of state.players) {
    const found = player.field.find((p) => p.uid === uid);
    if (found) return found;
  }
  return null;
}

export function requirePersona(state, uid) {
  const persona = findPersona(state, uid);
  if (!persona) throw new Error(`No Persona with uid "${uid}"`);
  return persona;
}

export function getActive(state, playerId) {
  const player = state.players[playerId];
  if (!player.activeUid) return null;
  return player.field.find((p) => p.uid === player.activeUid) || null;
}

/** Living Personas on a player's field (active + bench). */
export function livingField(state, playerId) {
  return state.players[playerId].field.filter((p) => !p.ko);
}

export function benchOf(state, playerId) {
  const player = state.players[playerId];
  return player.field.filter((p) => !p.ko && p.uid !== player.activeUid);
}

export function koedField(state, playerId) {
  return state.players[playerId].field.filter((p) => p.ko);
}

export function fieldCount(state, playerId) {
  return livingField(state, playerId).length;
}

export function hasFieldRoom(state, playerId) {
  return fieldCount(state, playerId) < CONFIG.FIELD_CAP;
}

/**
 * Highest level among the Personas on a player's field.
 *
 * DESIGN NOTE: KO'd Personas still count. They are still on your field, and
 * ignoring them would mean a board wipe throws your power ceiling back to zero
 * and strands every mid-tier card in your hand.
 */
export function highestFieldLevel(state, playerId) {
  return state.players[playerId].field.reduce((max, persona) => Math.max(max, persona.level), 0);
}

/** The printed level a Persona card must be at or under to be played right now. */
export function playableLevelCap(state, playerId) {
  return highestFieldLevel(state, playerId) + CONFIG.PLAY_LEVEL_GAP;
}

/** Can this Persona card be played to the field yet? */
export function canPlayPersonaCard(state, playerId, cardId) {
  return getPersona(cardId).level <= playableLevelCap(state, playerId);
}

/** Every skill a Persona can currently use: printed (unlocked) + inherited. */
export function personaSkills(state, persona) {
  const card = getPersona(persona.cardId);
  const printed = card.skills.filter((s) => s.unlockLevel <= persona.level);
  if (!persona.inheritedSkills.length) return printed;

  const known = new Set(printed.map((s) => s.id));
  const inherited = [];
  for (const skillId of persona.inheritedSkills) {
    if (known.has(skillId)) continue;
    known.add(skillId);
    const source = findSkillDefinition(skillId);
    if (source) inherited.push({ ...source, unlockLevel: 1, inherited: true });
  }
  return [...printed, ...inherited];
}

/** Look a skill definition up by id. Single source of truth: the card data. */
export function findSkillDefinition(skillId) {
  return getSkillDefinition(skillId);
}

export function getSkill(state, persona, skillId) {
  return personaSkills(state, persona).find((s) => s.id === skillId) || null;
}

export function buffOf(persona, stat) {
  return persona.buffs.find((b) => b.stat === stat) || null;
}

export function hasAilment(persona, type) {
  return persona.ailments.some((a) => a.type === type);
}

export function totalRemainingHp(state, playerId) {
  return livingField(state, playerId).reduce((sum, p) => sum + p.hp, 0);
}

export function handCard(state, playerId, uid) {
  return state.players[playerId].hand.find((c) => c.uid === uid) || null;
}

/**
 * What `viewerId` is allowed to know about a Persona's affinities.
 * Your own Personas are fully visible; the opponent's are masked until struck.
 */
export function visibleAffinities(state, persona, viewerId) {
  const card = getPersona(persona.cardId);
  if (persona.owner === viewerId) {
    return { weaknesses: [...card.weaknesses], resists: [...card.resists], revealed: 'all' };
  }
  const revealed = new Set(persona.revealedTypes);
  return {
    weaknesses: card.weaknesses.filter((t) => revealed.has(t)),
    resists: card.resists.filter((t) => revealed.has(t)),
    revealed: [...persona.revealedTypes],
  };
}

/** Deep copy for the reducer. State is plain JSON, so this is total. */
export function cloneState(state) {
  return typeof structuredClone === 'function'
    ? structuredClone(state)
    : JSON.parse(JSON.stringify(state));
}

/** Convenience for UI/bot: the card definition behind a hand entry. */
export function handCardDefinition(entry) {
  return getCard(entry.cardId);
}
