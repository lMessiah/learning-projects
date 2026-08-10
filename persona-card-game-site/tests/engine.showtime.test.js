/**
 * Showtime duo attacks.
 *
 * The unlock condition is the whole design: two specific bodies, both on your
 * field, both on their feet. Everything below pins one half of that down.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction,
  getLegalActions,
  availableShowtimes,
  showtimeActions,
  livingField,
} from '../src/engine/index.js';
import { SHOWTIMES, PERSONAS, getShowtime, duoPartnersOf, showtimesFor } from '../src/data/cards.js';
import { setupMatch, setField, uidOf } from './helpers.js';

const HEE_HO = 'duo-hee-ho-hop'; // pixie + jack-frost, the common pair

/** Both halves of the Hee-Ho Hop, plus a punching bag opposite. */
function board({ partners = ['pixie', 'jack-frost'], enemy = ['silky'] } = {}) {
  const state = setupMatch({ seed: 1234 });
  setField(
    state,
    0,
    partners.map((cardId, i) => ({ cardId, level: 20, active: i === 0 }))
  );
  setField(
    state,
    1,
    enemy.map((cardId, i) => ({ cardId, level: 20, active: i === 0 }))
  );
  state.players[0].hand = [];
  state.players[1].hand = [];
  return state;
}

const showtimeIn = (state, playerId = 0) => getLegalActions(state, playerId).filter((a) => a.type === 'SHOWTIME');

describe('the showtime table', () => {
  it('defines five pairs of real, distinct Personas', () => {
    expect(SHOWTIMES).toHaveLength(5);
    const ids = new Set(PERSONAS.map((p) => p.id));
    for (const showtime of SHOWTIMES) {
      expect(showtime.pair).toHaveLength(2);
      expect(showtime.pair[0]).not.toBe(showtime.pair[1]);
      for (const id of showtime.pair) expect(ids.has(id), `${id} is not a Persona`).toBe(true);
      expect(showtime.effect.kind).toBe('damage');
      expect(showtime.effect.flat, `${showtime.id} must print exactly what it deals`).toBe(true);
      expect(showtime.description).toContain(String(showtime.effect.amount));
    }
  });

  it('spreads the pairs across the flavours, including one that needs a fusion', () => {
    const flavours = SHOWTIMES.map((s) => s.flavour);
    expect(new Set(flavours)).toEqual(new Set(['p3', 'p4', 'p5', 'common']));
    // Black Frost is fusion-only, so Frozen Rebellion cannot simply be drawn.
    const fusionPair = SHOWTIMES.find((s) => s.id === 'duo-frozen-rebellion');
    expect(PERSONAS.find((p) => p.id === 'black-frost').fusionOnly).toBe(true);
    expect(fusionPair.pair).toContain('black-frost');
  });

  it('mirrors itself onto every partner card', () => {
    for (const persona of PERSONAS) {
      const expected = duoPartnersOf(persona.id);
      expect([...(persona.duoPartners ?? [])].sort()).toEqual([...expected].sort());
    }
    expect(showtimesFor('jack-frost').map((s) => s.id).sort()).toEqual(
      ['duo-frozen-rebellion', HEE_HO].sort()
    );
  });
});

describe('unlocking', () => {
  it('is offered when both partners are standing on your field', () => {
    const state = board();
    expect(availableShowtimes(state, 0).map((s) => s.id)).toContain(HEE_HO);
    expect(showtimeIn(state)).toHaveLength(1);
    expect(showtimeIn(state)[0].showtimeId).toBe(HEE_HO);
  });

  it('is not offered with only one half of the pair', () => {
    const state = board({ partners: ['pixie', 'silky'] });
    expect(availableShowtimes(state, 0)).toHaveLength(0);
    expect(showtimeIn(state)).toHaveLength(0);
  });

  it('is not offered while a partner is knocked down', () => {
    const state = board();
    state.players[0].field.find((p) => p.cardId === 'jack-frost').knockedDown = true;
    expect(availableShowtimes(state, 0)).toHaveLength(0);
  });

  it('is not offered while a partner is knocked out', () => {
    const state = board();
    const frost = state.players[0].field.find((p) => p.cardId === 'jack-frost');
    frost.ko = true;
    frost.hp = 0;
    expect(availableShowtimes(state, 0)).toHaveLength(0);
  });

  it('works whichever partner is holding the active slot', () => {
    const leading = board({ partners: ['jack-frost', 'pixie'] });
    expect(availableShowtimes(leading, 0).map((s) => s.id)).toContain(HEE_HO);
  });

  it('needs an action left', () => {
    const state = board();
    state.turnState.actionsRemaining = 0;
    expect(showtimeActions(state, 0)).toHaveLength(0);
  });
});

