/**
 * Presence and match clocks — disconnect handling and the anti-grief backstop.
 *
 * This module is the single home for every timing value in online play, and it
 * is deliberately free of both DOM and transport. It exports three things:
 *
 *   TIMING          - the tunable constants, all of them, at the top
 *   createPresence  - "is my opponent there?", built on a heartbeat
 *   createMatchClocks - the grace clock and the turn cap, kept independent
 *
 * WHY NOT FIREBASE. The brief asked for Firebase presence/onDisconnect. This
 * project has no Firebase and no accounts — online play is the relay in
 * server/relay.js plus a WebRTC fallback, and adding a hosted database purely
 * to answer "is the socket alive?" would buy nothing the relay cannot already
 * tell us. So the SEMANTICS of onDisconnect are implemented here instead: a
 * client publishes liveness continuously, and when it stops, the other side is
 * told promptly rather than waiting on a TCP timeout. `createPresence` is the
 * seam — swapping in an RTDB-backed implementation later means writing another
 * object with the same four members and changing nothing above it.
 *
 * THE TWO CLOCKS ARE INDEPENDENT, and that independence is the anti-grief rule:
 *
 *   grace  - runs ONLY while a player is actually disconnected. Reconnect and
 *            it is thrown away entirely; the next disconnect starts a fresh 60.
 *   turn   - runs for the WHOLE turn, connection or no connection. Never paused,
 *            never extended, not by a disconnect and not by the grace period.
 *
 * That is what stops "disconnect, then stall, then disconnect again" from
 * freezing a match: the turn cap is burning the entire time the grace overlay
 * is up, so a player who drops at the start of their turn has less time to
 * think when they get back, not more.
 */

/* ------------------------------------------------------------------ *
 * Tunable constants — everything with a duration lives here
 * ------------------------------------------------------------------ */

export const TIMING = {
  /**
   * How long a disconnected player has to come back before they lose the match.
   * The opponent watches this count down.
   */
  GRACE_PERIOD_MS: 60 * 1000,

  /**
   * Hard limit on a single turn, regardless of connection state. Reaching it
   * auto-passes the turn. This is an anti-griefing backstop, not a chess clock —
   * it is set far above how long a real turn takes.
   */
  TURN_CAP_MS: 5 * 60 * 1000,

  /**
   * How much of the turn cap remains when the countdown becomes visible. Before
   * this point the player is shown NOTHING: a permanent timer turns every turn
   * into a stress test, which is the opposite of what the cap is for.
   */
  TURN_WARN_MS: 30 * 1000,

  /**
   * How many full turn-cap timeouts a player may accrue before forfeiting.
   *
   * Counted CUMULATIVELY across the match, not consecutively: two timeouts with
   * a normal turn in between is still a player wasting ten minutes of someone
   * else's evening. Set to 2, so the first timeout is a warning and the second
   * ends the match.
   */
  TURN_TIMEOUT_FORFEIT_COUNT: 2,

  /* --- mechanism, rather than rules --- */

  /** How often each side announces it is alive. */
  HEARTBEAT_MS: 3 * 1000,

  /**
   * Silence after which a peer is presumed gone and the grace period starts.
   *
   * Several heartbeats wide so that one dropped packet, a garbage collection
   * pause, or a browser throttling a backgrounded tab does not put a perfectly
   * healthy opponent behind a "reconnecting" overlay.
   */
  PEER_TIMEOUT_MS: 10 * 1000,

  /** How often the clocks are examined for expiry, and the countdown redrawn. */
  TICK_MS: 250,

  /** Backoff between attempts to re-dial the relay after an unexpected close. */
  RECONNECT_BACKOFF_MS: [500, 1000, 2000, 3000, 5000],

  /**
   * How long the relay holds a vacated seat before releasing the room. Comfortably
   * wider than the grace period: the seat must still be there for a player who
   * reconnects on the 59th second, and the room is swept immediately once both
   * sides are gone for good.
   */
  SEAT_RESERVATION_MS: 90 * 1000,
};

/**
 * Why a match ended through this module rather than through play. Kept as
 * constants because they cross the wire and end up in the result screen.
 */
export const END_REASON = {
  DISCONNECT: 'opponent-disconnected',
  TIMEOUT_FORFEIT: 'turn-timeout-forfeit',
};

