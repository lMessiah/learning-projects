/**
 * The connection overlays on a real board.
 *
 * The two properties worth protecting here are the ones that are easy to break
 * accidentally: the countdown must survive the board rebuilding its own DOM,
 * and the turn-cap countdown must stay hidden for almost all of every turn.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountPresenceOverlay } from '../src/ui/game/presenceOverlay.js';
import { TIMING } from '../src/net/presence.js';
import { HOST_SEAT, GUEST_SEAT } from '../src/net/onlineMatch.js';

/** A stand-in for the session, with deadlines the test sets directly. */
function fakePresence(initial = {}) {
  let state = {
    opponentOnline: true,
    graceDeadline: null,
    turnDeadline: null,
    disconnectedSeat: null,
    timeouts: [0, 0],
    selfOnline: true,
    skew: 0,
    ...initial,
  };
  const listeners = new Set();
  return {
    presenceState: () => state,
    onPresenceChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      state = { ...state, ...next };
      for (const fn of listeners) fn(state);
    },
  };
}

const fakeController = (state) => ({ getState: () => state });

const playing = (activePlayer = HOST_SEAT) => ({
  phase: 'playing',
  activePlayer,
  winner: null,
  players: [{ name: 'Alex', field: [] }, { name: 'Sam', field: [] }],
});

let root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  vi.useRealTimers();
  root.remove();
});

describe('the reconnect overlay', () => {
  it('stays hidden while both players are connected', () => {
    const presence = fakePresence();
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });

    expect(root.querySelector('.net-pause').hidden).toBe(true);
  });

  it('appears with a countdown when the opponent drops', () => {
    const presence = fakePresence();
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });

    presence.set({
      opponentOnline: false,
      disconnectedSeat: GUEST_SEAT,
      graceDeadline: Date.now() + TIMING.GRACE_PERIOD_MS,
    });

    const pause = root.querySelector('.net-pause');
    expect(pause.hidden).toBe(false);
    expect(pause.querySelector('.net-pause__title').textContent).toMatch(/opponent reconnecting/i);
    expect(pause.querySelector('.net-pause__count').textContent).toBe('1:00');
  });

  it('counts down as time passes', () => {
    const presence = fakePresence({
      opponentOnline: false,
      disconnectedSeat: GUEST_SEAT,
      graceDeadline: Date.now() + TIMING.GRACE_PERIOD_MS,
    });
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });

    vi.advanceTimersByTime(45_000);
    expect(root.querySelector('.net-pause__count').textContent).toBe('15');

    // The last ten seconds are marked, without anything moving on screen.
    vi.advanceTimersByTime(6_000);
    expect(root.querySelector('.net-pause__count').classList.contains('net-pause__count--urgent')).toBe(true);
  });

  it('says something different when it is OUR connection that dropped', () => {
    const presence = fakePresence({
      selfOnline: false,
      graceDeadline: Date.now() + TIMING.GRACE_PERIOD_MS,
      disconnectedSeat: HOST_SEAT,
    });
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: GUEST_SEAT });

    expect(root.querySelector('.net-pause__title').textContent).toMatch(/^reconnecting/i);
  });

  it('disappears the moment they come back', () => {
    const presence = fakePresence({
      opponentOnline: false,
      disconnectedSeat: GUEST_SEAT,
      graceDeadline: Date.now() + TIMING.GRACE_PERIOD_MS,
    });
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });
    expect(root.querySelector('.net-pause').hidden).toBe(false);

    presence.set({ opponentOnline: true, graceDeadline: null, disconnectedSeat: null });
    expect(root.querySelector('.net-pause').hidden).toBe(true);
  });

  it('corrects a countdown for a clock that disagrees with the host', () => {
    // This machine's clock is 30s fast. Uncorrected, the player would see the
    // countdown start at 30 rather than 60.
    const presence = fakePresence({
      opponentOnline: false,
      disconnectedSeat: GUEST_SEAT,
      graceDeadline: Date.now() + TIMING.GRACE_PERIOD_MS - 30_000,
      skew: -30_000,
    });
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });

    expect(root.querySelector('.net-pause__count').textContent).toBe('1:00');
  });

  it('is removed cleanly on unmount', () => {
    const presence = fakePresence();
    const unmount = mountPresenceOverlay(root, {
      presence,
      controller: fakeController(playing()),
      viewer: HOST_SEAT,
    });
    unmount();
    expect(root.querySelector('.net-pause')).toBe(null);
    expect(root.querySelector('.turn-warning')).toBe(null);
  });
});

