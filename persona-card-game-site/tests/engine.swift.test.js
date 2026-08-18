/**
 * The Swift payoff: Momentum and Alacrity.
 *
 * Swift's identity is cheap and fast, but cheap and fast is only an identity if
 * it buys something. Momentum turns a cheap cast into a card; Alacrity turns a
 * knockdown into a free rotation. Both key off the light-skill tier, so they
 * move together with the SP curve.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, CONFIG, passiveOf, PASSIVE_DEFS } from '../src/engine/index.js';
import { SKILLS, getCard, PERSONAS } from '../src/data/cards.js';
import { ARCHETYPE_IDS, expandDeck } from '../src/data/archetypes.js';
import { setupMatch, setField, activeOf, endTurn } from './helpers.js';

const use = (skillId, player = 0, targetUid) => ({ type: 'USE_SKILL', player, skillId, targetUid });

describe('Momentum', () => {
  /** Jack Frost (Momentum, knows Bufu) against a Persona that survives it. */
  function board(cardId = 'jack-frost') {
    const state = setupMatch();
    setField(state, 0, [{ cardId, active: true }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
    state.players[0].deck = ['medicine', 'medicine', 'medicine', 'medicine'];
    state.players[0].hand = [];
    return state;
  }

  it('sits on two low-level Personas every flavour can draw', () => {
    const holders = PERSONAS.filter((p) => p.passive === 'momentum');
    expect(holders).toHaveLength(2);
    for (const holder of holders) {
      expect(holder.game).toBe('common');
      expect(holder.level).toBeLessThanOrEqual(10);
      expect(holder.affinity.swift).toBe(3);
    }
  });

  it('draws a card after a cheap skill', () => {
    let state = board();
    expect(passiveOf(activeOf(state, 0))).toBe('momentum');
    expect(SKILLS.bufu.spCost).toBeLessThanOrEqual(CONFIG.MOMENTUM_SP_THRESHOLD);

    state = applyAction(state, use('bufu'));

    expect(state.players[0].hand).toHaveLength(CONFIG.MOMENTUM_DRAW);
    expect(state.log.some((l) => l.text.includes('Momentum'))).toBe(true);
  });

  it('does not draw for an expensive skill', () => {
    let state = board();
    setField(state, 0, [{ cardId: 'jack-frost', active: true, level: 40, sp: 99, maxSp: 99 }]); // knows Bufudyne
    state.players[0].deck = ['medicine', 'medicine'];
    state.players[0].hand = [];
    expect(SKILLS.bufudyne.spCost).toBeGreaterThan(CONFIG.MOMENTUM_SP_THRESHOLD);

    state = applyAction(state, use('bufudyne'));

    expect(state.players[0].hand).toHaveLength(0);
  });

  it('draws once a turn, however many cheap skills fly', () => {
    let state = board();
    state = applyAction(state, use('bufu')); // One More is not granted (neutral), but...
    const afterFirst = state.players[0].hand.length;
    expect(state.turnState.momentumUsed).toBe(true);

    // Force a second action and cast again.
    state.turnState.actionsRemaining = 1;
    state = applyAction(state, use('bufu'));
    expect(state.players[0].hand).toHaveLength(afterFirst);
  });

  it('resets with the turn', () => {
    let state = board();
    state = applyAction(state, use('bufu'));
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(state.turnState.momentumUsed).toBe(false);
  });

  it('does nothing for a Persona without it', () => {
    let state = board('apsaras'); // Soul Battery, also knows Bufu
    state = applyAction(state, use('bufu'));
    expect(state.players[0].hand).toHaveLength(0);
  });
});

