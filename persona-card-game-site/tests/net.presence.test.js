/**
 * Presence and the two match clocks.
 *
 * Every test here drives an injected clock rather than sleeping, so the 60s
 * grace period and the 5 minute turn cap are exercised at their real values in
 * about a millisecond.
 */
import { describe, it, expect } from 'vitest';
import {
  TIMING,
  createPresence,
  createMatchClocks,
  remainingMs,
  remainingSeconds,
  turnWarningActive,
  formatCountdown,
} from '../src/net/presence.js';

/** A clock you move by hand. */
function fakeClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      at += ms;
      return at;
    },
  };
}

describe('timing constants', () => {
  it('matches the specified values', () => {
    expect(TIMING.GRACE_PERIOD_MS).toBe(60 * 1000);
    expect(TIMING.TURN_CAP_MS).toBe(5 * 60 * 1000);
    expect(TIMING.TURN_WARN_MS).toBe(30 * 1000);
    expect(TIMING.TURN_TIMEOUT_FORFEIT_COUNT).toBe(2);
  });

  it('gives a peer several heartbeats of slack before calling them gone', () => {
    // A single dropped ping must never be enough to trigger the overlay.
    expect(TIMING.PEER_TIMEOUT_MS).toBeGreaterThan(TIMING.HEARTBEAT_MS * 2);
  });

  it('reserves a relay seat for longer than the grace period', () => {
    // A player reconnecting on the 59th second must still find their seat.
    expect(TIMING.SEAT_RESERVATION_MS).toBeGreaterThan(TIMING.GRACE_PERIOD_MS);
  });
});

describe('presence', () => {
  it('starts online and sends heartbeats once the interval has passed', () => {
    const clock = fakeClock();
    const sent = [];
    const presence = createPresence({ send: (m) => sent.push(m), now: clock.now });

    expect(presence.online).toBe(true);
    presence.tick();
    expect(sent).toHaveLength(0); // nothing due yet

    clock.advance(TIMING.HEARTBEAT_MS);
    presence.tick();
    expect(sent).toEqual([{ t: 'ping' }]);
  });

  it('answers a ping with a pong', () => {
    const sent = [];
    const presence = createPresence({ send: (m) => sent.push(m), now: fakeClock().now });
    presence.noteMessage({ t: 'ping' });
    expect(sent).toEqual([{ t: 'pong' }]);
  });

  it('treats any message as proof of life, not just heartbeats', () => {
    const clock = fakeClock();
    const presence = createPresence({ send: () => {}, now: clock.now });

    clock.advance(TIMING.PEER_TIMEOUT_MS - 1);
    // A real action arriving is the strongest evidence there is.
    presence.noteMessage({ t: 'action', action: { type: 'END_TURN' } });
    clock.advance(TIMING.PEER_TIMEOUT_MS - 1);
    presence.tick();

    expect(presence.online).toBe(true);
  });

  it('goes offline after the peer timeout and reports when it happened', () => {
    const clock = fakeClock();
    const presence = createPresence({ send: () => {}, now: clock.now });

    clock.advance(TIMING.PEER_TIMEOUT_MS);
    presence.tick();

    expect(presence.online).toBe(false);
    expect(presence.offlineSince).toBe(clock.now());
  });

  it('notifies listeners on each change, and not on repeats', () => {
    const clock = fakeClock();
    const presence = createPresence({ send: () => {}, now: clock.now });
    const changes = [];
    presence.onChange((c) => changes.push(c.online));

    presence.markPeerGone();
    presence.markPeerGone(); // already gone; not a change
    presence.noteMessage({ t: 'state' });

    expect(changes).toEqual([false, true]);
  });

  it('comes back online only on a real message, never on a hint', () => {
    const presence = createPresence({ send: () => {}, now: fakeClock().now });
    presence.markPeerGone();
    expect(presence.online).toBe(false);

    // There is no "markPeerBack" by design: absence can be guessed at, presence
    // has to be proven.
    presence.noteMessage({ t: 'pong' });
    expect(presence.online).toBe(true);
  });

  it('treats a failing transport as the peer being unreachable', () => {
    const clock = fakeClock();
    const presence = createPresence({
      send: () => {
        throw new Error('socket is closed');
      },
      now: clock.now,
    });

    clock.advance(TIMING.HEARTBEAT_MS);
    presence.tick();
    expect(presence.online).toBe(false);
  });

  it('goes quiet once stopped', () => {
    const clock = fakeClock();
    const sent = [];
    const presence = createPresence({ send: (m) => sent.push(m), now: clock.now });
    presence.stop();

    clock.advance(TIMING.PEER_TIMEOUT_MS * 2);
    presence.tick();
    expect(sent).toHaveLength(0);
    expect(presence.online).toBe(true); // never demoted after stop
  });
});