describe('the turn cap countdown', () => {
  it('shows nothing for the bulk of a turn', () => {
    const presence = fakePresence({ turnDeadline: Date.now() + TIMING.TURN_CAP_MS });
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });

    expect(root.querySelector('.turn-warning').hidden).toBe(true);

    // Four and a half minutes in, still nothing. This is the whole point: the
    // cap is an anti-grief backstop, not a chess clock.
    vi.advanceTimersByTime(TIMING.TURN_CAP_MS - TIMING.TURN_WARN_MS - 1000);
    expect(root.querySelector('.turn-warning').hidden).toBe(true);
  });

  it('reveals itself for the final thirty seconds', () => {
    const presence = fakePresence({ turnDeadline: Date.now() + TIMING.TURN_CAP_MS });
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });

    vi.advanceTimersByTime(TIMING.TURN_CAP_MS - TIMING.TURN_WARN_MS + 500);

    const warning = root.querySelector('.turn-warning');
    expect(warning.hidden).toBe(false);
    expect(Number(warning.querySelector('.turn-warning__count').textContent)).toBeLessThanOrEqual(30);
    expect(warning.classList.contains('turn-warning--yours')).toBe(true);
  });

  it('labels it differently when it is the opponent stalling', () => {
    const presence = fakePresence({ turnDeadline: Date.now() + TIMING.TURN_WARN_MS - 1000 });
    // Viewer is the host; the guest is on turn.
    mountPresenceOverlay(root, {
      presence,
      controller: fakeController(playing(GUEST_SEAT)),
      viewer: HOST_SEAT,
    });

    const warning = root.querySelector('.turn-warning');
    expect(warning.hidden).toBe(false);
    expect(warning.querySelector('.turn-warning__label').textContent).toMatch(/opponent/i);
    expect(warning.classList.contains('turn-warning--yours')).toBe(false);
  });

  it('keeps counting through a disconnect, because the cap does not pause', () => {
    const presence = fakePresence({
      turnDeadline: Date.now() + TIMING.TURN_WARN_MS - 5000,
      opponentOnline: false,
      disconnectedSeat: GUEST_SEAT,
      graceDeadline: Date.now() + TIMING.GRACE_PERIOD_MS,
    });
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });

    // Both are on screen at once. Hiding the turn clock behind the pause overlay
    // would misrepresent the rule that it keeps running.
    expect(root.querySelector('.net-pause').hidden).toBe(false);
    expect(root.querySelector('.turn-warning').hidden).toBe(false);
  });

  it('goes away once the match is over', () => {
    const presence = fakePresence({ turnDeadline: Date.now() + 5000 });
    const state = { ...playing(), winner: HOST_SEAT };
    mountPresenceOverlay(root, { presence, controller: fakeController(state), viewer: HOST_SEAT });

    expect(root.querySelector('.turn-warning').hidden).toBe(true);
  });
});

describe('living alongside the board', () => {
  /**
   * The board rebuilds its entire DOM on every state change. If the overlay
   * lived inside that subtree it would be destroyed four times a second during
   * a countdown — which is exactly why it is mounted as a sibling.
   */
  it('survives the board screen being torn down and rebuilt', () => {
    const screen = document.createElement('div');
    screen.className = 'board-screen';
    root.appendChild(screen);

    const presence = fakePresence({
      opponentOnline: false,
      disconnectedSeat: GUEST_SEAT,
      graceDeadline: Date.now() + TIMING.GRACE_PERIOD_MS,
    });
    mountPresenceOverlay(root, { presence, controller: fakeController(playing()), viewer: HOST_SEAT });

    // What `rerender` does.
    screen.innerHTML = '';
    screen.appendChild(document.createElement('div'));

    const pause = root.querySelector('.net-pause');
    expect(pause).not.toBe(null);
    expect(pause.hidden).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(pause.querySelector('.net-pause__count').textContent).toBe('59');
  });

  it('does nothing at all when no presence is supplied', () => {
    const unmount = mountPresenceOverlay(root, { presence: null, viewer: HOST_SEAT });
    expect(root.querySelector('.net-pause')).toBe(null);
    expect(() => unmount()).not.toThrow();
  });
});
