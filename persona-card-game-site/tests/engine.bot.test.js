import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, createRng, createMatch, CONFIG } from '../src/engine/index.js';
import { chooseBotAction, planBotTurn, explainBotActions, DIFFICULTIES } from '../src/engine/bot.js';
import { setupMatch, setField, setHand, activeOf } from './helpers.js';

const ALL = DIFFICULTIES.map((d) => d.id);

/** Bot is player 1; its Zio would hit a revealed Pixie weakness... except Pixie resists elec. */
function botBoard() {
  const state = setupMatch();
  state.activePlayer = 1;
  state.turnState = { ...state.turnState, actionsRemaining: 1 };
  setField(state, 0, [{ cardId: 'jack-frost', active: true, hp: 400, maxHp: 400 }]); // weak fire
  setField(state, 1, [{ cardId: 'orpheus', active: true }]); // knows Agi (fire) and Bash (phys)
  setHand(state, 1, []);
  return state;
}

describe('bot basics', () => {
  it('only ever returns actions the engine considers legal', () => {
    for (const difficulty of ALL) {
      let state = setupMatch();
      let rng = createRng(11);
      for (let i = 0; i < 40 && state.winner === null; i++) {
        const playerId = state.activePlayer;
        const legal = getLegalActions(state, playerId);
        const [action, next] = chooseBotAction(state, playerId, difficulty, rng);
        rng = next;
        expect(legal).toContainEqual(action);
        state = applyAction(state, action);
      }
    }
  });

  it('is deterministic for a given RNG', () => {
    const state = botBoard();
    for (const difficulty of ALL) {
      const [a] = chooseBotAction(state, 1, difficulty, createRng(5));
      const [b] = chooseBotAction(state, 1, difficulty, createRng(5));
      expect(a).toEqual(b);
    }
  });

  it('never mutates the state it is reasoning about', () => {
    const state = botBoard();
    const snapshot = JSON.stringify(state);
    for (const difficulty of ALL) chooseBotAction(state, 1, difficulty, createRng(3));
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('plays a whole turn and finishes it with END_TURN', () => {
    for (const difficulty of ALL) {
      const { actions } = planBotTurn(botBoard(), 1, difficulty, createRng(9), applyAction);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions[actions.length - 1].type).toBe('END_TURN');
    }
  });
});

describe('hidden information', () => {
  it('Brutal aims at an undiscovered weakness; Medium does not', () => {
    const state = botBoard(); // Jack Frost is weak to fire, nothing revealed yet
    expect(activeOf(state, 0).revealedTypes).toEqual([]);

    const [brutal] = chooseBotAction(state, 1, 'brutal', createRng(4));
    expect(brutal).toMatchObject({ type: 'USE_SKILL', skillId: 'agi' });

    // Medium cannot know, so it just picks its biggest expected hit. Orpheus's
    // Bash (power 40) beats Agi (power 38) on neutral maths.
    const [medium] = chooseBotAction(state, 1, 'medium', createRng(4));
    expect(medium).toMatchObject({ type: 'USE_SKILL', skillId: 'bash' });
  });

  it('Medium switches to the weakness once it has been discovered', () => {
    const state = botBoard();
    activeOf(state, 0).revealedTypes.push('fire');
    const [medium] = chooseBotAction(state, 1, 'medium', createRng(4));
    expect(medium).toMatchObject({ type: 'USE_SKILL', skillId: 'agi' });
  });

  it('Easy never deliberately aims at a weakness, even a revealed one', () => {
    const state = botBoard();
    activeOf(state, 0).revealedTypes.push('fire');

    // Across many seeds Easy should spread its picks, not lock onto Agi.
    const picks = new Set();
    for (let seed = 1; seed <= 30; seed++) {
      const [action] = chooseBotAction(state, 1, 'easy', createRng(seed));
      picks.add(`${action.type}:${action.skillId ?? ''}`);
    }
    expect(picks.size).toBeGreaterThan(2);
  });
});

describe('heuristics', () => {
  it('Medium heals a Persona that has dropped under 30% HP', () => {
    const state = botBoard();
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 10 }]); // 10/48 ≈ 21%
    setHand(state, 1, ['medicine']);

    const [action] = chooseBotAction(state, 1, 'medium', createRng(2));
    expect(action.type).toBe('PLAY_ITEM');
    expect(action.cardId).toBe('medicine');
  });

  it('does not waste healing on a healthy Persona', () => {
    const state = botBoard();
    setHand(state, 1, ['medicine']);
    const [action] = chooseBotAction(state, 1, 'medium', createRng(2));
    expect(action.type).not.toBe('PLAY_ITEM');
  });

  it('puts a Persona out when the board is nearly empty', () => {
    const state = botBoard();
    setHand(state, 1, ['pixie']);
    const [action] = chooseBotAction(state, 1, 'medium', createRng(2));
    expect(action).toMatchObject({ type: 'PLAY_PERSONA', cardId: 'pixie' });
  });

  it('reaches for the finishing blow when one is available', () => {
    const state = botBoard();
    setField(state, 0, [{ cardId: 'jack-frost', active: true, hp: 3 }]);
    for (const difficulty of ['medium', 'brutal']) {
      const [action] = chooseBotAction(state, 1, difficulty, createRng(6));
      expect(['ATTACK', 'USE_SKILL']).toContain(action.type);
    }
  });

  it('Brutal spends its One More instead of ending the turn', () => {
    let state = botBoard();
    const [first] = chooseBotAction(state, 1, 'brutal', createRng(4));
    state = applyAction(state, first);

    expect(state.turnState.oneMoreUsed).toBe(true);
    expect(state.turnState.actionsRemaining).toBe(1);

    const [second] = chooseBotAction(state, 1, 'brutal', createRng(4));
    expect(second.type).not.toBe('END_TURN');
  });

  it('Brutal strips an enemy\'s buffs with Dekaja during its turn', () => {
    const state = botBoard();
    activeOf(state, 0).buffs.push({ stat: 'atk', direction: 'up', turnsLeft: 3 });
    activeOf(state, 0).buffs.push({ stat: 'def', direction: 'up', turnsLeft: 3 });
    setHand(state, 1, ['dekaja']);

    // It leads with the weakness hit (that One More is worth more than a
    // dispel), but Dekaja costs no action, so it still gets played.
    const { actions } = planBotTurn(state, 1, 'brutal', createRng(2), applyAction);
    expect(actions.some((a) => a.type === 'PLAY_SPECIAL' && a.cardId === 'dekaja')).toBe(true);
  });

  it('Brutal retreats a shocked active Persona', () => {
    const state = botBoard();
    setField(state, 1, [{ cardId: 'orpheus', active: true }, { cardId: 'unicorn' }]);
    activeOf(state, 1).ailments.push({ type: 'shock', turnsLeft: 1 });

    const [action] = chooseBotAction(state, 1, 'brutal', createRng(2));
    expect(action.type).toBe('CHANGE_ACTIVE');
  });

  it('Chaos leans toward the biggest hit without committing to it', () => {
    const state = botBoard();
    activeOf(state, 0).revealedTypes.push('fire');
    const counts = {};
    for (let seed = 1; seed <= 60; seed++) {
      const [action] = chooseBotAction(state, 1, 'chaos', createRng(seed));
      const key = `${action.type}:${action.skillId ?? ''}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    // Agi (x2 on the weakness) should be the most common pick, but not the only one.
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    expect(entries[0][0]).toBe('USE_SKILL:agi');
    expect(entries.length).toBeGreaterThan(1);
  });
});

describe('passivity', () => {
  it('never passes or ends the turn while a legal attack is available', () => {
    for (const difficulty of ALL) {
      const state = botBoard();
      for (let seed = 1; seed <= 40; seed++) {
        const [action] = chooseBotAction(state, 1, difficulty, createRng(seed));
        expect(['PASS', 'END_TURN']).not.toContain(action.type);
      }
    }
  });

  it('never picks PASS while anything productive is legal', () => {
    for (const difficulty of ALL) {
      const state = botBoard();
      setHand(state, 1, ['medicine', 'concentrate', 'pixie']);
      for (let seed = 1; seed <= 40; seed++) {
        const [action] = chooseBotAction(state, 1, difficulty, createRng(seed));
        expect(action.type).not.toBe('PASS');
      }
    }
  });

  it('still passes when passing is genuinely the only option', () => {
    for (const difficulty of ALL) {
      const state = botBoard();
      // Shocked active cannot act, no bench, no hand: PASS and END_TURN only.
      setField(state, 1, [{ cardId: 'orpheus', active: true }]);
      activeOf(state, 1).ailments.push({ type: 'shock', turnsLeft: 1 });
      setHand(state, 1, []);

      // RESIGN is legal on every turn of every match; the bot never sees it.
      const legal = getLegalActions(state, 1).map((a) => a.type);
      expect(new Set(legal)).toEqual(new Set(['PASS', 'RESIGN', 'END_TURN']));

      const [action] = chooseBotAction(state, 1, difficulty, createRng(3));
      expect(['PASS', 'END_TURN']).toContain(action.type);
    }
  });

  it('measures near-zero passive turns across whole matches', () => {
    // The regression this guards: Easy passed on ~14% of its turns and Chaos
    // on ~1.5%, because PASS/END_TURN sat in their random pools.
    for (const difficulty of ALL) {
      let passive = 0;
      let choices = 0;

      for (let seed = 1; seed <= 4; seed++) {
        let state = createMatch({ seed, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p5' }] });
        let rng = createRng(seed * 7 + 1);

        for (let steps = 0; state.winner === null && state.turn <= 200 && steps < 6000; steps++) {
          const pid = state.phase === 'starterSelect'
            ? state.players.findIndex((p) => p.field.length === 0)
            : state.activePlayer;
          const legal = getLegalActions(state, pid);
          const [action, next] = chooseBotAction(state, pid, difficulty, rng);
          rng = next;
          if (!action) break;

          if (state.phase === 'playing') {
            choices += 1;
            const canAttack = legal.some((a) => a.type === 'ATTACK' || a.type === 'USE_SKILL');
            const gaveUp = action.type === 'PASS' || (action.type === 'END_TURN' && state.turnState.actionsRemaining > 0);
            if (canAttack && gaveUp) passive += 1;
          }
          state = applyAction(state, action);
        }
      }
      expect(choices).toBeGreaterThan(100);
      expect(passive).toBe(0);
    }
  });

  it('explains its scoring for debugging', () => {
    const scored = explainBotActions(botBoard(), 1, 'brutal');
    expect(scored.length).toBeGreaterThan(1);
    expect(scored[0].score).toBeGreaterThanOrEqual(scored[scored.length - 1].score);
    expect(scored[0]).toHaveProperty('action.type');
    // The weakness hit should outrank giving up the turn.
    const pass = scored.find((s) => s.action.type === 'PASS');
    expect(scored[0].score).toBeGreaterThan(pass.score);
  });
});

describe('full bot-vs-bot matches', () => {
  function playOut(seed, d0, d1, maxTurns = 400) {
    let state = createMatch({ seed, players: [{ name: d0, deckId: 'p3' }, { name: d1, deckId: 'p5' }] });
    let rng = createRng(seed * 7 + 1);
    const difficultyOf = (id) => (id === 0 ? d0 : d1);

    for (let steps = 0; state.winner === null && state.turn <= maxTurns && steps < 12000; steps++) {
      const playerId = state.phase === 'starterSelect'
        ? state.players.findIndex((p) => p.field.length === 0)
        : state.activePlayer;
      const [action, next] = chooseBotAction(state, playerId, difficultyOf(playerId), rng);
      rng = next;
      if (!action) break;
      state = applyAction(state, action);
    }
    return state;
  }

  it('runs every difficulty pairing to a clean finish', () => {
    const pairings = [
      ['easy', 'brutal'],
      ['medium', 'medium'],
      ['chaos', 'medium'],
      ['brutal', 'chaos'],
    ];
    for (const [i, [a, b]] of pairings.entries()) {
      const state = playOut(100 + i, a, b);
      expect(state.winner).not.toBe(null);
      expect(state.phase).toBe('gameOver');
      expect(state.players[state.winner === 0 ? 1 : 0].koCount).toBeGreaterThanOrEqual(CONFIG.KO_TARGET);
    }
  });

  it('Brutal beats Easy across a run of matches', () => {
    let brutalWins = 0;
    const games = 8;
    for (let seed = 1; seed <= games; seed++) {
      // Brutal is player 1, so it moves second.
      const state = playOut(seed * 31, 'easy', 'brutal');
      if (state.winner === 1) brutalWins += 1;
    }
    expect(brutalWins).toBeGreaterThanOrEqual(Math.ceil(games * 0.7));
  });
});
