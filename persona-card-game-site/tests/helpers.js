/**
 * Test helpers: build a match and then rewrite the board into an exact,
 * readable setup. Tests own their state object outright, so mutating it here
 * before feeding it to `applyAction` is safe.
 */
import { createMatch, applyAction, createPersonaInstance, CONFIG } from '../src/engine/index.js';
import { getPersona } from '../src/data/cards.js';

/** A started match with both starters chosen (first option each). */
export function setupMatch({ seed = 42, decks = ['p3', 'p4'], names = ['Alpha', 'Beta'] } = {}) {
  let state = createMatch({
    seed,
    players: [
      { name: names[0], deckId: decks[0] },
      { name: names[1], deckId: decks[1] },
    ],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  return state;
}

/**
 * Skip past the opening-turns fusion lock.
 *
 * Fusion does not open until CONFIG.FUSION_FIRST_TURN, which is a rule about
 * pacing rather than about any of the mechanics these fixtures test. Anything
 * that fuses calls this so the lock is never the reason a test fails.
 */
export function unlockFusion(state) {
  state.turn = Math.max(state.turn, CONFIG.FUSION_FIRST_TURN);
  return state;
}

/**
 * Replace a player's whole field.
 * @param specs [{ cardId, level?, hp?, sp?, active?, inheritedSkills? }]
 */
export function setField(state, playerId, specs) {
  const player = state.players[playerId];
  player.field = [];
  player.activeUid = null;
  for (const spec of specs) {
    const persona = createPersonaInstance(state, spec.cardId, playerId, {
      level: spec.level,
      inheritedSkills: spec.inheritedSkills,
    });
    if (spec.hp != null) persona.hp = spec.hp;
    if (spec.sp != null) persona.sp = spec.sp;
    if (spec.maxHp != null) persona.maxHp = spec.maxHp;
    player.field.push(persona);
    if (spec.active) player.activeUid = persona.uid;
  }
  if (!player.activeUid && player.field.length) player.activeUid = player.field[0].uid;
  return state;
}

/** Replace a player's hand with specific cards. Returns the new hand entries. */
export function setHand(state, playerId, cardIds) {
  const player = state.players[playerId];
  player.hand = cardIds.map((cardId) => ({ uid: `h${state.nextUid++}`, cardId }));
  return player.hand;
}

export const activeOf = (state, playerId) =>
  state.players[playerId].field.find((p) => p.uid === state.players[playerId].activeUid);

export const uidOf = (state, playerId, cardId) =>
  state.players[playerId].field.find((p) => p.cardId === cardId)?.uid;

export const handUidOf = (state, playerId, cardId) =>
  state.players[playerId].hand.find((c) => c.cardId === cardId)?.uid;

/** A bare Persona instance for unit-testing the damage formula in isolation. */
export function fakePersona(cardId, overrides = {}) {
  const card = getPersona(cardId);
  return {
    uid: `fake-${cardId}`,
    cardId,
    owner: 0,
    level: card.level,
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
    buffs: [],
    ailments: [],
    charges: [],
    inheritedSkills: [],
    revealedTypes: [],
    ...overrides,
  };
}

/** End the current turn, auto-discarding down to the hand limit if needed. */
export function endTurn(state, playerId = state.activePlayer) {
  const hand = state.players[playerId].hand;
  const overflow = Math.max(0, hand.length - state.config.HAND_LIMIT);
  return applyAction(state, {
    type: 'END_TURN',
    player: playerId,
    discard: hand.slice(0, overflow).map((c) => c.uid),
  });
}
