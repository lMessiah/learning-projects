import { describe, it, expect } from 'vitest';
import {
  createMatch,
  applyAction,
  getLegalActions,
  evaluateGameEnd,
  createRng,
  nextInt,
  CONFIG,
} from '../src/engine/index.js';
import { setupMatch, setField, setHand, activeOf, endTurn } from './helpers.js';

describe('match setup', () => {
  it('offers each player a choice of 3 weak starters', () => {
    const state = createMatch({ seed: 7, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p5' }] });
    expect(state.phase).toBe('starterSelect');
    for (const options of state.starterOptions) {
      expect(options).toHaveLength(3);
      expect(new Set(options).size).toBe(3);
    }
    expect(getLegalActions(state, 0)).toHaveLength(3);
  });

  it('refuses a starter that was not offered', () => {
    const state = createMatch({ seed: 7, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p5' }] });
    const notOffered = ['pixie', 'jack-frost', 'apsaras', 'orpheus', 'izanagi', 'arsene', 'ara-mitama', 'angel'].find(
      (id) => !state.starterOptions[0].includes(id)
    );
    expect(() => applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: notOffered })).toThrow(/not offered/);
  });

  it('deals opening hands and starts play once both have chosen', () => {
    const state = setupMatch();
    expect(state.phase).toBe('playing');
    expect(state.activePlayer).toBe(0);
    // 5 opening + 1 for the first turn's draw
    expect(state.players[0].hand).toHaveLength(CONFIG.OPENING_HAND + CONFIG.DRAW_PER_TURN);
    expect(state.players[1].hand).toHaveLength(CONFIG.OPENING_HAND);
    expect(state.players[0].field).toHaveLength(1);
  });

  it('alternates turns strictly', () => {
    let state = setupMatch();
    const order = [];
    for (let i = 0; i < 4; i++) {
      order.push(state.activePlayer);
      state = endTurn(state);
    }
    expect(order).toEqual([0, 1, 0, 1]);
  });
});

describe('win condition', () => {
  it('ends the match when a player loses KO_TARGET Personas', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'apsaras', active: true, hp: 1 }]);
    state.players[1].koCount = CONFIG.KO_TARGET - 1;

    expect(state.winner).toBe(null);
    state = applyAction(state, { type: 'ATTACK', player: 0 });

    expect(state.players[1].koCount).toBe(CONFIG.KO_TARGET);
    expect(state.winner).toBe(0);
    expect(state.phase).toBe('gameOver');
    expect(state.endReason).toBe('ko-target');
  });

  it('refuses further actions once the match is over', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'apsaras', active: true, hp: 1 }]);
    state.players[1].koCount = CONFIG.KO_TARGET - 1;
    state = applyAction(state, { type: 'ATTACK', player: 0 });

    expect(getLegalActions(state, 0)).toEqual([]);
    expect(() => applyAction(state, { type: 'PASS', player: 0 })).toThrow(/already over/);
  });

  it('does not reduce the KO tally when a Persona is revived', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }, { cardId: 'apsaras' }]);
    setField(state, 1, [{ cardId: 'jack-frost', active: true }]);

    const fallen = state.players[0].field[1];
    fallen.ko = true;
    fallen.hp = 0;
    state.players[0].koCount = 3;

    setHand(state, 0, ['revival-bead']);
    state = applyAction(state, {
      type: 'PLAY_ITEM',
      player: 0,
      handUid: state.players[0].hand[0].uid,
      targetUid: fallen.uid,
    });

    const revived = state.players[0].field.find((p) => p.uid === fallen.uid);
    expect(revived.ko).toBe(false);
    expect(revived.hp).toBe(Math.round(revived.maxHp * 0.5));
    expect(state.players[0].koCount).toBe(3); // the tally is untouched
  });
});

