/**
 * Drain skills.
 *
 * These are SKILLS, not affinities — there is no "drain fire" reaction anywhere
 * in the game and this file exists partly to keep it that way. Both are
 * Almighty, so neither has a weakness, resist or Technical interaction to
 * argue about; what they do have is caps, and caps are what get tested.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, applyAilment, getLegalActions } from '../src/engine/index.js';
import { SKILLS, PERSONAS } from '../src/data/cards.js';
import { setupMatch, setField, activeOf, uidOf } from './helpers.js';

function board({ mine = 'incubus', theirs = 'silky', myHp = null, mySp = null, theirSp = null } = {}) {
  const state = setupMatch({ seed: 2468 });
  setField(state, 0, [{ cardId: mine, level: 20, active: true }]);
  setField(state, 1, [{ cardId: theirs, level: 20, active: true }]);
  state.players[0].hand = [];
  state.players[1].hand = [];
  const me = activeOf(state, 0);
  if (myHp !== null) me.hp = myHp;
  if (mySp !== null) me.sp = mySp;
  if (theirSp !== null) activeOf(state, 1).sp = theirSp;
  return state;
}

const cast = (state, skillId, targetCardId = 'silky') =>
  applyAction(state, { type: 'USE_SKILL', player: 0, skillId, targetUid: uidOf(state, 1, targetCardId) });

describe('the data', () => {
  it('adds no drain affinities — only skills', () => {
    for (const persona of PERSONAS) {
      for (const list of ['weaknesses', 'resists']) {
        expect(persona[list], `${persona.name} ${list}`).not.toContain('drain');
        expect(persona[list], `${persona.name} ${list}`).not.toContain('repel');
      }
    }
  });

  it('makes both drains Almighty, so neither reacts to an affinity chart', () => {
    expect(SKILLS['life-drain'].type).toBe('almighty');
    expect(SKILLS['spirit-drain'].type).toBe('almighty');
  });

  it('gives each one a deck-legal holder', () => {
    const holders = (skillId) =>
      PERSONAS.filter((p) => !p.fusionOnly && p.skills.some((s) => s.id === skillId)).map((p) => p.id);
    expect(holders('life-drain')).toContain('incubus');
    expect(holders('spirit-drain')).toContain('mothman');
  });
});

describe('Life Drain', () => {
  it('heals the attacker for exactly the damage it dealt', () => {
    const state = board({ myHp: 10 });
    const theirHpBefore = activeOf(state, 1).hp;

    const next = cast(state, 'life-drain');
    const dealt = theirHpBefore - activeOf(next, 1).hp;
    expect(dealt).toBe(Math.round(theirHpBefore * SKILLS['life-drain'].effect.percentOfTargetHp));
    expect(activeOf(next, 0).hp).toBe(10 + dealt);
  });

  it("never heals past the attacker's own ceiling", () => {
    const state = board(); // starts at full HP
    const full = activeOf(state, 0).maxHp;
    const next = cast(state, 'life-drain');
    expect(activeOf(next, 0).hp).toBe(full);
  });

  it('heals nothing when it dealt nothing', () => {
    // Moonless Gown makes the target untouchable, so there is nothing to drain.
    const state = board({ myHp: 10 });
    activeOf(state, 1).warded = true;
    const next = cast(state, 'life-drain');
    expect(activeOf(next, 0).hp).toBe(10);
  });

  it('takes a share of what is LEFT, so it can never land a knockout', () => {
    const state = board({ myHp: 10 });
    activeOf(state, 1).hp = 4;
    const next = cast(state, 'life-drain');

    // 20% of 4 rounds to 1: the target survives on 3 and the user gains 1.
    expect(next.players[1].field[0].ko).toBe(false);
    expect(activeOf(next, 1).hp).toBe(3);
    expect(activeOf(next, 0).hp).toBe(11);
  });

  it('scales with the target, not with the attacker', () => {
    const share = SKILLS['life-drain'].effect.percentOfTargetHp;
    for (const hp of [200, 100, 50]) {
      const state = board({ myHp: 10 });
      activeOf(state, 1).maxHp = hp;
      activeOf(state, 1).hp = hp;
      const next = cast(state, 'life-drain');
      expect(activeOf(next, 1).hp).toBe(hp - Math.round(hp * share));
      expect(activeOf(next, 0).hp).toBe(10 + Math.round(hp * share));
    }
  });

  it('ignores weakness and Technicals, being Almighty', () => {
    const plain = cast(board(), 'life-drain');
    const plainDealt = activeOf(board(), 1).hp - activeOf(plain, 1).hp;

    const burned = board();
    applyAilment(burned, activeOf(burned, 1), 'burn');
    const after = cast(burned, 'life-drain');
    expect(activeOf(burned, 1).hp - activeOf(after, 1).hp).toBe(plainDealt);
    expect(after.log.some((e) => e.kind === 'technical')).toBe(false);
  });
});

describe('Spirit Drain', () => {
  const drain = SKILLS['spirit-drain'];

  it('moves SP across and deals no damage at all', () => {
    // Exactly enough SP to cast it, and nothing more.
    const state = board({ mine: 'mothman', mySp: drain.spCost, theirSp: 30 });
    const theirHp = activeOf(state, 1).hp;

    const next = cast(state, 'spirit-drain');
    expect(activeOf(next, 1).hp).toBe(theirHp);
    expect(activeOf(next, 1).sp).toBe(30 - drain.effect.amount);
    // Paid the cost, took the full amount, and started from empty.
    expect(activeOf(next, 0).sp).toBe(drain.effect.amount);
  });

  it("is capped by the target's current SP", () => {
    const state = board({ mine: 'mothman', mySp: 20, theirSp: 2 });
    const next = cast(state, 'spirit-drain');
    expect(activeOf(next, 1).sp).toBe(0);
    expect(activeOf(next, 0).sp).toBe(20 - drain.spCost + 2);
  });

  it('takes the SP even when the thief cannot hold it', () => {
    const state = board({ mine: 'mothman', theirSp: 30 });
    const me = activeOf(state, 0);
    me.sp = me.maxSp; // full: only the cost frees up room
    const next = cast(state, 'spirit-drain');

    expect(activeOf(next, 1).sp).toBe(30 - drain.effect.amount); // denied regardless
    expect(activeOf(next, 0).sp).toBe(me.maxSp); // topped straight back up, no further
    expect(next.log.some((e) => e.text.includes('could only hold'))).toBe(true);
  });

  it('is not offered against a target with no SP', () => {
    const state = board({ mine: 'mothman', theirSp: 0 });
    const offers = getLegalActions(state, 0).filter((a) => a.skillId === 'spirit-drain');
    expect(offers).toHaveLength(0);
    expect(() => cast(state, 'spirit-drain')).toThrow(/no SP left to take/);
  });

  it('comes out well ahead on SP, which is what it costs an action for', () => {
    expect(drain.spCost).toBe(1);
    expect(drain.effect.amount - drain.spCost).toBe(5);
    expect(drain.description).toContain('net gain of 5');
  });
});

describe('determinism', () => {
  it('spends no randomness — the same board drains identically', () => {
    const a = cast(board({ myHp: 10 }), 'life-drain');
    const b = cast(board({ myHp: 10 }), 'life-drain');
    expect(activeOf(a, 0).hp).toBe(activeOf(b, 0).hp);
    expect(activeOf(a, 1).hp).toBe(activeOf(b, 1).hp);

    const c = cast(board({ mine: 'mothman', mySp: 5, theirSp: 20 }), 'spirit-drain');
    const d = cast(board({ mine: 'mothman', mySp: 5, theirSp: 20 }), 'spirit-drain');
    expect(activeOf(c, 0).sp).toBe(activeOf(d, 0).sp);
    expect(c.rng).toEqual(d.rng);
  });
});