/* ------------------------------------------------------------------ *
 * Presence
 * ------------------------------------------------------------------ */

/**
 * Track whether the peer is alive, using a heartbeat over any transport.
 *
 * This is the `onDisconnect` equivalent. Two independent signals feed it:
 *
 *  1. HEARTBEAT SILENCE. Each side sends `{ t:'ping' }` on an interval and
 *     answers one with `{ t:'pong' }`. Either message counts as proof of life —
 *     answering is not required to be seen as alive, so a peer that is busy
 *     animating still reads as present. Silence past PEER_TIMEOUT_MS is the
 *     disconnect.
 *
 *  2. AN EXPLICIT HINT. The relay reports a closed socket immediately
 *     (`markPeerGone`), and the local transport reports its own close. Neither
 *     is required for correctness — the heartbeat would catch it a few seconds
 *     later — but they make the common case feel instant instead of laggy.
 *
 * Note the asymmetry: going OFFLINE can be signalled, but coming back ONLINE is
 * only ever proven by an actual message arriving. A hint cannot resurrect a peer
 * that is not really there.
 *
 * @param send   (message) => void, may throw when the transport is down
 * @param now    injectable clock, so tests do not sleep
 */
export function createPresence({ send, now = () => Date.now(), timing = TIMING } = {}) {
  let lastSeen = now();
  let online = true;
  let stopped = false;
  /** When the peer went away, or null while they are here. Drives the grace clock. */
  let offlineSince = null;

  const listeners = new Set();

  const setOnline = (next) => {
    if (stopped || next === online) return;
    online = next;
    offlineSince = next ? null : now();
    for (const listener of listeners) listener({ online, offlineSince });
  };

  return {
    get online() {
      return online;
    },
    /** When the peer dropped, or null if they are present. */
    get offlineSince() {
      return offlineSince;
    },
    get lastSeen() {
      return lastSeen;
    },

    /**
     * Call for EVERY message that arrives from the peer, not just pings. Any
     * traffic at all is proof they are there, and an action arriving is the
     * strongest proof available.
     */
    noteMessage(message) {
      if (stopped) return;
      lastSeen = now();
      setOnline(true);
      // A ping is answered so the other side sees us even during a long think.
      if (message?.t === 'ping') {
        try {
          send({ t: 'pong' });
        } catch {
          /* the transport is down; our own close handler will deal with it */
        }
      }
    },

    /** An out-of-band report that the peer is gone (relay close, socket close). */
    markPeerGone() {
      if (stopped) return;
      setOnline(false);
    },

    /**
     * Advance the heartbeat. Sends our own ping when one is due and demotes the
     * peer to offline once they have been silent for too long.
     */
    tick() {
      if (stopped) return { online };
      const at = now();
      if (at - lastSeen >= timing.HEARTBEAT_MS) {
        try {
          send({ t: 'ping' });
        } catch {
          // Failing to send is itself evidence: our side of the pipe is down,
          // which from the match's point of view is the peer being unreachable.
          setOnline(false);
        }
      }
      if (at - lastSeen >= timing.PEER_TIMEOUT_MS) setOnline(false);
      return { online, offlineSince };
    },

    /** Notified whenever the peer flips between present and absent. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stop() {
      stopped = true;
      listeners.clear();
    },
  };
}

/* ------------------------------------------------------------------ *
 * The clocks
 * ------------------------------------------------------------------ */

/**
 * The grace clock and the turn cap, side by side but never touching.
 *
 * Owned by the HOST and by the host alone. The host already holds the only
 * authoritative state and is the only caller of `applyAction`, so it is also the
 * only side entitled to decide that a turn ran out — a guest that ran its own
 * clock could simply lie about it. The guest receives deadlines and renders
 * them; see the `clock` message in onlineMatch.js.
 *
 * Everything is stored as an absolute deadline rather than a remaining count, so
 * a tick that arrives late (a throttled background tab, a long animation frame)
 * expires the clock at the right moment instead of drifting by however long it
 * was asleep.
 */
export function createMatchClocks({ now = () => Date.now(), timing = TIMING } = {}) {
  /** Absolute time the current turn must end by, or null between turns. */
  let turnDeadline = null;
  /** Absolute time a disconnected player forfeits by, or null when everyone is here. */
  let graceDeadline = null;
  /** Which seat is currently away. Null when both are connected. */
  let disconnectedSeat = null;
  /** Cumulative full-cap timeouts, per seat. Index is the seat. */
  const timeouts = [0, 0];
  /** The turn this cap belongs to, so a stale expiry cannot fire twice. */
  let turnKey = null;

  return {
    /**
     * Begin (or restart) the turn cap. Called whenever the active player or turn
     * number changes — including after an auto-pass, so the next player gets a
     * full turn rather than the remains of someone else's.
     */
    startTurn(key) {
      turnKey = key;
      turnDeadline = now() + timing.TURN_CAP_MS;
    },

    /** Stop the turn cap entirely, e.g. once the match is over. */
    clearTurn() {
      turnKey = null;
      turnDeadline = null;
    },

    /**
     * A player dropped. Starts the grace clock, and pointedly does NOT touch the
     * turn deadline — see the module header for why that is the whole point.
     */
    startGrace(seat) {
      if (disconnectedSeat === seat) return; // already counting; do not restart it
      disconnectedSeat = seat;
      graceDeadline = now() + timing.GRACE_PERIOD_MS;
    },

    /**
     * A player came back. The grace clock is discarded rather than paused: a
     * player who drops again gets a fresh 60 seconds, because the alternative is
     * a match that dies from an accumulation of brief, blameless blips.
     *
     * The turn cap is again untouched, so repeated dropping cannot buy time.
     */
    clearGrace() {
      disconnectedSeat = null;
      graceDeadline = null;
    },

    /** Record a full-cap timeout and report whether it costs them the match. */
    noteTimeout(seat) {
      timeouts[seat] = (timeouts[seat] ?? 0) + 1;
      return timeouts[seat] >= timing.TURN_TIMEOUT_FORFEIT_COUNT;
    },

    /**
     * What has run out, if anything.
     *
     * PRECEDENCE: grace expiry is reported ahead of turn expiry when both are
     * due in the same tick. A player who has been gone a full minute has already
     * lost the match; auto-passing a turn for them first would be busywork on
     * the way to the same result, and would burn a timeout against a player who
     * is no longer in the match to care about it.
     */
    due() {
      const at = now();
      if (graceDeadline !== null && at >= graceDeadline) {
        return { kind: 'grace', seat: disconnectedSeat };
      }
      if (turnDeadline !== null && at >= turnDeadline) {
        return { kind: 'turn', key: turnKey };
      }
      return null;
    },

    /** The wire snapshot the guest renders from. Absolute deadlines, not counts. */
    snapshot() {
      return {
        turnDeadline,
        graceDeadline,
        disconnectedSeat,
        timeouts: [...timeouts],
        /** Sent so the guest can correct for a clock that disagrees with the host's. */
        serverNow: now(),
      };
    },

    /** Read back for tests and for the result screen. */
    timeoutsFor(seat) {
      return timeouts[seat] ?? 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Rendering helpers
 * ------------------------------------------------------------------ */

/**
 * Milliseconds left on a deadline, floored at zero.
 *
 * `skew` is the guest's correction: the host stamps `serverNow` into every clock
 * message, and the difference against the local clock is applied here. Without
 * it a player whose machine is a minute fast would watch a countdown that starts
 * at zero, which looks exactly like a bug.
 */
export function remainingMs(deadline, { now = () => Date.now(), skew = 0 } = {}) {
  if (deadline == null) return null;
  return Math.max(0, deadline - (now() + skew));
}

/** Whole seconds remaining, rounded up so a countdown ends on "1" and not "0". */
export function remainingSeconds(deadline, options) {
  const ms = remainingMs(deadline, options);
  return ms == null ? null : Math.ceil(ms / 1000);
}

/**
 * Should the turn countdown be visible at all?
 *
 * False for the overwhelming majority of a turn. The cap exists to stop
 * griefing, and showing a five-minute clock ticking down through every ordinary
 * turn would apply pressure to exactly the players it is not aimed at.
 */
export function turnWarningActive(turnDeadline, options = {}) {
  const ms = remainingMs(turnDeadline, options);
  const timing = options.timing ?? TIMING;
  return ms != null && ms <= timing.TURN_WARN_MS;
}

/** "1:04" / "0:09" — for the grace countdown, which can exceed a minute. */
export function formatCountdown(ms) {
  if (ms == null) return '';
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : String(seconds);
}