describe('Alacrity', () => {
  /** Pixie's Zio carries Alacrity; Apsaras is weak to elec. */
  function board({ hp = 900 } = {}) {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }, { cardId: 'silky' }]);
    setField(state, 1, [{ cardId: 'apsaras', active: true, hp, maxHp: hp }]);
    return state;
  }

  it('is printed on a few cheap skills and says so on the card', () => {
    const keyworded = Object.values(SKILLS).filter((s) => s.alacrity);
    expect(keyworded.length).toBeGreaterThanOrEqual(2);
    for (const skill of keyworded) {
      expect(skill.spCost ?? skill.hpCost).toBeLessThanOrEqual(CONFIG.MOMENTUM_SP_THRESHOLD + 2);
      expect(skill.description).toMatch(/Alacrity/);
    }
  });

  it('hands a change back on a knockdown, and nothing on a miss', () => {
    let state = board();
    const before = state.turnState.personaChangesRemaining;

    state = applyAction(state, use('zio'));

    // One More gives +1, Alacrity gives another +1 on top of it.
    expect(state.turnState.oneMoresGranted).toBe(1);
    expect(state.turnState.personaChangesRemaining).toBe(before + 1 + CONFIG.ALACRITY_REFUND);
    expect(state.log.some((l) => l.text.includes('Alacrity'))).toBe(true);
  });

  it('pays out even when the hit knocks nothing down', () => {
    // The whole point of the rework: Alacrity is the EXIT, and you need the exit
    // most on the turns the hit achieved nothing. It used to pay only on a
    // knockdown, which meant it only ever fired on turns that had already paid
    // you a One More — see the DESIGN NOTE in actions.js.
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]); // neutral to elec
    const before = state.turnState.personaChangesRemaining;

    state = applyAction(state, use('zio'));

    expect(state.turnState.oneMoresGranted).toBe(0); // nothing was knocked down
    expect(state.turnState.personaChangesRemaining).toBe(before + CONFIG.ALACRITY_REFUND);
    expect(state.log.some((l) => l.text.includes('Alacrity'))).toBe(true);
  });

  it('pays out against a target that RESISTS it', () => {
    // A resisted hit is the weakest outcome in the game and still buys the exit.
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'izanagi', active: true, hp: 900, maxHp: 900 }]); // resists elec
    const before = state.turnState.personaChangesRemaining;

    state = applyAction(state, use('zio'));

    expect(state.turnState.personaChangesRemaining).toBe(before + CONFIG.ALACRITY_REFUND);
  });

  it('pays out on a killing weakness hit too — it knocks down before it kills', () => {
    // Alacrity keys off the knockdown, and a lethal weakness hit now scores one:
    // the target is put on its back and only then taken off the board. So the
    // refund arrives exactly as it would have if the target had survived.
    let state = board({ hp: 1 });
    const before = state.turnState.personaChangesRemaining;
    state = applyAction(state, use('zio'));

    expect(state.players[1].field[0].ko).toBe(true);
    expect(state.turnState.personaChangesRemaining).toBe(before + 1 + CONFIG.ALACRITY_REFUND);
  });

  it('pays out on a killing hit that found no weakness', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 1, maxHp: 900 }]); // neutral to elec
    const before = state.turnState.personaChangesRemaining;

    state = applyAction(state, use('zio'));

    expect(state.players[1].field[0].ko).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(0); // no weakness, so no One More
    expect(state.turnState.personaChangesRemaining).toBe(before + CONFIG.ALACRITY_REFUND);
  });

  it('is the skill that pays, not the outcome — every use costs one action', () => {
    // Alacrity's only price is the action, and there is one of those per turn.
    // That is what stops it becoming an unbounded rotation engine.
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }, { cardId: 'jack-frost' }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);

    state = applyAction(state, use('zio'));
    expect(state.turnState.actionsRemaining).toBe(0);
    expect(state.turnState.personaChangesRemaining).toBe(1 + CONFIG.ALACRITY_REFUND - 0);

    // No action left, so the keyword cannot fire again however many changes remain.
    expect(getLegalActions(state, 0).some((a) => a.type === 'USE_SKILL')).toBe(false);
  });

  it('does not fire on a skill that lacks the keyword', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
    const before = state.turnState.personaChangesRemaining;

    // A basic attack: same damage pipeline, no keyword on it.
    state = applyAction(state, { type: 'ATTACK', player: 0 });

    expect(state.turnState.personaChangesRemaining).toBe(before);
    expect(state.log.some((l) => l.text.includes('Alacrity'))).toBe(false);
  });

  it('lets you actually rotate after the knockdown', () => {
    let state = board();
    state = applyAction(state, use('zio'));
    const bench = state.players[0].field[1];
    expect(getLegalActions(state, 0).some((a) => a.type === 'CHANGE_ACTIVE' && a.targetUid === bench.uid)).toBe(true);
    expect(() => applyAction(state, { type: 'CHANGE_ACTIVE', player: 0, targetUid: bench.uid })).not.toThrow();
  });
});

describe('Swift decks get the tools', () => {
  const swiftDeck = (seed) => expandDeck('p3', { archetype: 'swift', seed });

  it('runs more free-to-play cards than a Defensive deck does', () => {
    const freeCount = (cards) =>
      cards.filter((id) => {
        const card = getCard(id);
        return card.type !== 'persona' && !card.usesAction;
      }).length;

    let swift = 0;
    let defensive = 0;
    for (let seed = 1; seed <= 20; seed++) {
      swift += freeCount(swiftDeck(seed));
      defensive += freeCount(expandDeck('p3', { archetype: 'defensive', seed }));
    }
    expect(swift).toBeGreaterThan(defensive);
  });

  it('leans on the cards that make it go: Baton Pass, Fortune\'s Draw, Momentum bodies', () => {
    for (const id of ['baton-pass', 'fortunes-draw']) {
      expect(getCard(id).affinity.swift).toBe(3);
    }
    let momentumBodies = 0;
    for (let seed = 1; seed <= 20; seed++) {
      momentumBodies += swiftDeck(seed).filter((id) => getCard(id).passive === 'momentum').length;
    }
    expect(momentumBodies).toBeGreaterThan(0);
  });

  it('keeps Momentum out of the legal action list — it is never a choice', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'jack-frost', active: true }]);
    for (const action of getLegalActions(state, 0)) {
      expect(action.type).not.toMatch(/MOMENTUM|ALACRITY/i);
    }
    expect(PASSIVE_DEFS.momentum.onSkillUsed).toBeTypeOf('function');
  });
});
