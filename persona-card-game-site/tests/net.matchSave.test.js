/**
 * Online match persistence: surviving a host reload, and remembering how a
 * match ended for a player who comes back after it did.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createMatch, applyAction } from '../src/engine/index.js';
import {
  saveHostMatch,
  loadHostMatch,
  hasResumableHostMatch,
  clearHostMatch,
  rememberOutcome,
  recallOutcome,
  clearOutcomes,
} from '../src/net/matchSave.js';
import { TIMING, END_REASON } from '../src/net/presence.js';
import { createHostSession, HOST_SEAT, GUEST_SEAT } from '../src/net/onlineMatch.js';
import { createLoopbackPair } from '../src/net/transport.js';

const freshMatch = (seed = 3) =>
  createMatch({ seed, players: [{ name: 'Alex', deckId: 'p3' }, { name: 'Sam', deckId: 'p5' }] });

beforeEach(() => {
  localStorage.clear();
});

describe('the host save', () => {
  it('round-trips a state the engine still accepts', () => {
    const state = freshMatch();
    saveHostMatch({ state, code: 'ABC123', token: 'tok' });

    const loaded = loadHostMatch();
    expect(loaded.code).toBe('ABC123');
    expect(loaded.token).toBe('tok');

    // The real proof: the restored state is a state, not a lookalike.
    const legal = loaded.state.starterOptions[HOST_SEAT][0];
    expect(() =>
      applyAction(loaded.state, { type: 'CHOOSE_STARTER', player: HOST_SEAT, cardId: legal }),
    ).not.toThrow();
  });

  it('forgets a save too old to rejoin', () => {
    saveHostMatch({ state: freshMatch(), code: 'OLD001', now: () => 0 });
    // Past the point where the relay would have released the seat anyway.
    const later = () => TIMING.SEAT_RESERVATION_MS + 1000;
    expect(loadHostMatch({ now: later })).toBe(null);
  });

  it('keeps a FINISHED match past that window, so the result can still be shown', () => {
    const state = freshMatch();
    state.winner = HOST_SEAT;
    state.endReason = END_REASON.DISCONNECT;
    saveHostMatch({ state, code: 'DONE01', now: () => 0 });

    const loaded = loadHostMatch({ now: () => TIMING.SEAT_RESERVATION_MS + 60_000 });
    expect(loaded).not.toBe(null);
    expect(loaded.resolved).toBe(true);
    // ...but it is not offered as something to resume.
    expect(hasResumableHostMatch({ now: () => TIMING.SEAT_RESERVATION_MS + 60_000 })).toBe(false);
  });

  it('drops a save written by an incompatible version', () => {
    localStorage.setItem('pcg.online.host', JSON.stringify({ version: 999, code: 'X', state: {} }));
    expect(loadHostMatch()).toBe(null);
    expect(localStorage.getItem('pcg.online.host')).toBe(null);
  });

  it('survives storage being unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('disabled');
      },
    });
    // A match must never die because a browser is in private mode.
    expect(saveHostMatch({ state: freshMatch(), code: 'NOPE01' })).toBe(false);
    expect(loadHostMatch()).toBe(null);
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
  });

  it('is written by the host session as the match progresses', () => {
    const [hostWire] = createLoopbackPair();
    const saved = [];
    const host = createHostSession(hostWire, {
      seed: 5,
      autoTick: false,
      onPersist: (state) => saved.push(state),
    });
    host.start();
    expect(saved.length).toBeGreaterThan(0);

    host.dispatch(host.legalActions(HOST_SEAT)[0]);
    expect(saved.length).toBeGreaterThan(1);
    // What is handed over is the authoritative state, not a redacted view.
    expect(saved.at(-1).seed).not.toBe(null);
    host.destroy();
  });

  it('resumes a session from a saved state instead of dealing a new match', () => {
    const [hostWire] = createLoopbackPair();
    const first = createHostSession(hostWire, { seed: 5, autoTick: false });
    first.start();
    first.dispatch(first.legalActions(HOST_SEAT)[0]);
    const midMatch = JSON.parse(JSON.stringify(first.getState()));
    first.destroy();

    // A fresh tab, handed the state the old one left behind.
    const [wire2] = createLoopbackPair();
    const resumed = createHostSession(wire2, {
      seed: 5,
      autoTick: false,
      resumeState: JSON.parse(JSON.stringify(midMatch)),
    });
    resumed.start();

    expect(resumed.getState().players[HOST_SEAT].field.length).toBe(
      midMatch.players[HOST_SEAT].field.length,
    );
    expect(resumed.getState().turn).toBe(midMatch.turn);
    resumed.destroy();
  });
});

describe('match outcomes', () => {
  it('remembers how a match ended and gives it back by code', () => {
    rememberOutcome({
      code: 'END001',
      winner: GUEST_SEAT,
      seat: HOST_SEAT,
      reason: END_REASON.DISCONNECT,
      names: ['Alex', 'Sam'],
    });

    const recalled = recallOutcome('end001'); // case-insensitive, like the codes
    expect(recalled.winner).toBe(GUEST_SEAT);
    expect(recalled.reason).toBe(END_REASON.DISCONNECT);
    expect(recalled.names).toEqual(['Alex', 'Sam']);
  });

  it('knows nothing about a match it never saw end', () => {
    expect(recallOutcome('NEVER1')).toBe(null);
    expect(recallOutcome('')).toBe(null);
  });

  it('lets an ancient outcome go', () => {
    rememberOutcome({ code: 'OLD002', winner: 0, seat: 0, reason: 'x', now: () => 0 });
    expect(recallOutcome('OLD002', { now: () => 60 * 60 * 1000 })).toBe(null);
  });

  it('keeps only the most recent few, so storage cannot grow without bound', () => {
    for (let i = 0; i < 20; i += 1) {
      rememberOutcome({ code: `CODE${i}`, winner: 0, seat: 0, reason: 'x', now: () => 1000 + i });
    }
    const stored = JSON.parse(localStorage.getItem('pcg.online.outcomes'));
    expect(Object.keys(stored).length).toBeLessThanOrEqual(8);
    // The newest survived and the oldest did not.
    expect(recallOutcome('CODE19', { now: () => 1020 })).not.toBe(null);
    expect(recallOutcome('CODE0', { now: () => 1020 })).toBe(null);
  });

  it('clears cleanly', () => {
    rememberOutcome({ code: 'GONE01', winner: 0, seat: 0, reason: 'x' });
    clearOutcomes();
    clearHostMatch();
    expect(recallOutcome('GONE01')).toBe(null);
  });
});