describe('simultaneous KO', () => {
  /** Both players are at the KO target at the same moment. */
  function mutualEnd({ hp0, hp1 }) {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true, hp: hp0 }]);
    setField(state, 1, [{ cardId: 'pixie', active: true, hp: hp1 }]);
    state.players[0].koCount = CONFIG.KO_TARGET;
    state.players[1].koCount = CONFIG.KO_TARGET;
    return state;
  }

  it('counts both KOs and awards the win on higher total remaining HP', () => {
    const state = evaluateGameEnd(mutualEnd({ hp0: 30, hp1: 10 }));
    expect(state.winner).toBe(0);
    expect(state.endReason).toBe('simultaneous-ko-hp');

    const other = evaluateGameEnd(mutualEnd({ hp0: 5, hp1: 25 }));
    expect(other.winner).toBe(1);
  });

  it('totals HP across every surviving Persona, not just the active one', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true, hp: 10 }, { cardId: 'pixie', hp: 10 }]);
    setField(state, 1, [{ cardId: 'pixie', active: true, hp: 15 }]);
    state.players[0].koCount = CONFIG.KO_TARGET;
    state.players[1].koCount = CONFIG.KO_TARGET;

    expect(evaluateGameEnd(state).winner).toBe(0); // 20 vs 15
  });

  it('goes to sudden death when remaining HP is tied, and the next KO wins it', () => {
    let state = evaluateGameEnd(mutualEnd({ hp0: 20, hp1: 20 }));
    expect(state.winner).toBe(null);
    expect(state.suddenDeath).toEqual({ koAt: [CONFIG.KO_TARGET, CONFIG.KO_TARGET] });
    expect(state.log.some((l) => l.text.includes('SUDDEN DEATH'))).toBe(true);

    // Player 1 loses the next Persona, so player 0 takes it.
    state.players[1].koCount += 1;
    state = evaluateGameEnd(state);
    expect(state.winner).toBe(0);
    expect(state.endReason).toBe('sudden-death');
  });

  it('stays in sudden death if the next KOs are also simultaneous', () => {
    let state = evaluateGameEnd(mutualEnd({ hp0: 20, hp1: 20 }));
    state.players[0].koCount += 1;
    state.players[1].koCount += 1;
    state = evaluateGameEnd(state);
    expect(state.winner).toBe(null);
  });
});

describe('deck out and fatigue', () => {
  function emptyDeck(state, playerId, discard = ['medicine', 'bead']) {
    state.players[playerId].deck = [];
    state.players[playerId].discard = [...discard];
    return state;
  }

  it('reshuffles the discard back in and adds a Fatigue stack', () => {
    let state = setupMatch();
    emptyDeck(state, 0);
    expect(state.players[0].fatigue).toBe(0);

    state = applyAction(state, { type: 'PASS', player: 0 });

    expect(state.players[0].fatigue).toBe(1);
    expect(state.players[0].discard).toHaveLength(0);
    expect(state.players[0].deck).toHaveLength(1); // 2 reshuffled, 1 drawn
    expect(state.log.some((l) => l.kind === 'fatigue')).toBe(true);
  });

  it('damages all of that player\'s Personas each turn, scaling with the stacks', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'unicorn', active: true }, { cardId: 'unicorn' }]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    const startHp = state.players[0].field.map((p) => p.hp);

    state.players[0].fatigue = 1;
    state.players[0].deck = ['medicine'];
    state = endTurn(state, 0);
    state = endTurn(state, 1);

    expect(state.players[0].field.map((p) => p.hp)).toEqual(startHp.map((hp) => hp - CONFIG.FATIGUE_DAMAGE));

    // A second stack doubles the bite.
    state.players[0].fatigue = 2;
    state.players[0].deck = ['medicine'];
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(state.players[0].field[0].hp).toBe(startHp[0] - CONFIG.FATIGUE_DAMAGE * 3);
  });

  it('leaves the opponent untouched', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'unicorn', active: true }]);
    setField(state, 1, [{ cardId: 'unicorn', active: true }]);
    const enemyHp = state.players[1].field[0].hp;

    state.players[0].fatigue = 2;
    state.players[0].deck = ['medicine'];
    state = endTurn(state, 0);
    state = endTurn(state, 1);

    expect(state.players[1].field[0].hp).toBe(enemyHp);
  });

  it('fizzles the draw harmlessly when both deck and discard are empty', () => {
    let state = setupMatch();
    state.players[0].deck = [];
    state.players[0].discard = [];
    const handSize = state.players[0].hand.length;

    state = applyAction(state, { type: 'PASS', player: 0 });
    expect(state.players[0].hand).toHaveLength(handSize);
    expect(state.players[0].fatigue).toBe(0);
  });
});

