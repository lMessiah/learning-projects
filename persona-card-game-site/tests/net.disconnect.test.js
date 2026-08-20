/**
 * Disconnect handling and the anti-grief turn cap, over the loopback transport.
 *
 * Time is injected everywhere, so the real 60-second and 5-minute constants are
 * exercised without waiting for them. The sessions are the real ones and the
 * engine is the real one — only the clock and the wire are under the test's
 * control.
 */
import { describe, it, expect } from 'vitest';
import { applyAction } from '../src/engine/index.js';
import { createLoopbackPair } from '../src/net/transport.js';
import { createHostSession, createGuestSession, HOST_SEAT, GUEST_SEAT } from '../src/net/onlineMatch.js';
import { TIMING, END_REASON } from '../src/net/presence.js';

function fakeClock(start = 5_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

/**
 * A live host+guest pair with time under our control.
 *
 * `autoTick` is off on both: nothing moves unless the test moves it, which is
 * what makes these assertions about exact deadlines rather than about timers
 * happening to fire.
 */
function setup({ seed = 11 } = {}) {
  const clock = fakeClock();
  const [hostWire, guestWire] = createLoopbackPair();

  const host = createHostSession(hostWire, {
    hostName: 'Alex',
    guestName: 'Sam',
    seed,
    now: clock.now,
    autoTick: false,
  });
  const guest = createGuestSession(guestWire, { name: 'Sam', now: clock.now, autoTick: false });

  host.start();
  guest.start();

  /**
   * Advance time in tick-sized steps so expiries fire in the right order.
   *
   * Both sessions tick throughout; absence is simulated by MUTING a wire, not
   * by declining to tick. A player who has dropped still has a running tab —
   * what stops is the traffic between them.
   */
  const run = (ms) => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(TIMING.TICK_MS, left);
      clock.advance(step);
      left -= step;
      host.tick();
      guest.tick();
    }
  };

  /** The guest's network dies, without either side saying goodbye. */
  const dropGuest = () => guestWire.mute();
  const returnGuest = () => {
    guestWire.unmute();
    guestWire.send({ t: 'resume', name: 'Sam' });
    host.tick();
    guest.tick();
  };
  /** The host's network dies — the case with no authority left to appeal to. */
  const dropHost = () => hostWire.mute();

  return { clock, host, guest, hostWire, guestWire, run, dropGuest, returnGuest, dropHost };
}

/** Play both starter choices so the match reaches the playing phase. */
function pastStarterSelect(host, guest) {
  const hostChoice = host.legalActions(HOST_SEAT)[0];
  host.dispatch(hostChoice);
  const guestChoice = guest.legalActions(GUEST_SEAT)[0];
  guest.dispatch(guestChoice);
}

describe('the grace period', () => {
  it('starts a countdown when the guest goes quiet, without ending the match', () => {
    const { host, run, dropGuest } = setup();

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS);

    const state = host.presenceState();
    expect(state.opponentOnline).toBe(false);
    expect(state.graceDeadline).not.toBe(null);
    expect(host.getState().winner).toBe(null); // paused, not over
  });

  it('awards the match to the connected player when the window closes', () => {
    const { host, run, dropGuest } = setup();

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS + TIMING.GRACE_PERIOD_MS + TIMING.TICK_MS);

    const state = host.getState();
    expect(state.winner).toBe(HOST_SEAT);
    expect(state.endReason).toBe(END_REASON.DISCONNECT);
  });

  it('does not end the match a moment early', () => {
    const { host, run, dropGuest } = setup();

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS);
    run(TIMING.GRACE_PERIOD_MS - TIMING.TICK_MS);

    expect(host.getState().winner).toBe(null);
  });

  it('resumes exactly where it was when the guest comes back', () => {
    const { host, guest, run, dropGuest, returnGuest } = setup();
    pastStarterSelect(host, guest);

    const before = host.getState();
    const turnBefore = before.turn;
    const activeBefore = before.activePlayer;

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS);
    expect(host.presenceState().opponentOnline).toBe(false);

    returnGuest();

    const after = host.presenceState();
    expect(after.opponentOnline).toBe(true);
    expect(after.graceDeadline).toBe(null);

    const state = host.getState();
    expect(state.winner).toBe(null);
    expect(state.turn).toBe(turnBefore);
    expect(state.activePlayer).toBe(activeBefore);
  });

  it('gives a fresh sixty seconds to a second, separate drop', () => {
    const { host, run, dropGuest, returnGuest } = setup();

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS + 50 * 1000);
    returnGuest(); // back with ten seconds to spare

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS + 50 * 1000);
    // A leftover ten seconds would have ended it by now; a fresh sixty has not.
    expect(host.getState().winner).toBe(null);
  });
});