describe('match clocks', () => {
  it('expires the turn cap exactly at five minutes', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });
    clocks.startTurn('t1');

    clock.advance(TIMING.TURN_CAP_MS - 1);
    expect(clocks.due()).toBe(null);

    clock.advance(1);
    expect(clocks.due()).toEqual({ kind: 'turn', key: 't1' });
  });

  it('expires the grace period exactly at sixty seconds', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });
    clocks.startGrace(1);

    clock.advance(TIMING.GRACE_PERIOD_MS - 1);
    expect(clocks.due()).toBe(null);

    clock.advance(1);
    expect(clocks.due()).toEqual({ kind: 'grace', seat: 1 });
  });

  /* --- the independence rule, which is the anti-grief mechanism --- */

  it('does not pause the turn cap while a player is disconnected', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });
    clocks.startTurn('t1');

    // Drop, wait almost the whole grace window, come back.
    clock.advance(60 * 1000);
    clocks.startGrace(0);
    clock.advance(59 * 1000);
    clocks.clearGrace();

    // The turn cap counted every second of that.
    const snap = clocks.snapshot();
    expect(snap.turnDeadline - clock.now()).toBe(TIMING.TURN_CAP_MS - 119 * 1000);
  });

  it('cannot be extended by repeatedly dropping and reconnecting', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });
    clocks.startTurn('t1');
    const deadline = clocks.snapshot().turnDeadline;

    // Four disconnect/reconnect cycles of 50s each: 200s of stalling.
    for (let i = 0; i < 4; i += 1) {
      clocks.startGrace(0);
      clock.advance(50 * 1000);
      clocks.clearGrace();
    }

    // The turn deadline never moved, so the cap still fires on schedule.
    expect(clocks.snapshot().turnDeadline).toBe(deadline);
    clock.advance(TIMING.TURN_CAP_MS - 200 * 1000);
    expect(clocks.due()).toEqual({ kind: 'turn', key: 't1' });
  });

  it('gives a fresh grace window to each separate disconnect', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });

    clocks.startGrace(0);
    clock.advance(59 * 1000);
    clocks.clearGrace(); // made it back with a second to spare

    clocks.startGrace(0);
    clock.advance(59 * 1000);
    expect(clocks.due()).toBe(null); // a full 60 again, not the leftover second
  });

  it('does not restart the grace clock while it is already running', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });

    clocks.startGrace(0);
    clock.advance(30 * 1000);
    clocks.startGrace(0); // a second report of the same disconnect
    clock.advance(30 * 1000);

    expect(clocks.due()).toEqual({ kind: 'grace', seat: 0 });
  });

  it('reports grace ahead of the turn cap when both are due at once', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });

    clocks.startTurn('t1');
    clock.advance(TIMING.TURN_CAP_MS - TIMING.GRACE_PERIOD_MS);
    clocks.startGrace(1);
    clock.advance(TIMING.GRACE_PERIOD_MS);

    // Both deadlines land on this exact tick; the disconnect is the real story.
    expect(clocks.due()).toEqual({ kind: 'grace', seat: 1 });
  });

  /* --- timeouts and forfeiting --- */

  it('forfeits on the second timeout, counting cumulatively', () => {
    const clocks = createMatchClocks({ now: fakeClock().now });

    expect(clocks.noteTimeout(0)).toBe(false); // first is a warning
    expect(clocks.noteTimeout(1)).toBe(false); // the other seat counts separately
    expect(clocks.noteTimeout(0)).toBe(true); // second for seat 0 ends it
  });

  it('does not reset a timeout count on the turns in between', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });

    clocks.noteTimeout(0);
    // A dozen perfectly normal turns in between.
    for (let i = 0; i < 12; i += 1) clocks.startTurn(`t${i}`);
    expect(clocks.noteTimeout(0)).toBe(true);
  });

  it('keys the turn cap so a stale expiry cannot fire against a new turn', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });

    clocks.startTurn('t1');
    clock.advance(TIMING.TURN_CAP_MS);
    expect(clocks.due()).toEqual({ kind: 'turn', key: 't1' });

    clocks.startTurn('t2'); // auto-passed; next player gets a full turn
    expect(clocks.due()).toBe(null);
    expect(clocks.snapshot().turnDeadline - clock.now()).toBe(TIMING.TURN_CAP_MS);
  });

  it('stops entirely once the turn is cleared', () => {
    const clock = fakeClock();
    const clocks = createMatchClocks({ now: clock.now });
    clocks.startTurn('t1');
    clocks.clearTurn();

    clock.advance(TIMING.TURN_CAP_MS * 3);
    expect(clocks.due()).toBe(null);
  });
});

describe('countdown rendering', () => {
  it('floors remaining time at zero rather than going negative', () => {
    const clock = fakeClock();
    expect(remainingMs(clock.now() - 5000, { now: clock.now })).toBe(0);
  });

  it('corrects for a guest clock that disagrees with the host', () => {
    const clock = fakeClock();
    const deadline = clock.now() + 60 * 1000;
    // This guest's clock runs 30s fast; without correction they would see 30s.
    expect(remainingMs(deadline, { now: clock.now, skew: -30 * 1000 })).toBe(90 * 1000);
  });

  it('rounds seconds up so a countdown ends on 1, not 0', () => {
    const clock = fakeClock();
    expect(remainingSeconds(clock.now() + 1, { now: clock.now })).toBe(1);
  });

  it('hides the turn countdown until the last thirty seconds', () => {
    const clock = fakeClock();
    const deadline = clock.now() + TIMING.TURN_CAP_MS;

    expect(turnWarningActive(deadline, { now: clock.now })).toBe(false);
    clock.advance(TIMING.TURN_CAP_MS - TIMING.TURN_WARN_MS - 1);
    expect(turnWarningActive(deadline, { now: clock.now })).toBe(false);
    clock.advance(1);
    expect(turnWarningActive(deadline, { now: clock.now })).toBe(true);
  });

  it('never shows a turn countdown when there is no turn deadline', () => {
    expect(turnWarningActive(null)).toBe(false);
  });

  it('formats the grace countdown across the minute boundary', () => {
    expect(formatCountdown(60 * 1000)).toBe('1:00');
    expect(formatCountdown(64 * 1000)).toBe('1:04');
    expect(formatCountdown(9 * 1000)).toBe('9');
    expect(formatCountdown(0)).toBe('0');
  });
});
