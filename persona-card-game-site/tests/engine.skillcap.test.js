/**
 * The skill cap.
 *
 * A Persona may know MAX_SKILLS_PER_PERSONA skills, printed and inherited
 * together. Nothing in the card data comes close — the fattest card prints 6 —
 * so the cap exists entirely because INHERITED skills accumulate: a fusion hands
 * down two, and every Gallows meal, Skill Card and Evolve adds another.
 *
 * The rule the tests below pin: a learn the player CHOSE must say what it
 * replaces, and a printed skill unlocking on level-up cannot ask, so it is
 * declined rather than silently overflowing the cap.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, CONFIG } from '../src/engine/index.js';
import { personaSkills, isSkillFull, droppableSkills } from '../src/engine/state.js';
import { levelUp } from '../src/engine/effects.js';
import { setupMatch, setField, setHand, activeOf } from './helpers.js';

const CAP = CONFIG.MAX_SKILLS_PER_PERSONA;

/** Pixie holding `n` inherited skills, so the cap can be approached precisely. */
function pixieWith(extra) {
  const state = setupMatch();
  setField(state, 0, [{ cardId: 'pixie', level: 14, active: true }]);
  setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
  activeOf(state, 0).inheritedSkills = [...extra];
  return state;
}

describe('the cap itself', () => {
  it('is 8, and no printed card comes anywhere near it', () => {
    expect(CAP).toBe(8);
  });

  it('counts printed and inherited skills together', () => {
    const state = pixieWith(['bufu', 'garu']);
    const p = activeOf(state, 0);
    const printed = personaSkills(state, p).filter((s) => !s.inherited).length;
    expect(personaSkills(state, p)).toHaveLength(printed + 2);
  });

  it('reports fullness through one accessor, not by counting in each caller', () => {
    const state = pixieWith([]);
    const p = activeOf(state, 0);
    expect(isSkillFull(state, p)).toBe(false);

    p.inheritedSkills = ['bufu', 'garu', 'agi', 'eiha'].slice(0, CAP - personaSkills(state, p).length);
    expect(personaSkills(state, p).length).toBe(CAP);
    expect(isSkillFull(state, p)).toBe(true);
    expect(droppableSkills(state, p)).toHaveLength(CAP);
  });
});

describe('a learn the player chose', () => {
  /** Pixie filled to exactly the cap, with a Skill Card in hand. */
  function atCap() {
    const state = pixieWith([]);
    const p = activeOf(state, 0);
    const room = CAP - personaSkills(state, p).length;
    p.inheritedSkills = ['bufu', 'garu', 'agi', 'eiha', 'cleave', 'tarunda'].slice(0, room);
    expect(personaSkills(state, p).length).toBe(CAP);
    setHand(state, 0, ['skill-card-agilao']);
    return state;
  }

  const card = (state) => state.players[0].hand.find((c) => c.cardId === 'skill-card-agilao');

  it('is refused outright when the Persona is full and nothing is named', () => {
    const state = atCap();
    expect(() =>
      applyAction(state, {
        type: 'PLAY_ITEM', player: 0,
        handUid: card(state).uid,
        targetUid: activeOf(state, 0).uid,
      })
    ).toThrow(/already knows 8 skills/i);
  });

  it('names every candidate in the refusal, so the choice can be built from it', () => {
    const state = atCap();
    const known = personaSkills(state, activeOf(state, 0)).map((s) => s.id);
    try {
      applyAction(state, {
        type: 'PLAY_ITEM', player: 0,
        handUid: card(state).uid,
        targetUid: activeOf(state, 0).uid,
      });
      throw new Error('should have thrown');
    } catch (error) {
      for (const id of known) expect(error.message).toContain(id);
    }
  });

  it('succeeds when the player names one to forget, and swaps exactly one', () => {
    const state = atCap();
    const before = personaSkills(state, activeOf(state, 0)).map((s) => s.id);
    const dropped = before[0];

    const after = applyAction(state, {
      type: 'PLAY_ITEM', player: 0,
      handUid: card(state).uid,
      targetUid: activeOf(state, 0).uid,
      dropSkillId: dropped,
    });

    const now = personaSkills(after, activeOf(after, 0)).map((s) => s.id);
    expect(now).toHaveLength(CAP); // still exactly at the cap, never over
    expect(now).not.toContain(dropped);
    expect(now).toContain('agilao');
  });

  it('forgets a PRINTED skill as readily as an inherited one', () => {
    const state = atCap();
    const printed = personaSkills(state, activeOf(state, 0)).find((s) => !s.inherited);

    const after = applyAction(state, {
      type: 'PLAY_ITEM', player: 0,
      handUid: card(state).uid,
      targetUid: activeOf(state, 0).uid,
      dropSkillId: printed.id,
    });

    const p = activeOf(after, 0);
    expect(personaSkills(after, p).map((s) => s.id)).not.toContain(printed.id);
    // A printed skill lives on the card, so forgetting it has to be recorded.
    expect(p.forgottenSkills).toContain(printed.id);
  });

  it('refuses a drop the Persona does not know', () => {
    const state = atCap();
    expect(() =>
      applyAction(state, {
        type: 'PLAY_ITEM', player: 0,
        handUid: card(state).uid,
        targetUid: activeOf(state, 0).uid,
        dropSkillId: 'megidolaon',
      })
    ).toThrow(/cannot forget it/i);
  });

  it('ignores a drop when the Persona turns out to have room', () => {
    // Deliberately lenient. Whether a drop is needed is decided when the legal
    // action is built, and on the Gallows path a level-up lands in between —
    // it can unlock a printed skill or make the offered one redundant. Failing
    // there would reject a legal action for a reason the player never saw.
    const state = pixieWith([]);
    setHand(state, 0, ['skill-card-agilao']);
    const p = activeOf(state, 0);
    expect(isSkillFull(state, p)).toBe(false);
    const before = personaSkills(state, p).map((s) => s.id);

    const after = applyAction(state, {
      type: 'PLAY_ITEM', player: 0,
      handUid: card(state).uid,
      targetUid: p.uid,
      dropSkillId: before[0],
    });

    const now = personaSkills(after, activeOf(after, 0)).map((s) => s.id);
    expect(now).toContain(before[0]); // nothing was forgotten
    expect(now).toContain('agilao'); // and it still learned
  });
});

