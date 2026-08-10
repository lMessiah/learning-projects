/**
 * Skill Cards: an Item that permanently teaches its printed skill.
 *
 * The interesting properties are the negative ones — a Skill Card cannot teach
 * a passive, cannot double up on a Persona that
 * already knows the skill, and cannot flood a deck.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, personaSkills } from '../src/engine/index.js';
import { ITEMS, SPECIALS, SKILLS, META, PASSIVE_IDS, getCard } from '../src/data/cards.js';
import { expandDeck, ARCHETYPE_IDS } from '../src/data/archetypes.js';
import { setupMatch, setField, setHand, activeOf, uidOf, handUidOf } from './helpers.js';

const SKILL_CARDS = ITEMS.filter((i) => i.effect.kind === 'teachSkill');

function board() {
  const state = setupMatch({ seed: 31415 });
  // Ippon-Datara is a hammer with no magic to speak of and no Fire at all —
  // exactly the hole a Skill Card exists to patch.
  setField(state, 0, [
    { cardId: 'ippon-datara', level: 20, active: true },
    { cardId: 'silky', level: 20 },
  ]);
  setField(state, 1, [{ cardId: 'jack-frost', level: 20, active: true }]);
  state.players[1].hand = [];
  return state;
}

const play = (state, cardId, targetUid) =>
  applyAction(state, { type: 'PLAY_ITEM', player: 0, handUid: handUidOf(state, 0, cardId), targetUid });

describe('the cards themselves', () => {
  it('ships three, covering an element, a support and a drain', () => {
    expect(SKILL_CARDS).toHaveLength(3);
    const taught = SKILL_CARDS.map((c) => c.effect.skillId);
    expect(taught).toContain('agilao'); // elemental coverage
    expect(taught).toContain('rakukaja'); // support
    expect(taught).toContain('life-drain'); // drain
  });

  it('can only ever name a real skill — never a passive', () => {
    for (const card of [...ITEMS, ...SPECIALS]) {
      if (card.effect.kind !== 'teachSkill') continue;
      const { skillId } = card.effect;
      expect(SKILLS[skillId], `${card.name} teaches an unknown skill`).toBeTruthy();
      expect(PASSIVE_IDS).not.toContain(skillId);
    }
  });

  it('leans Tactical, and prints what the skill will cost to cast', () => {
    for (const card of SKILL_CARDS) {
      expect(card.affinity.tactical).toBe(3);
      expect(card.affinity.tactical).toBeGreaterThanOrEqual(Math.max(...Object.values(card.affinity)));
      const skill = SKILLS[card.effect.skillId];
      const cost = skill.type === 'phys' ? `${skill.hpCost} HP` : `${skill.spCost} SP`;
      expect(card.description).toContain(cost);
    }
  });

  it('shares a two-per-deck cap between them', () => {
    expect(META.deckGroupCaps['skill-card']).toBe(2);
    for (const flavour of ['p3', 'p4', 'p5']) {
      for (const archetype of [null, ...ARCHETYPE_IDS]) {
        for (const seed of [1, 2, 3, 17, 99, 4242]) {
          const held = expandDeck(flavour, { archetype, seed }).filter(
            (id) => getCard(id).deckGroup === 'skill-card'
          );
          expect(held.length, `${flavour}/${archetype} seed ${seed}`).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});

describe('teaching', () => {
  it('adds the skill to the chosen Persona for the rest of the match', () => {
    const state = board();
    setHand(state, 0, ['skill-card-agilao']);
    const student = activeOf(state, 0);
    expect(personaSkills(state, student).some((s) => s.id === 'agilao')).toBe(false);

    const next = play(state, 'skill-card-agilao', student.uid);
    const taught = activeOf(next, 0);
    expect(personaSkills(next, taught).some((s) => s.id === 'agilao')).toBe(true);
    expect(next.log.some((e) => e.text.includes('learned Agilao from the card'))).toBe(true);
  });

  it('makes the skill immediately castable, whatever the unlock level says', () => {
    const state = board();
    setHand(state, 0, ['skill-card-agilao']);
    const next = play(state, 'skill-card-agilao', activeOf(state, 0).uid);

    const casts = getLegalActions(next, 0).filter((a) => a.type === 'USE_SKILL' && a.skillId === 'agilao');
    expect(casts.length).toBeGreaterThan(0);

    const after = applyAction(next, { ...casts[0] });
    expect(after.players[1].field[0].hp).toBeLessThan(next.players[1].field[0].hp);
  });

  it('lets you teach a bench Persona instead', () => {
    const state = board();
    setHand(state, 0, ['skill-card-rakukaja']);
    const bench = uidOf(state, 0, 'silky');
    const offers = getLegalActions(state, 0).filter((a) => a.cardId === 'skill-card-rakukaja');
    expect(offers.map((a) => a.targetUid)).toContain(bench);

    const next = play(state, 'skill-card-rakukaja', bench);
    const student = next.players[0].field.find((p) => p.uid === bench);
    expect(personaSkills(next, student).some((s) => s.id === 'rakukaja')).toBe(true);
  });

  it('is not offered to a Persona that already knows the skill', () => {
    const state = board();
    setHand(state, 0, ['skill-card-rakukaja']);
    // Ippon-Datara prints Rakukaja at level 1, so only Silky is a candidate.
    const targets = getLegalActions(state, 0)
      .filter((a) => a.cardId === 'skill-card-rakukaja')
      .map((a) => a.targetUid);
    expect(targets).toEqual([uidOf(state, 0, 'silky')]);

    expect(() => play(state, 'skill-card-rakukaja', activeOf(state, 0).uid)).toThrow(/already knows Rakukaja/);
  });

  it('is not offered at all when the whole field already knows it', () => {
    const state = setupMatch({ seed: 7 });
    setField(state, 0, [{ cardId: 'ippon-datara', level: 20, active: true }]);
    setField(state, 1, [{ cardId: 'jack-frost', active: true }]);
    setHand(state, 0, ['skill-card-rakukaja']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'skill-card-rakukaja')).toHaveLength(0);
  });

  it('survives a Persona change and a knockdown — it is not a buff', () => {
    let state = board();
    setHand(state, 0, ['skill-card-life-drain']);
    state = play(state, 'skill-card-life-drain', activeOf(state, 0).uid);
    const uid = activeOf(state, 0).uid;

    state = applyAction(state, { type: 'CHANGE_ACTIVE', player: 0, targetUid: uidOf(state, 0, 'silky') });
    const parked = state.players[0].field.find((p) => p.uid === uid);
    parked.knockedDown = true;
    expect(personaSkills(state, parked).some((s) => s.id === 'life-drain')).toBe(true);
  });
});
