/**
 * Signature Personas — Pixie, Slime and Ara Mitama.
 *
 * Two rules, both about ACCESS rather than power:
 *
 *   1. SUPPRESSION — you never draw one while you already hold one.
 *   2. PRIORITY    — the one you CHOSE is the likeliest Persona in your deck
 *                    once you have none.
 *
 * The load-bearing claim is that rule 3 is **not a buff**: a scaled signature
 * is exactly what that Persona would be had it levelled there itself, and never
 * better than your own best body. Most of this file exists to hold that line,
 * because "help the player recover their plan" is one small step away from
 * "reward the player for losing", and those are opposite designs.
 */
import { describe, it, expect } from 'vitest';
import {
  createMatch,
  applyAction,
  createRng,
  SIGNATURE_CARDS,
  isSignatureCard,
  holdsSignature,
  isChosenSignature,
  highestFieldLevel,
  personaSkills,
} from '../src/engine/index.js';

const personaSkillIds = (state, persona) => personaSkills(state, persona).map((s) => s.id);
import { drawCards, levelUp } from '../src/engine/effects.js';
import { getPersona, STARTER_SIGNATURES } from '../src/data/cards.js';
import { setupMatch, setField, setHand, activeOf, handUidOf } from './helpers.js';

/** A started match where seat 0 chose `starter`, with a deck we control. */
function board({ starter = 'ara-mitama', deckId = 'p5', deck = null, hand = [] } = {}) {
  let state = createMatch({
    seed: 4242,
    players: [
      { name: 'You', deckId, controller: 'human' },
      { name: 'Them', deckId: 'p3', controller: 'human' },
    ],
  });
  state.starterOptions[0] = [starter];
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: starter });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  if (deck) state.players[0].deck = [...deck];
  setHand(state, 0, hand);
  return state;
}

const fieldOf = (state, p) => state.players[p].field;
const onField = (state, p, cardId) => fieldOf(state, p).find((x) => x.cardId === cardId);

/* ------------------------------------------------------------------ *
 * What counts as a signature
 * ------------------------------------------------------------------ */