describe('resolving', () => {
  const fire = (state) =>
    applyAction(state, { type: 'SHOWTIME', player: 0, showtimeId: HEE_HO, targetUid: uidOf(state, 1, 'silky') });

  it('deals exactly what it prints, and shouts about it', () => {
    const state = board();
    const before = state.players[1].field[0].hp;
    const next = fire(state);

    // Silky is neutral to ice at this board (weak fire, resists ice) — she
    // RESISTS ice, so the flat number is halved and nothing else touches it.
    const dealt = before - next.players[1].field[0].hp;
    expect(dealt).toBe(Math.round(getShowtime(HEE_HO).effect.amount * 0.5));

    const shout = next.log.filter((e) => e.kind === 'showtime');
    expect(shout).toHaveLength(1);
    expect(shout[0].text).toContain('SHOWTIME!');
    expect(shout[0].text).toContain('Hee-Ho Hop');
  });

  it('costs your action and is gone for the rest of the match', () => {
    const next = fire(board());
    expect(next.turnState.actionsRemaining).toBe(0);
    expect(next.players[0].showtimesUsed).toEqual([HEE_HO]);
    expect(availableShowtimes(next, 0)).toHaveLength(0);
    expect(next.players[0].stats.showtimes).toBe(1);

    // ...even with the action budget handed back and both partners still up.
    next.turnState.actionsRemaining = 1;
    expect(showtimeActions(next, 0)).toHaveLength(0);
    expect(() =>
      applyAction(next, { type: 'SHOWTIME', player: 0, showtimeId: HEE_HO, targetUid: uidOf(next, 1, 'silky') })
    ).toThrow(/already been used/);
  });

  it('refuses a duo whose partners are not both up', () => {
    const state = board({ partners: ['pixie', 'silky'] });
    expect(() =>
      applyAction(state, { type: 'SHOWTIME', player: 0, showtimeId: HEE_HO, targetUid: uidOf(state, 1, 'silky') })
    ).toThrow(/standing on your field/);
  });

  it('refuses an id that is not a duo at all', () => {
    const state = board();
    expect(() => applyAction(state, { type: 'SHOWTIME', player: 0, showtimeId: 'duo-nope' })).toThrow(
      /unknown Showtime/
    );
  });

  it('grants a One More when it knocks a standing Persona down on a weakness', () => {
    // Berith is weak to ice and prints no passive, so nothing keeps her up but
    // the HP she is padded with here.
    const state = board({ enemy: ['berith', 'angel'] });
    state.players[1].field[0].maxHp = 400;
    state.players[1].field[0].hp = 400;

    const next = applyAction(state, {
      type: 'SHOWTIME',
      player: 0,
      showtimeId: HEE_HO,
      targetUid: uidOf(state, 1, 'berith'),
    });
    expect(next.players[1].field[0].knockedDown).toBe(true);
    expect(next.turnState.oneMoresGranted).toBe(1);
  });

  it('sweeps the whole enemy field when the duo says it does', () => {
    // Truth Unveiled: izanagi + ara-mitama, 42 flat almighty to everything.
    const state = setupMatch({ seed: 88 });
    setField(state, 0, [
      { cardId: 'izanagi', level: 20, active: true },
      { cardId: 'ara-mitama', level: 20 },
    ]);
    setField(state, 1, [
      { cardId: 'silky', level: 20, maxHp: 200, hp: 200, active: true },
      { cardId: 'angel', level: 20, maxHp: 200, hp: 200 },
      { cardId: 'pixie', level: 20, maxHp: 200, hp: 200 },
    ]);
    state.players[0].hand = [];

    const before = livingField(state, 1).map((p) => p.hp);
    const next = applyAction(state, { type: 'SHOWTIME', player: 0, showtimeId: 'duo-truth-unveiled' });
    const after = livingField(next, 1).map((p) => p.hp);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBeLessThan(before[i]);
  });

  it('is per player, not per match — the other side keeps its own', () => {
    const state = board({ partners: ['pixie', 'jack-frost'], enemy: ['pixie', 'jack-frost'] });
    const next = fire(state);
    expect(next.players[0].showtimesUsed).toEqual([HEE_HO]);
    expect(next.players[1].showtimesUsed).toEqual([]);
  });
});
