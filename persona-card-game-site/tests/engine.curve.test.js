/**
 * The power curve: a Persona card cannot be played to the field until the rest
 * of your board has grown into it. Fixes "I received a level 46 Persona on turn 3".
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction,
  getLegalActions,
  createRng,
  createMatch,
  playableLevelCap,
  highestFieldLevel,
  canPlayPersonaCard,
  CONFIG,
} from '../src/engine/index.js';
import { chooseBotAction } from '../src/engine/bot.js';
import { getPersona, DECKS } from '../src/data/cards.js';
import { ARCHETYPE_IDS, expandDeck } from '../src/data/archetypes.js';
import { setupMatch, setField, setHand, activeOf, handUidOf } from './helpers.js';

describe('play level gap', () => {
  it('caps playable level at the best Persona on your field + PLAY_LEVEL_GAP', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]); // level 3
    expect(highestFieldLevel(state, 0)).toBe(3);
    expect(playableLevelCap(state, 0)).toBe(3 + CONFIG.PLAY_LEVEL_GAP);
  });

  it('refuses to play a Persona above the cap', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]); // cap 13
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    setHand(state, 0, ['sarasvati']); // level 19

    expect(canPlayPersonaCard(state, 0, 'sarasvati')).toBe(false);
    expect(() =>
      applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(state, 0, 'sarasvati') })
    ).toThrow(/cannot play above level 13/);
  });

  it('hides an over-level Persona from the legal actions but keeps it in hand', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    setHand(state, 0, ['sarasvati', 'hua-po']); // 19 (too strong) and 10 (fine)

    const plays = getLegalActions(state, 0).filter((a) => a.type === 'PLAY_PERSONA');
    expect(plays.map((a) => a.cardId)).toEqual(['hua-po']);
    expect(state.players[0].hand).toHaveLength(2); // the card is not discarded, just unplayable
  });

  it('unlocks the card once the board grows into it', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    setHand(state, 0, ['sarasvati']);
    expect(canPlayPersonaCard(state, 0, 'sarasvati')).toBe(false);

    // Level the active up to 9 -> cap 19 -> Sarasvati (19) becomes playable.
    activeOf(state, 0).level = 9;
    expect(playableLevelCap(state, 0)).toBe(19);
    expect(canPlayPersonaCard(state, 0, 'sarasvati')).toBe(true);
    expect(() =>
      applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(state, 0, 'sarasvati') })
    ).not.toThrow();
  });

  it('counts KO\'d Personas toward the cap so a board wipe does not strand your hand', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'sarasvati', active: true }]);
    state.players[0].field[0].ko = true;
    state.players[0].field[0].hp = 0;
    state.players[0].activeUid = null;

    expect(highestFieldLevel(state, 0)).toBe(19);
    expect(playableLevelCap(state, 0)).toBe(29);
  });

  it('lets every starter-tier Persona be played from the opening board', () => {
    const state = setupMatch();
    // Whatever starter you were given, the low-tier pool stays playable.
    for (const cardId of ['pixie', 'jack-frost', 'apsaras', 'orpheus', 'hua-po']) {
      expect(canPlayPersonaCard(state, 0, cardId)).toBe(true);
    }
  });

  it('does not gate fusion results — fusion has its own level requirement', () => {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'jack-frost', level: 13, active: true },
      { cardId: 'sarasvati' },
    ]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);

    // Black Frost is level 38, far above the cap, but fusion is allowed.
    expect(playableLevelCap(state, 0)).toBe(19 + CONFIG.PLAY_LEVEL_GAP);
    const after = applyAction(state, {
      type: 'FUSE',
      player: 0,
      recipeId: 'fuse-black-frost',
      sacrifices: [
        { zone: 'field', uid: state.players[0].field[0].uid },
        { zone: 'field', uid: state.players[0].field[1].uid },
      ],
      inherit: ['bufu', 'media'],
    });
    expect(activeOf(after, 0).cardId).toBe('black-frost');
    expect(activeOf(after, 0).level).toBe(38);
  });
});

describe('deck curve', () => {
  it('contains nothing above the deck level cap in any generated deck', () => {
    for (const deck of DECKS) {
      for (const archetype of [null, ...ARCHETYPE_IDS]) {
        for (const cardId of expandDeck(deck.id, { archetype })) {
          let persona = null;
          try {
            persona = getPersona(cardId);
          } catch {
            continue; // Items and Specials have no level
          }
          expect(persona.level).toBeLessThanOrEqual(CONFIG.DECK_MAX_PERSONA_LEVEL);
        }
      }
    }
  });

  it('never lets a card be played above the cap over whole real matches', () => {
    // The invariant that matters: every Persona that reaches the field FROM HAND
    // was within the curve at the moment it was played. (Fusion results are
    // exempt by design — they are paid for with two Personas and a combined
    // level requirement.)
    for (let seed = 1; seed <= 8; seed++) {
      let state = createMatch({ seed, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p5' }] });
      let rng = createRng(seed * 3 + 1);
      let plays = 0;

      for (let steps = 0; steps < 6000 && state.winner === null && state.turn <= 200; steps++) {
        const playerId = state.phase === 'starterSelect'
          ? state.players.findIndex((p) => p.field.length === 0)
          : state.activePlayer;
        const [action, next] = chooseBotAction(state, playerId, 'brutal', rng);
        rng = next;
        if (!action) break;

        if (action.type === 'PLAY_PERSONA') {
          const level = getPersona(action.cardId).level;
          expect(level).toBeLessThanOrEqual(playableLevelCap(state, action.player));
          expect(level).toBeLessThanOrEqual(CONFIG.DECK_MAX_PERSONA_LEVEL);
          plays += 1;
        }
        state = applyAction(state, action);
      }
      expect(plays).toBeGreaterThan(0); // the rule was actually exercised
    }
  });

  it('keeps the opening turns low-level', () => {
    for (let seed = 1; seed <= 12; seed++) {
      let state = createMatch({ seed, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p4' }] });
      let rng = createRng(seed * 3 + 1);

      for (let steps = 0; steps < 600 && state.winner === null && state.turn <= 4; steps++) {
        const playerId = state.phase === 'starterSelect'
          ? state.players.findIndex((p) => p.field.length === 0)
          : state.activePlayer;
        const [action, next] = chooseBotAction(state, playerId, 'brutal', rng);
        rng = next;
        if (!action) break;
        state = applyAction(state, action);
      }

      for (const player of state.players) {
        for (const persona of player.field) {
          const card = getPersona(persona.cardId);
          // The reported bug was a level 46 Persona on turn 3, straight out of
          // the deck. Anything above the deck cap this early has to be a fusion
          // result — which cost its owner two bodies and an action.
          if (persona.level > CONFIG.DECK_MAX_PERSONA_LEVEL) {
            expect(card.fusionOnly, `${card.name} reached the board without being fused`).toBe(true);
            expect(state.log.some((l) => l.kind === 'fusion')).toBe(true);
          }
          // And even an earned one stays inside the mid tier this early.
          expect(persona.level).toBeLessThan(40);
        }
      }
    }
  });
});