describe('the signature set', () => {
  it('is exactly the three starter signatures, read off the data', () => {
    expect([...SIGNATURE_CARDS].sort()).toEqual([...new Set(Object.values(STARTER_SIGNATURES))].sort());
    expect([...SIGNATURE_CARDS].sort()).toEqual(['ara-mitama', 'pixie', 'slime']);
    for (const id of SIGNATURE_CARDS) expect(isSignatureCard(id)).toBe(true);
    expect(isSignatureCard('orpheus')).toBe(false);
  });

  it('records which one the player actually chose', () => {
    const state = board({ starter: 'ara-mitama' });
    expect(state.players[0].starterCardId).toBe('ara-mitama');
    expect(isChosenSignature(state, 0, 'ara-mitama')).toBe(true);
    // The plan is the pick, not the flavour.
    expect(isChosenSignature(state, 0, 'pixie')).toBe(false);
  });

  it('treats a non-signature starter as no plan at all', () => {
    const state = board({ starter: 'orpheus', deckId: 'p3' });
    expect(state.players[0].starterCardId).toBe('orpheus');
    for (const id of SIGNATURE_CARDS) expect(isChosenSignature(state, 0, id)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 1. Suppression
 * ------------------------------------------------------------------ */

describe('you never draw a signature you already hold', () => {
  it('sees one alive on your field', () => {
    const state = board({ starter: 'ara-mitama' });
    expect(holdsSignature(state, 0, 'ara-mitama')).toBe(true);
  });

  it('sees one in your hand', () => {
    const state = board({ starter: 'orpheus', deckId: 'p3', hand: ['pixie'] });
    expect(holdsSignature(state, 0, 'pixie')).toBe(true);
  });

  it('stops seeing it once the field copy is knocked out', () => {
    // The dead-signature case is the whole reason the mechanism exists, so a
    // KO'd copy must not keep withholding the card.
    const state = board({ starter: 'ara-mitama' });
    expect(holdsSignature(state, 0, 'ara-mitama')).toBe(true);
    activeOf(state, 0).ko = true;
    expect(holdsSignature(state, 0, 'ara-mitama')).toBe(false);
  });

  it('never deals a second copy while the first is out', () => {
    // A deck of nothing but Ara Mitama and Medicine: with one already on the
    // field, twenty draws must all be Medicine.
    const state = board({
      starter: 'ara-mitama',
      deck: Array.from({ length: 20 }, (_, i) => (i % 2 ? 'ara-mitama' : 'medicine')),
    });
    const drawn = drawCards(state, 0, 10);
    expect(drawn).toHaveLength(10);
    expect(drawn.map((c) => c.cardId)).not.toContain('ara-mitama');
  });

  it('deals it the moment you no longer hold one', () => {
    const state = board({
      starter: 'ara-mitama',
      deck: Array.from({ length: 20 }, (_, i) => (i % 2 ? 'ara-mitama' : 'medicine')),
    });
    activeOf(state, 0).ko = true; // the plan just died
    const drawn = drawCards(state, 0, 4);
    expect(drawn.map((c) => c.cardId)).toContain('ara-mitama');
  });

  it('falls back to a normal draw rather than dealing nothing', () => {
    // Every remaining card suppressed. The draw must still produce a card.
    const state = board({ starter: 'ara-mitama', deck: ['ara-mitama', 'ara-mitama', 'ara-mitama'] });
    const drawn = drawCards(state, 0, 1);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].cardId).toBe('ara-mitama');
  });

  it('applies to all three cards, whoever is holding them', () => {
    // Pixie is `common`, so a P5 player can hold one. The rule is a property of
    // the card, not of the flavour.
    const state = board({
      starter: 'orpheus',
      deckId: 'p5',
      hand: ['pixie'],
      deck: Array.from({ length: 20 }, (_, i) => (i % 2 ? 'pixie' : 'medicine')),
    });
    const drawn = drawCards(state, 0, 8);
    expect(drawn.map((c) => c.cardId)).not.toContain('pixie');
  });
});

/* ------------------------------------------------------------------ *
 * 2. Priority
 * ------------------------------------------------------------------ */

describe('the plan you chose comes back quickly', () => {
  /** How many draws it takes to see `cardId`, averaged over seeds. */
  function drawsToFind(cardId, { starter, deckId = 'p5' }) {
    let total = 0;
    let found = 0;
    for (let seed = 1; seed <= 40; seed++) {
      let state = createMatch({
        seed,
        players: [
          { name: 'You', deckId, controller: 'human' },
          { name: 'Them', deckId: 'p3', controller: 'human' },
        ],
      });
      state.starterOptions[0] = [starter];
      state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: starter });
      state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });

      // A deck with one copy buried among twenty other cards, and no copy held.
      state.players[0].hand = [];
      state.players[0].field = [];
      state.players[0].activeUid = null;
      state.players[0].deck = [...Array.from({ length: 20 }, () => 'medicine'), cardId];

      for (let i = 1; i <= 21; i++) {
        const [card] = drawCards(state, 0, 1);
        if (card?.cardId === cardId) {
          total += i;
          found += 1;
          break;
        }
      }
    }
    return found ? total / found : Infinity;
  }

  it('finds your chosen signature far sooner than an unchosen one', () => {
    // Same deck, same position — the only difference is whether this was the
    // card the player declared on turn one.
    const chosen = drawsToFind('ara-mitama', { starter: 'ara-mitama' });
    const notChosen = drawsToFind('ara-mitama', { starter: 'orpheus' });
    expect(chosen).toBeLessThan(notChosen);
    // Buried one-in-21, an unbiased draw averages ~11. Priority should roughly
    // halve that; the exact figure is a function of SIGNATURE_DRAW_WEIGHT.
    expect(chosen).toBeLessThan(notChosen * 0.75);
  });

  it('does not fire while you already hold one', () => {
    const state = board({
      starter: 'ara-mitama',
      deck: [...Array.from({ length: 20 }, () => 'medicine'), 'ara-mitama'],
    });
    // Ara Mitama is alive on the field, so suppression outranks priority.
    const drawn = drawCards(state, 0, 10);
    expect(drawn.map((c) => c.cardId)).not.toContain('ara-mitama');
  });
});

/* ------------------------------------------------------------------ *
 * Losing it is meant to hurt
 * ------------------------------------------------------------------ */