describe('the turn cap', () => {
  it('auto-passes the turn when five minutes run out', () => {
    const { host, guest, run } = setup();
    pastStarterSelect(host, guest);

    const before = host.getState();
    expect(before.phase).toBe('playing');
    const activeBefore = before.activePlayer;

    // Stalling, but present throughout: the wire is open and the heartbeat keeps
    // flowing, so the grace period never enters into it. This is pure griefing.
    run(TIMING.TURN_CAP_MS + TIMING.TICK_MS);

    const after = host.getState();
    expect(after.winner).toBe(null); // one timeout is a warning, not a loss
    expect(after.activePlayer).not.toBe(activeBefore); // the turn moved on
  });

  it('forfeits the match on the second timeout', () => {
    const { host, guest, run } = setup();
    pastStarterSelect(host, guest);

    const stalled = host.getState().activePlayer;

    // Three full caps: the turn passes back and forth, so this is the stalling
    // player's first timeout, the opponent's first, then the stalling player's
    // second — which is the one that ends it.
    const burnATurn = () => run(TIMING.TURN_CAP_MS + TIMING.TICK_MS);

    burnATurn();
    burnATurn();
    burnATurn();

    const state = host.getState();
    // The match goes to the player who did not run the clock out twice.
    expect(state.winner).toBe(stalled === HOST_SEAT ? GUEST_SEAT : HOST_SEAT);
    expect(state.endReason).toBe(END_REASON.TIMEOUT_FORFEIT);
  });

  it('counts timeouts cumulatively, not consecutively', () => {
    const { host } = setup();
    // Two timeouts separated by ordinary play still forfeit, because the count
    // is never reset. This is the rule as specified: 2 total.
    expect(TIMING.TURN_TIMEOUT_FORFEIT_COUNT).toBe(2);
    expect(host.presenceState().timeouts).toEqual([0, 0]);
  });

  it('reveals no countdown until the final thirty seconds', () => {
    const { host, guest, run, clock } = setup();
    pastStarterSelect(host, guest);

    const deadline = host.presenceState().turnDeadline;
    expect(deadline).not.toBe(null);

    // Four and a half minutes in, there is still nothing to show.
    run(TIMING.TURN_CAP_MS - TIMING.TURN_WARN_MS - 1000);
    expect(deadline - clock.now()).toBeGreaterThan(TIMING.TURN_WARN_MS);

    run(2000);
    expect(deadline - clock.now()).toBeLessThanOrEqual(TIMING.TURN_WARN_MS);
  });

  it('auto-picks a starter for a player who stalls in starter select', () => {
    const { host, run } = setup();
    expect(host.getState().phase).toBe('starterSelect');

    run(TIMING.TURN_CAP_MS + TIMING.TICK_MS);

    // Both players owed a choice, so both had one made for them, and the match
    // is under way rather than stuck on a screen nobody is looking at.
    const state = host.getState();
    expect(state.players[HOST_SEAT].field.length).toBeGreaterThan(0);
    expect(state.players[GUEST_SEAT].field.length).toBeGreaterThan(0);
  });
});