describe('the legal action carries a working default', () => {
  it('fills in a drop and lists the alternatives when the target is full', () => {
    const state = pixieWith([]);
    const p = activeOf(state, 0);
    p.inheritedSkills = ['bufu', 'garu', 'agi', 'eiha', 'cleave', 'tarunda'].slice(
      0, CAP - personaSkills(state, p).length
    );
    setHand(state, 0, ['skill-card-agilao']);

    const teach = getLegalActions(state, 0).find((a) => a.cardId === 'skill-card-agilao');
    expect(teach).toBeTruthy();
    expect(teach.dropSkillId).toBeTruthy();
    expect(teach.dropOptions.length).toBe(CAP);
    expect(teach.needsChoice).toBe(true);

    // The default alone must be enough — this is what keeps the bot unwedged.
    expect(() => applyAction(state, teach)).not.toThrow();
  });

  it('attaches nothing at all when there is room', () => {
    const state = pixieWith([]);
    setHand(state, 0, ['skill-card-agilao']);
    const teach = getLegalActions(state, 0).find((a) => a.cardId === 'skill-card-agilao');
    expect(teach.dropSkillId).toBeUndefined();
  });
});

describe('a skill unlocked by levelling up', () => {
  it('is declined rather than overflowing, because nothing can be asked', () => {
    // Pixie learns Zionga at 14. Fill it to the cap at 13, then level it.
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', level: 13, active: true }]);
    const p = activeOf(state, 0);
    p.inheritedSkills = ['bufu', 'garu', 'agi', 'eiha', 'cleave', 'tarunda'].slice(
      0, CAP - personaSkills(state, p).length
    );
    expect(personaSkills(state, p).length).toBe(CAP);

    const learned = levelUp(state, p, 1);

    expect(p.level).toBe(14);
    expect(learned).toHaveLength(0); // nothing was taken on
    expect(personaSkills(state, p).length).toBe(CAP); // and the cap held
    expect(state.log.some((l) => /could not take on/i.test(l.text))).toBe(true);
  });

  it('is learned normally when there is room', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', level: 13, active: true }]);
    const p = activeOf(state, 0);
    const before = personaSkills(state, p).length;

    const learned = levelUp(state, p, 1);

    expect(learned.length).toBeGreaterThan(0);
    expect(personaSkills(state, p).length).toBe(before + learned.length);
  });
});