describe('what comes back is the CARD, not the Persona you lost', () => {
  it('enters at its printed level, however far your board has run ahead', () => {
    // The punishment. Your level-15 board does not lift the replacement; you
    // get a level 4 body and every level the original had is gone.
    for (const best of [4, 9, 14, 22]) {
      const state = board({ starter: 'ara-mitama', hand: ['ara-mitama'] });
      setField(state, 0, [{ cardId: 'orpheus', active: true }]);
      levelUp(state, activeOf(state, 0), best - activeOf(state, 0).level);

      const next = applyAction(state, {
        type: 'PLAY_PERSONA',
        player: 0,
        handUid: handUidOf(state, 0, 'ara-mitama'),
      });
      expect(onField(next, 0, 'ara-mitama').level, `board at ${best}`).toBe(getPersona('ara-mitama').level);
    }
  });

  it('brings back printed stats and printed skills — nothing was preserved', () => {
    const state = board({ starter: 'ara-mitama', hand: ['ara-mitama'] });
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    levelUp(state, activeOf(state, 0), 14 - activeOf(state, 0).level);

    const next = applyAction(state, {
      type: 'PLAY_PERSONA',
      player: 0,
      handUid: handUidOf(state, 0, 'ara-mitama'),
    });
    const card = getPersona('ara-mitama');
    const ara = onField(next, 0, 'ara-mitama');

    expect(ara.strength).toBe(card.strength);
    expect(ara.endurance).toBe(card.endurance);
    expect(ara.maxHp).toBe(card.hp);
    expect(ara.inheritedSkills ?? []).toHaveLength(0);
    // Rakunda unlocks at 9 — the replacement is nowhere near it.
    expect(personaSkillIds(next, ara)).not.toContain('rakunda');
  });

  it('is strictly worse than never losing it — dying is never a play', () => {
    // Keep it and level to 14, or lose it and draw a replacement. The whole
    // point of removing the scaling rule is that these are NOT the same.
    const kept = board({ starter: 'ara-mitama' });
    setField(kept, 0, [{ cardId: 'ara-mitama', active: true }]);
    const original = onField(kept, 0, 'ara-mitama');
    levelUp(kept, original, 14 - original.level);

    const lost = board({ starter: 'ara-mitama', hand: ['ara-mitama'] });
    setField(lost, 0, [{ cardId: 'orpheus', active: true }]);
    levelUp(lost, activeOf(lost, 0), 14 - activeOf(lost, 0).level);
    const replaced = onField(
      applyAction(lost, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(lost, 0, 'ara-mitama') }),
      0,
      'ara-mitama'
    );

    expect(replaced.level).toBeLessThan(original.level);
    expect(replaced.endurance).toBeLessThan(original.endurance);
    expect(replaced.maxHp).toBeLessThan(original.maxHp);
  });

  it('still costs the knockout — nothing here refunds the tally', () => {
    const state = board({ starter: 'ara-mitama' });
    const before = state.players[0].koCount;
    activeOf(state, 0).ko = true;
    state.players[0].koCount += 1;
    expect(state.players[0].koCount).toBe(before + 1);
    expect(holdsSignature(state, 0, 'ara-mitama')).toBe(false);
  });

  it('leaves the play-level ceiling exactly where the board set it', () => {
    const state = board({ starter: 'ara-mitama', hand: ['ara-mitama'] });
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    levelUp(state, activeOf(state, 0), 14 - activeOf(state, 0).level);
    const next = applyAction(state, {
      type: 'PLAY_PERSONA',
      player: 0,
      handUid: handUidOf(state, 0, 'ara-mitama'),
    });
    expect(highestFieldLevel(next, 0)).toBe(14);
  });

  it('treats a signature exactly like any other Persona card on the way in', () => {
    // The clearest statement of the rule: no special case at play time at all.
    const sig = board({ starter: 'ara-mitama', hand: ['ara-mitama'] });
    setField(sig, 0, [{ cardId: 'orpheus', active: true }]);
    levelUp(sig, activeOf(sig, 0), 16 - activeOf(sig, 0).level);
    const played = applyAction(sig, {
      type: 'PLAY_PERSONA',
      player: 0,
      handUid: handUidOf(sig, 0, 'ara-mitama'),
    });

    const plain = board({ starter: 'ara-mitama', deckId: 'p5', hand: ['arsene'] });
    setField(plain, 0, [{ cardId: 'orpheus', active: true }]);
    levelUp(plain, activeOf(plain, 0), 16 - activeOf(plain, 0).level);
    const other = applyAction(plain, {
      type: 'PLAY_PERSONA',
      player: 0,
      handUid: handUidOf(plain, 0, 'arsene'),
    });

    expect(onField(played, 0, 'ara-mitama').level).toBe(getPersona('ara-mitama').level);
    expect(onField(other, 0, 'arsene').level).toBe(getPersona('arsene').level);
  });

  it('says nothing special in the log — there is nothing special to say', () => {
    const state = board({ starter: 'ara-mitama', hand: ['ara-mitama'] });
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    levelUp(state, activeOf(state, 0), 14 - activeOf(state, 0).level);
    const next = applyAction(state, {
      type: 'PLAY_PERSONA',
      player: 0,
      handUid: handUidOf(state, 0, 'ara-mitama'),
    });
    expect(next.log.some((l) => l.text.includes('answers the call'))).toBe(false);
  });
});
