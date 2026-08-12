import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, personaSkills, CONFIG } from '../src/engine/index.js';
import { getPersona } from '../src/data/cards.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, unlockFusion } from './helpers.js';

/** Player 0's Pixie is about to finish off a 1 HP victim with a basic attack. */
function killShot({ killer = { cardId: 'pixie' }, victimCardId = 'apsaras' }) {
  const state = setupMatch();
  setField(state, 0, [{ ...killer, active: true }]);
  setField(state, 1, [{ cardId: victimCardId, active: true, hp: 1 }, { cardId: 'pixie' }]);
  return state;
}

describe('levelling', () => {
  it('gives the killer +1 level for a normal knockout', () => {
    // Pixie Lv3 kills Apsaras Lv5 — the gap is under +3, so +1 level.
    const state = applyAction(killShot({ victimCardId: 'apsaras' }), { type: 'ATTACK', player: 0 });
    expect(activeOf(state, 0).level).toBe(4);
  });

  it('gives +2 levels when the victim outranks the killer by 3 or more', () => {
    // Pixie Lv3 kills Jack Frost Lv6 — exactly the +3 threshold.
    const state = applyAction(killShot({ victimCardId: 'jack-frost' }), { type: 'ATTACK', player: 0 });
    expect(activeOf(state, 0).level).toBe(3 + 2);
    expect(CONFIG.LEVEL_UP_GAP).toBe(3);
  });

  it('applies the printed stat growth on level up', () => {
    const growth = getPersona('pixie').statGrowth;
    const before = killShot({ victimCardId: 'apsaras' });
    const beforeStats = { ...activeOf(before, 0) };

    const after = applyAction(before, { type: 'ATTACK', player: 0 });
    const pixie = activeOf(after, 0);

    expect(pixie.magic).toBe(beforeStats.magic + growth.magic);
    expect(pixie.endurance).toBe(beforeStats.endurance + growth.endurance);
    expect(pixie.strength).toBe(beforeStats.strength + growth.strength);
    expect(pixie.maxHp).toBe(beforeStats.maxHp + growth.hp);
    expect(pixie.hp).toBe(beforeStats.hp + growth.hp); // the new HP is granted, not just the cap
    expect(pixie.maxSp).toBe(beforeStats.maxSp + growth.sp);
  });

  it('unlocks the skills printed on the card as levels are gained', () => {
    // Pixie Lv5 kills Ippon-Datara Lv14 -> +2 -> Lv7, and Media unlocks at 6.
    const before = killShot({ killer: { cardId: 'pixie', level: 5 }, victimCardId: 'ippon-datara' });
    expect(personaSkills(before, activeOf(before, 0)).some((s) => s.id === 'media')).toBe(false);

    const after = applyAction(before, { type: 'ATTACK', player: 0 });
    expect(activeOf(after, 0).level).toBe(7);
    expect(personaSkills(after, activeOf(after, 0)).some((s) => s.id === 'media')).toBe(true);
    expect(after.log.some((l) => l.text.includes('learned Media'))).toBe(true);
  });

  it('does not level a Persona for a knockout it did not cause', () => {
    let state = killShot({ victimCardId: 'apsaras' });
    activeOf(state, 1).ailments.push({ type: 'burn', turnsLeft: 3 });
    activeOf(state, 1).hp = 1;
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] }); // burn finishes it
    expect(activeOf(state, 0).level).toBe(3); // Pixie gets nothing for a burn tick
  });

  it('promotes a bench Persona automatically when the active is knocked out', () => {
    const state = applyAction(killShot({ victimCardId: 'apsaras' }), { type: 'ATTACK', player: 0 });
    const promoted = activeOf(state, 1);
    expect(promoted).toBeTruthy();
    expect(promoted.ko).toBe(false);
    expect(promoted.cardId).toBe('pixie');
  });
});

