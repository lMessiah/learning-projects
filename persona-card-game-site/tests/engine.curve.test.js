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
  canFuseInto,
  fusionLevelCap,
  fusionUnlocked,
  describeFusions,
  CONFIG,
} from '../src/engine/index.js';
import { chooseBotAction } from '../src/engine/bot.js';
import { getPersona, DECKS } from '../src/data/cards.js';
import { ARCHETYPE_IDS, expandDeck } from '../src/data/archetypes.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, unlockFusion } from './helpers.js';

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

  it('gates fusion results too — a small board cannot leapfrog the ladder', () => {
    const state = unlockFusion(setupMatch());
    // Combined level 32 satisfies the recipe's own requirement, but the best
    // body on the board is a 16, so the ceiling for a fusion is 36.
    setField(state, 0, [
      { cardId: 'jack-frost', level: 16, active: true },
      { cardId: 'sarasvati', level: 16 },
    ]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);

    expect(fusionLevelCap(state, 0)).toBe(16 + CONFIG.FUSION_LEVEL_GAP);
    expect(canFuseInto(state, 0, 'black-frost')).toBe(false); // Lv 38

    const fuse = {
      type: 'FUSE',
      player: 0,
      recipeId: 'fuse-black-frost',
      sacrifices: [
        { zone: 'field', uid: state.players[0].field[0].uid },
        { zone: 'field', uid: state.players[0].field[1].uid },
      ],
      inherit: ['bufu', 'media'],
    };
    expect(() => applyAction(state, fuse)).toThrow(/level 38/);
    // ...and it is never offered in the first place.
    expect(getLegalActions(state, 0).some((a) => a.type === 'FUSE')).toBe(false);
  });

  it('reaches further than a card played from hand, because it has paid more', () => {
    const state = unlockFusion(setupMatch());
    setField(state, 0, [{ cardId: 'jack-frost', level: 20, active: true }]);
    // The same board that could only PLAY a Lv 30 card can FUSE up to Lv 40.
    expect(playableLevelCap(state, 0)).toBe(30);
    expect(fusionLevelCap(state, 0)).toBe(40);
    expect(CONFIG.FUSION_LEVEL_GAP).toBeGreaterThan(CONFIG.PLAY_LEVEL_GAP);
  });

  it('reads the ceiling BEFORE the parents are sacrificed, so the ladder climbs', () => {
    // The Persona carrying the ceiling is usually one of the materials: a Lv 26
    // Chariot fed into Surt (46) is precisely the next rung of the ladder. Both
    // parents leave the field here, so if the ceiling were read afterwards —
    // against an empty board — this fusion could never happen.
    const state = unlockFusion(setupMatch());
    setField(state, 0, [
      { cardId: 'take-minakata', level: 26, active: true }, // Chariot, the ceiling
      { cardId: 'nekomata', level: 20 }, // Magician
    ]);
    expect(fusionLevelCap(state, 0)).toBe(46); // exactly Surt's level
    expect(canFuseInto(state, 0, 'surt')).toBe(true);

    const legal = getLegalActions(state, 0).filter((a) => a.type === 'FUSE' && a.result === 'surt');
    expect(legal.length).toBeGreaterThan(0);
    const after = applyAction(state, legal[0]);
    expect(activeOf(after, 0).cardId).toBe('surt');
    expect(activeOf(after, 0).level).toBe(46);
  });

  it('allows a result standing exactly on the ceiling', () => {
    const state = unlockFusion(setupMatch());
    // A Lv 10 board fuses up to exactly Lv 30 — Kikuri-Hime.
    setField(state, 0, [
      { cardId: 'sarasvati', level: 10, active: true },
      { cardId: 'jack-frost', level: 10 },
    ]);
    expect(fusionLevelCap(state, 0)).toBe(30);
    expect(canFuseInto(state, 0, 'kikuri-hime')).toBe(true);
    expect(canFuseInto(state, 0, 'titania')).toBe(false); // 33, one rung too far
  });

  it('tells the player which board they need, rather than blaming the materials', () => {
    const state = unlockFusion(setupMatch());
    setField(state, 0, [{ cardId: 'pixie', level: 3, active: true }]);
    const entry = describeFusions(state, 0).find((e) => e.recipe.result === 'black-frost');
    expect(entry.satisfiable).toBe(false);
    expect(entry.belowCurve).toBe(true);
    expect(entry.reason).toBe(`Needs a Lv ${38 - CONFIG.FUSION_LEVEL_GAP} Persona on your field`);
  });
});

describe('the opening fusion lock', () => {
  it('is shut before FUSION_FIRST_TURN and open from it', () => {
    const state = setupMatch();
    expect(state.turn).toBe(1);
    expect(fusionUnlocked(state)).toBe(false);

    for (let turn = 1; turn < CONFIG.FUSION_FIRST_TURN; turn++) {
      expect(fusionUnlocked({ ...state, turn })).toBe(false);
    }
    expect(fusionUnlocked({ ...state, turn: CONFIG.FUSION_FIRST_TURN })).toBe(true);
  });

  it('offers no fusion at all in the opening turns, however good the board is', () => {
    const state = setupMatch();
    // A board that would otherwise fuse on the spot.
    setField(state, 0, [
      { cardId: 'jack-frost', level: 20, active: true },
      { cardId: 'apsaras', level: 20 },
    ]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    state.turn = CONFIG.FUSION_FIRST_TURN - 1;

    expect(getLegalActions(state, 0).some((a) => a.type === 'FUSE')).toBe(false);
    expect(describeFusions(state, 0).every((e) => !e.satisfiable)).toBe(true);
    expect(describeFusions(state, 0)[0].reason).toBe(`Fusion opens on turn ${CONFIG.FUSION_FIRST_TURN}`);
    expect(() =>
      applyAction(state, {
        type: 'FUSE',
        player: 0,
        recipeId: 'fuse-black-frost',
        sacrifices: [
          { zone: 'field', uid: state.players[0].field[0].uid },
          { zone: 'field', uid: state.players[0].field[1].uid },
        ],
        inherit: ['bufu', 'media'],
      })
    ).toThrow(/not available until turn/);

    // ...and the same board one turn later is fine.
    const opened = { ...state, turn: CONFIG.FUSION_FIRST_TURN };
    expect(getLegalActions(opened, 0).some((a) => a.type === 'FUSE')).toBe(true);
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
    //
    // NOTE: the printed level is deliberately NOT checked against
    // DECK_MAX_PERSONA_LEVEL here. That cap governs deck GENERATION, and a
    // mid-match deck is not a generated one: a fusion result that is later fed
    // to the Gallows or fused again lands in the discard, and the discard is
    // reshuffled back into the deck when it runs dry. Drawing your own Lv 30
    // Kikuri-Hime back is the fusion payoff coming round again, and the play
    // ceiling below is what actually keeps it honest.
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
