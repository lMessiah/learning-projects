/**
 * Rewriting a Persona's affinity chart.
 *
 * Two problems, one card: the database is finite and a dedicated player will
 * eventually memorise it, and the Brutal bot reads that same database outright
 * from turn one. A rewrite invalidates both — the printed card stops describing
 * the Persona, and Brutal loses its clairvoyance on that body specifically.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, affinitiesOf, affinityOf, visibleAffinities, revealType } from '../src/engine/index.js';
import { rewriteAffinities } from '../src/engine/effects.js';
import { explainBotActions } from '../src/engine/bot.js';
import { getPersona, DAMAGE_TYPES, SPECIALS } from '../src/data/cards.js';
import { setupMatch, setField, setHand, activeOf, uidOf, handUidOf } from './helpers.js';

function board({ mine = ['jack-frost', 'silky'], theirs = ['angel'] } = {}) {
  const state = setupMatch({ seed: 5555 });
  setField(state, 0, mine.map((cardId, i) => ({ cardId, level: 20, active: i === 0 })));
  setField(state, 1, theirs.map((cardId, i) => ({ cardId, level: 20, active: i === 0 })));
  state.players[0].hand = [];
  state.players[1].hand = [];
  return state;
}

const play = (state, cardId, extra = {}) =>
  applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, cardId), ...extra });

const sorted = (list) => [...list].sort().join(',');

describe('the cards', () => {
  it('gives each flavour exactly one, and none of them costs an action', () => {
    const rewrites = SPECIALS.filter((s) => s.effect.kind === 'rewriteAffinities');
    expect(rewrites.map((s) => s.exclusive).sort()).toEqual(['p3', 'p4', 'p5']);
    for (const card of rewrites) {
      expect(card.usesAction).toBe(false);
      expect(card.description).toMatch(/Brutal/); // it says what it is for
    }
  });
});

describe('rewriting', () => {
  it('replaces the chart with a different one', () => {
    const state = board();
    const persona = activeOf(state, 0);
    const before = affinitiesOf(persona);

    expect(rewriteAffinities(state, persona)).toBe(true);
    const after = affinitiesOf(persona);
    expect(`${sorted(after.weaknesses)}|${sorted(after.resists)}`).not.toBe(
      `${sorted(before.weaknesses)}|${sorted(before.resists)}`
    );
  });

  it('keeps the shape, so it never makes a Persona stronger or weaker', () => {
    for (const cardId of ['jack-frost', 'ara-mitama', 'kaiwan', 'silky', 'anzu']) {
      const state = board({ mine: [cardId] });
      const persona = activeOf(state, 0);
      const before = affinitiesOf(persona);
      rewriteAffinities(state, persona);
      const after = affinitiesOf(persona);

      expect(after.weaknesses).toHaveLength(before.weaknesses.length);
      expect(after.resists).toHaveLength(before.resists.length);
      // Never both weak to and resistant to the same thing.
      expect(after.weaknesses.filter((t) => after.resists.includes(t))).toEqual([]);
      for (const type of [...after.weaknesses, ...after.resists]) {
        expect(DAMAGE_TYPES).toContain(type);
        expect(type).not.toBe('almighty');
      }
    }
  });

  it('forgets everything anyone had uncovered', () => {
    const state = board();
    const persona = activeOf(state, 0);
    revealType(state, persona, 'fire');
    expect(persona.revealedTypes).toEqual(['fire']);

    rewriteAffinities(state, persona);
    expect(persona.revealedTypes).toEqual([]);
    expect(persona.rewritten).toBe(true);
  });

  it('changes what the damage formula does', () => {
    const state = board();
    const persona = activeOf(state, 0);
    expect(affinityOf(persona, 'fire')).toBe('weak'); // Jack Frost, as printed
    rewriteAffinities(state, persona);

    const after = affinitiesOf(persona);
    for (const type of DAMAGE_TYPES) {
      if (type === 'almighty') continue;
      const expected = after.weaknesses.includes(type) ? 'weak' : after.resists.includes(type) ? 'resist' : 'neutral';
      expect(affinityOf(persona, type), type).toBe(expected);
    }
  });

  it('leaves the printed card alone — it is an instance override', () => {
    const state = board();
    rewriteAffinities(state, activeOf(state, 0));
    expect(getPersona('jack-frost').weaknesses).toEqual(['fire']);
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const state = board();
      rewriteAffinities(state, activeOf(state, 0));
      return affinitiesOf(activeOf(state, 0));
    };
    expect(run()).toEqual(run());
  });

  it('declines a Persona with nothing printed either way', () => {
    const state = board();
    const persona = activeOf(state, 0);
    persona.weaknesses = [];
    persona.resists = [];
    expect(rewriteAffinities(state, persona)).toBe(false);
  });
});

describe('the three Specials', () => {
  it('Turn of the Moon rewrites your active', () => {
    const state = board();
    setHand(state, 0, ['turn-of-the-moon']);
    const before = affinitiesOf(activeOf(state, 0));

    const next = play(state, 'turn-of-the-moon');
    expect(activeOf(next, 0).rewritten).toBe(true);
    // The guarantee is that the CHART changed, not that any one list did — a
    // reroll that keeps the weakness and moves the resist is a real change.
    const after = affinitiesOf(activeOf(next, 0));
    expect(`${sorted(after.weaknesses)}|${sorted(after.resists)}`).not.toBe(
      `${sorted(before.weaknesses)}|${sorted(before.resists)}`
    );
    // ...and nobody else.
    expect(next.players[0].field[1].rewritten).toBe(false);
    expect(next.players[1].field[0].rewritten).toBe(false);
  });

  it("Jester's Trickery reaches any one of your field Personas", () => {
    const state = board();
    setHand(state, 0, ['jesters-trickery']);

    const targets = getLegalActions(state, 0)
      .filter((a) => a.cardId === 'jesters-trickery')
      .map((a) => a.targetUid);
    expect(targets).toHaveLength(2); // the active AND the bench

    const bench = uidOf(state, 0, 'silky');
    const next = play(state, 'jesters-trickery', { targetUid: bench });
    expect(next.players[0].field.find((p) => p.uid === bench).rewritten).toBe(true);
    expect(activeOf(next, 0).rewritten).toBe(false);
  });

  it('Change of Heart scrambles both actives at once', () => {
    const state = board();
    setHand(state, 0, ['change-of-heart']);
    const next = play(state, 'change-of-heart');

    expect(activeOf(next, 0).rewritten).toBe(true);
    expect(activeOf(next, 1).rewritten).toBe(true);
    expect(next.players[0].field[1].rewritten).toBe(false); // the bench is untouched
  });

  it('costs no action, like the other free Specials', () => {
    const state = board();
    setHand(state, 0, ['turn-of-the-moon']);
    expect(play(state, 'turn-of-the-moon').turnState.actionsRemaining).toBe(1);
  });
});

describe('what each side can see afterwards', () => {
  it('shows you your own new chart and hides it from your opponent', () => {
    const state = board();
    setHand(state, 0, ['turn-of-the-moon']);
    const next = play(state, 'turn-of-the-moon');
    const persona = activeOf(next, 0);

    expect(visibleAffinities(next, persona, 0).weaknesses).toEqual(affinitiesOf(persona).weaknesses);
    expect(visibleAffinities(next, persona, 1).weaknesses).toEqual([]);
    expect(visibleAffinities(next, persona, 1).resists).toEqual([]);
  });
});

describe('against the Brutal bot', () => {
  /**
   * How much Brutal thinks each of its skills is worth against our active.
   * Seat 1 has to be the one to act for it to have a move list at all.
   */
  const brutalScores = (state) => {
    state.activePlayer = 1;
    return explainBotActions(state, 1, 'brutal').filter((e) => e.action.type === 'USE_SKILL');
  };

  it('stops reading the card once the chart has been rewritten', () => {
    // Silky is weak to fire and Hua Po has Agi, so Brutal normally aims for it.
    const state = board({ mine: ['silky'], theirs: ['hua-po'] });
    const knowing = brutalScores(state).find((e) => e.action.skillId === 'agi');
    expect(knowing).toBeTruthy();

    const scrambled = board({ mine: ['silky'], theirs: ['hua-po'] });
    // Force a chart that is deliberately NOT weak to fire.
    const target = activeOf(scrambled, 0);
    target.weaknesses = ['ice'];
    target.resists = ['dark'];
    target.rewritten = true;
    target.revealedTypes = [];

    const blind = brutalScores(scrambled).find((e) => e.action.skillId === 'agi');
    // It no longer prices Agi as a weakness hit — it has to find out first.
    expect(blind.score).toBeLessThan(knowing.score);
  });

  it('learns the new chart the hard way, by hitting things', () => {
    const state = board({ mine: ['silky'], theirs: ['hua-po'] });
    const target = activeOf(state, 0);
    target.weaknesses = ['fire'];
    target.resists = [];
    target.rewritten = true;
    target.revealedTypes = [];

    const before = brutalScores(state).find((e) => e.action.skillId === 'agi').score;
    revealType(state, target, 'fire'); // Brutal has now seen it happen
    const after = brutalScores(state).find((e) => e.action.skillId === 'agi').score;
    expect(after).toBeGreaterThan(before);
  });

  it('still reads a Persona nobody has rewritten', () => {
    const state = board({ mine: ['silky'], theirs: ['hua-po'] });
    expect(activeOf(state, 0).rewritten).toBe(false);
    const agi = brutalScores(state).find((e) => e.action.skillId === 'agi');
    const bufu = brutalScores(state).find((e) => e.action.skillId === 'dia');
    expect(agi.score).toBeGreaterThan(bufu?.score ?? 0);
  });
});