describe('fusion', () => {
  /** Jack Frost (Magician, Lv13) + Sarasvati (Priestess, Lv19) = 32 -> Black Frost. */
  function fusionBoard() {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'jack-frost', level: 13, active: true },
      { cardId: 'sarasvati' },
    ]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    return unlockFusion(state);
  }

  const fuseAction = (state, inherit = ['bufu', 'media']) => ({
    type: 'FUSE',
    player: 0,
    recipeId: 'fuse-black-frost',
    sacrifices: [
      { zone: 'field', uid: state.players[0].field[0].uid },
      { zone: 'field', uid: state.players[0].field[1].uid },
    ],
    inherit,
  });

  const fuse = (state, inherit) => applyAction(state, fuseAction(state, inherit));

  it('fuses two matching Personas into the recipe result at its printed level', () => {
    const state = fuse(fusionBoard());
    const result = activeOf(state, 0);
    expect(result.cardId).toBe('black-frost');
    expect(result.level).toBe(getPersona('black-frost').level); // enters at printed level
    expect(state.players[0].field).toHaveLength(1);
  });

  it('inherits one chosen skill from each parent, on top of its own', () => {
    const state = fuse(fusionBoard());
    const result = activeOf(state, 0);
    const skillIds = personaSkills(state, result).map((s) => s.id);

    expect(skillIds).toContain('bufu'); // from Jack Frost
    expect(skillIds).toContain('media'); // from Sarasvati
    expect(skillIds).toContain('agidyne'); // its own printed skill
    expect(result.inheritedSkills).toEqual(['bufu', 'media']);
  });

  it('lets the fused Persona actually use an inherited skill', () => {
    let state = fuse(fusionBoard());
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });
    activeOf(state, 0).hp = 10;

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'media' });
    expect(activeOf(state, 0).hp).toBe(35); // Media heals 25
  });

  it('does not count sacrificed Personas toward the opponent\'s KO tally', () => {
    const state = fuse(fusionBoard());
    expect(state.players[0].koCount).toBe(0);
    expect(state.players[0].discard).toContain('jack-frost');
    expect(state.players[0].discard).toContain('sarasvati');
  });

  it('rejects a pair whose combined level is too low', () => {
    const state = fusionBoard();
    setField(state, 0, [
      { cardId: 'jack-frost', active: true }, // printed Lv6
      { cardId: 'sarasvati' }, // Lv19 -> 25, below the recipe minimum
    ]);
    expect(() => applyAction(state, fuseAction(state))).toThrow(/combined level 25/);
  });

  it('rejects a pair whose arcana do not match the recipe', () => {
    const state = fusionBoard();
    setField(state, 0, [{ cardId: 'pixie', level: 20, active: true }, { cardId: 'sarasvati' }]);
    expect(() => applyAction(state, { ...fuseAction(state), inherit: ['dia', 'media'] })).toThrow(/Magician \+ Priestess/);
  });

  it('rejects a skill neither parent can pass on', () => {
    const state = fusionBoard();
    expect(() => applyAction(state, fuseAction(state, ['megidolaon', 'media']))).toThrow(/cannot pass on/);
  });

  it('can consume a Persona straight from hand', () => {
    const state = unlockFusion(setupMatch());
    // Sarasvati grown to Lv26 + Jack Frost from hand at its printed Lv6 = 32.
    setField(state, 0, [{ cardId: 'sarasvati', level: 26, active: true }]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    setHand(state, 0, ['jack-frost']);
    const handUid = handUidOf(state, 0, 'jack-frost');

    const after = applyAction(state, {
      type: 'FUSE',
      player: 0,
      recipeId: 'fuse-black-frost',
      sacrifices: [
        { zone: 'field', uid: state.players[0].field[0].uid },
        { zone: 'hand', uid: handUid },
      ],
      inherit: ['media', 'bufu'],
    });

    expect(activeOf(after, 0).cardId).toBe('black-frost');
    expect(after.players[0].hand.find((c) => c.uid === handUid)).toBeUndefined();
    expect(after.players[0].discard).toContain('jack-frost');
    expect(after.players[0].koCount).toBe(0);
  });

  it('costs your action — you fuse OR you attack', () => {
    const state = fuse(fusionBoard());
    expect(state.turnState.actionsRemaining).toBe(CONFIG.ACTIONS_PER_TURN - 1);
    expect(state.turnState.fusionsPerformed).toBe(1);
    expect(getLegalActions(state, 0).some((a) => a.type === 'ATTACK')).toBe(false);
  });

  it('is rationed per turn as well as costing the action', () => {
    // Two independent gates now, so this hands the action back before checking:
    // otherwise it could not tell the ration from the empty action budget, and
    // would keep passing if the ration were removed entirely. A One More does
    // exactly this refund in a real match.
    const state = fuse(fusionBoard());
    expect(state.turnState.fusionsPerformed).toBe(CONFIG.FUSIONS_PER_TURN);

    const refunded = { ...state, turnState: { ...state.turnState, actionsRemaining: 1 } };
    expect(getLegalActions(refunded, 0).some((a) => a.type === 'ATTACK')).toBe(true);
    expect(getLegalActions(refunded, 0).some((a) => a.type === 'FUSE')).toBe(false);
  });

  it('offers fusion in the legal action list only when a recipe is satisfiable', () => {
    const ready = fusionBoard();
    const fusions = getLegalActions(ready, 0).filter((a) => a.type === 'FUSE');
    expect(fusions.length).toBeGreaterThan(0);
    expect(fusions[0]).toMatchObject({ recipeId: 'fuse-black-frost', result: 'black-frost' });
    expect(fusions[0].inheritOptions).toHaveLength(2);

    const notReady = setupMatch();
    setField(notReady, 0, [{ cardId: 'pixie', active: true }]);
    expect(getLegalActions(notReady, 0).some((a) => a.type === 'FUSE')).toBe(false);
  });
});