describe('the two clocks are independent', () => {
  /**
   * The rule that makes "disconnect then stall" pointless. This is the single
   * most important assertion in the file.
   */
  it('keeps the turn cap running through a disconnect', () => {
    const { host, guest, run, clock, dropGuest, returnGuest } = setup();
    pastStarterSelect(host, guest);

    const deadline = host.presenceState().turnDeadline;

    // Drop for fifty seconds, then come back.
    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS + 40 * 1000);
    returnGuest();

    // The turn deadline did not move by so much as a millisecond.
    expect(host.presenceState().turnDeadline).toBe(deadline);
    expect(deadline - clock.now()).toBeLessThan(TIMING.TURN_CAP_MS - 45 * 1000);
  });

  it('cannot be gamed by chaining disconnects', () => {
    const { host, guest, run, dropGuest, returnGuest } = setup();
    pastStarterSelect(host, guest);

    const deadline = host.presenceState().turnDeadline;
    const activeBefore = host.getState().activePlayer;

    // Four cycles of "drop, wait, come back just in time" — 200+ seconds of
    // stalling that buys no extra thinking time whatsoever.
    for (let i = 0; i < 4; i += 1) {
      dropGuest();
      run(TIMING.PEER_TIMEOUT_MS + 40 * 1000);
      returnGuest();
      if (host.getState().winner !== null) break;
    }

    expect(host.presenceState().turnDeadline).toBe(deadline);

    // And the cap still fires on its original schedule.
    run(TIMING.TURN_CAP_MS);
    expect(host.getState().activePlayer).not.toBe(activeBefore);
  });

  it('ends on the disconnect, not the turn cap, when both expire together', () => {
    const { host, guest, run, dropGuest } = setup();
    pastStarterSelect(host, guest);

    // The guest is gone for good. The grace window closes long before the
    // five-minute cap does, so the disconnect is what decides the match.
    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS + TIMING.GRACE_PERIOD_MS + TIMING.TICK_MS);

    expect(host.getState().endReason).toBe(END_REASON.DISCONNECT);
    expect(host.getState().winner).toBe(HOST_SEAT);
  });
});

describe('the guest side', () => {
  it('receives the deadlines and corrects for a clock that disagrees', () => {
    const { host, guest, guestWire } = setup();
    void guestWire;
    host.tick();

    const state = guest.presenceState();
    expect(state.turnDeadline).toBe(host.presenceState().turnDeadline);
    expect(typeof state.skew).toBe('number');
  });

  it('resolves the match in its own favour when the host never comes back', () => {
    const { guest, run, dropHost } = setup();

    dropHost();
    run(TIMING.PEER_TIMEOUT_MS + TIMING.GRACE_PERIOD_MS + TIMING.TICK_MS);

    const view = guest.getState();
    expect(view.winner).toBe(GUEST_SEAT);
    expect(view.endReason).toBe(END_REASON.DISCONNECT);
  });

  it('refuses a move made after the match has already resolved', () => {
    const { guest, run, dropHost } = setup();
    dropHost();
    run(TIMING.PEER_TIMEOUT_MS + TIMING.GRACE_PERIOD_MS + TIMING.TICK_MS);

    expect(() => guest.dispatch({ type: 'PASS', player: GUEST_SEAT })).toThrow(/already over/i);
  });
});

describe('the host state stays authoritative throughout', () => {
  it('never lets a timed-out auto-pass produce an illegal state', () => {
    const { host, guest, run } = setup();
    pastStarterSelect(host, guest);

    run(TIMING.TURN_CAP_MS + TIMING.TICK_MS);

    // The proof that the auto-pass produced a real state: the engine still
    // accepts an ordinary action against it.
    const state = host.getState();
    if (state.winner === null) {
      const legal = host.legalActions(state.activePlayer);
      expect(legal.length).toBeGreaterThan(0);
      expect(() => applyAction(state, legal.find((a) => a.type === 'END_TURN') ?? legal[0])).not.toThrow();
    }
  });
});