describe('legal actions', () => {
  it('always leaves a player something to do', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true, sp: 0, hp: 1 }]);
    setHand(state, 0, []);

    const legal = getLegalActions(state, 0);
    expect(legal.some((a) => a.type === 'PASS')).toBe(true);
    expect(legal.some((a) => a.type === 'END_TURN')).toBe(true);
  });

  it('returns nothing for the player who is not on turn', () => {
    const state = setupMatch();
    expect(getLegalActions(state, 1)).toEqual([]);
  });

  it('flags an END_TURN that still needs discard choices', () => {
    const state = setupMatch();
    setHand(state, 0, Array(10).fill('medicine'));
    const endAction = getLegalActions(state, 0).find((a) => a.type === 'END_TURN');
    expect(endAction.needsChoice).toBe(true);
    expect(endAction.discardCount).toBe(3);
    expect(endAction.discard).toHaveLength(3);
  });

  it('produces only actions the reducer accepts', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'orpheus', active: true }, { cardId: 'pixie' }]);
    setField(state, 1, [{ cardId: 'jack-frost', active: true, hp: 400, maxHp: 400 }]);
    setHand(state, 0, ['medicine', 'concentrate', 'pixie', 'snuff-soul']);
    activeOf(state, 0).hp = 20;

    for (const action of getLegalActions(state, 0)) {
      expect(() => applyAction(state, action)).not.toThrow();
    }
  });
});

describe('full playthrough', () => {
  /** Drive a whole match with seeded random legal moves. */
  function playRandomMatch(seed, { maxTurns = 500 } = {}) {
    let rng = createRng(seed);
    const pick = (list) => {
      const [index, next] = nextInt(rng, list.length);
      rng = next;
      return list[index];
    };

    let state = createMatch({ seed, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p4' }] });
    for (const player of [0, 1]) {
      state = applyAction(state, pick(getLegalActions(state, player)));
    }

    let steps = 0;
    while (state.winner === null && state.turn <= maxTurns && steps < 20000) {
      // Resigning is legal every turn, and a random player who concedes on
      // turn three is not testing that a match can be played to a finish.
      const legal = getLegalActions(state, state.activePlayer).filter((a) => a.type !== 'RESIGN');
      expect(legal.length).toBeGreaterThan(0);
      // Bias away from ending the turn so turns actually do something.
      const nonEnd = legal.filter((a) => a.type !== 'END_TURN');
      const action = nonEnd.length && steps % 3 !== 2 ? pick(nonEnd) : legal.find((a) => a.type === 'END_TURN');
      state = applyAction(state, action);
      steps += 1;
    }
    return state;
  }

  it('plays several seeded matches to a decisive finish without ever getting stuck', () => {
    for (const seed of [1, 2, 3, 7, 99]) {
      const state = playRandomMatch(seed);
      expect(state.winner).not.toBe(null);
      expect(state.phase).toBe('gameOver');
      expect(state.players[state.winner === 0 ? 1 : 0].koCount).toBeGreaterThanOrEqual(CONFIG.KO_TARGET);
    }
  });

  it('keeps every Persona\'s HP and SP within bounds throughout', () => {
    const state = playRandomMatch(2024);
    for (const player of state.players) {
      for (const persona of player.field) {
        expect(persona.hp).toBeGreaterThanOrEqual(0);
        expect(persona.hp).toBeLessThanOrEqual(persona.maxHp);
        expect(persona.sp).toBeGreaterThanOrEqual(0);
        expect(persona.sp).toBeLessThanOrEqual(persona.maxSp);
        expect(persona.buffs.length).toBeLessThanOrEqual(2); // at most one per stat
      }
    }
    // The hand limit is enforced when a turn ends, so only the player who is
    // not mid-turn is guaranteed to be at or under it.
    const waiting = state.players[state.activePlayer === 0 ? 1 : 0];
    expect(waiting.hand.length).toBeLessThanOrEqual(CONFIG.HAND_LIMIT);
  });
});

describe('purity and determinism', () => {
  it('never mutates the state it was given', () => {
    const state = setupMatch();
    const snapshot = JSON.stringify(state);
    applyAction(state, { type: 'ATTACK', player: 0 });
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('produces identical matches from identical seeds', () => {
    const play = (seed) => {
      let state = createMatch({ seed, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p5' }] });
      state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
      state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
      for (let i = 0; i < 6; i++) state = endTurn(state);
      return state;
    };
    expect(JSON.stringify(play(1234))).toBe(JSON.stringify(play(1234)));
    expect(JSON.stringify(play(1234))).not.toBe(JSON.stringify(play(9999)));
  });

  it('keeps all randomness inside the state\'s RNG', () => {
    const state = setupMatch();
    const before = state.rng.s;
    const after = applyAction(state, { type: 'PASS', player: 0 });
    expect(typeof after.rng.s).toBe('number');
    expect(state.rng.s).toBe(before); // the source state is untouched
  });

  it('rejects unknown action types', () => {
    expect(() => applyAction(setupMatch(), { type: 'NONSENSE', player: 0 })).toThrow(/Unknown action type/);
  });
});