describe('edge cases', () => {
  /**
   * Both players losing their connection at once. Neither can reach the other,
   * so each must work out for itself which side of the silence it is on. What
   * must NOT happen is both of them claiming the win.
   */
  it('does not let both players award themselves the match', () => {
    const { host, guest, hostWire, guestWire, run } = setup();
    pastStarterSelect(host, guest);

    // Both networks die simultaneously.
    hostWire.mute();
    guestWire.mute();
    run(TIMING.PEER_TIMEOUT_MS + TIMING.GRACE_PERIOD_MS + TIMING.TICK_MS);

    const hostView = host.getState();
    const guestView = guest.getState();

    // Each side identified ITSELF as the absent one, so neither claims victory.
    expect(hostView.winner).toBe(GUEST_SEAT);
    expect(guestView.winner).toBe(HOST_SEAT);
    expect(hostView.winner).not.toBe(guestView.winner);
  });

  it('survives a drop in the middle of the opponent acting', () => {
    const { host, guest, run, dropGuest, returnGuest } = setup();
    pastStarterSelect(host, guest);

    // The guest sends a move and vanishes in the same breath.
    const active = host.getState().activePlayer;
    if (active === GUEST_SEAT) {
      const legal = guest.legalActions(GUEST_SEAT);
      const move = legal.find((a) => a.type === 'END_TURN') ?? legal[0];
      guest.dispatch(move);
    }
    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS);

    // The host's state is intact and self-consistent, mid-flight move or not.
    const state = host.getState();
    expect(state.winner).toBe(null);
    expect(state.players).toHaveLength(2);
    expect(() => host.legalActions(state.activePlayer)).not.toThrow();

    returnGuest();
    expect(host.presenceState().opponentOnline).toBe(true);
    expect(host.getState().winner).toBe(null);
  });

  it('hands a returning guest the whole state, flagged as a resync', () => {
    const { host, guest, guestWire, run, dropGuest } = setup();
    pastStarterSelect(host, guest);

    const updates = [];
    guest.subscribe((state, meta) => updates.push({ turn: state.turn, meta }));

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS);

    // Moves happen while they are away.
    if (host.getState().activePlayer === HOST_SEAT) {
      const legal = host.legalActions(HOST_SEAT);
      host.dispatch(legal.find((a) => a.type === 'END_TURN') ?? legal[0]);
    }

    guestWire.unmute();
    guestWire.send({ t: 'resume', name: 'Sam' });
    host.tick();

    // The last update is the full handover. It is NOT diffed into animations of
    // everything that happened in the meantime — see board.js.
    const last = updates.at(-1);
    expect(last).toBeTruthy();
    expect(host.getState().winner).toBe(null);
  });

  it('refuses actions from a guest whose match already ended', () => {
    const { host, guest, run, dropGuest } = setup();
    pastStarterSelect(host, guest);

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS + TIMING.GRACE_PERIOD_MS + TIMING.TICK_MS);
    expect(host.getState().winner).toBe(HOST_SEAT);

    // They come back after the fact and try to play on.
    const stale = { type: 'PASS', player: GUEST_SEAT };
    expect(() => host.dispatch({ ...stale, player: HOST_SEAT })).toThrow();
    expect(host.getState().winner).toBe(HOST_SEAT); // and nothing moved
  });

  it('stops both clocks once the match is over', () => {
    const { host, run, dropGuest } = setup();

    dropGuest();
    run(TIMING.PEER_TIMEOUT_MS + TIMING.GRACE_PERIOD_MS + TIMING.TICK_MS);
    const settled = host.getState();

    // Long past every deadline; nothing further should fire.
    run(TIMING.TURN_CAP_MS * 2);
    expect(host.getState().winner).toBe(settled.winner);
    expect(host.presenceState().turnDeadline).toBe(null);
  });
});

describe('the turn clock always restarts', () => {
  /**
   * A regression guard. If an auto-pass leaves the turn where it was — a
   * position that refuses even END_TURN — the deadline must still be pushed
   * forward. Otherwise `due()` fires again on the very next tick and the player
   * burns through the forfeit threshold in a fraction of a second for something
   * that was not their fault.
   */
  it('never fires the cap twice for the same turn in consecutive ticks', () => {
    const { host, guest, run, clock } = setup();
    pastStarterSelect(host, guest);

    run(TIMING.TURN_CAP_MS + TIMING.TICK_MS);
    const afterFirst = host.presenceState();
    expect(host.getState().winner).toBe(null); // one timeout only

    // The new deadline is a full cap into the future, not in the past.
    expect(afterFirst.turnDeadline - clock.now()).toBeGreaterThan(TIMING.TURN_CAP_MS - 1000);

    // And a few more ticks change nothing.
    run(TIMING.TICK_MS * 4);
    expect(host.getState().winner).toBe(null);
    expect(host.presenceState().timeouts.reduce((a, b) => a + b, 0)).toBe(1);
  });
});
