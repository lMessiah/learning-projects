/**
 * The online match protocol: host-authoritative, peer-to-peer.
 *
 * The HOST owns the one real state and is the only side that ever calls
 * `applyAction`. The GUEST holds nothing but a redacted view and sends action
 * requests. This is exactly the shape a future authoritative server takes —
 * swap the transport and move `createHostSession` behind it, unchanged.
 *
 * Wire protocol (all JSON):
 *   guest -> host   { t:'hello', name }
 *                   { t:'action', id, action }
 *   host  -> guest  { t:'welcome', seat, hostName }
 *                   { t:'state', view }
 *                   { t:'reject', id, message }
 *   both ways       { t:'ping' } / { t:'pong' }
 *   host  -> guest  { t:'clock', ... }        deadlines to render; see presence.js
 *
 * Both sides expose the same controller shape the board already consumes, so
 * the UI does not know or care that it is online.
 *
 * TIME IS THE HOST'S. Every deadline, every expiry and every forfeit is decided
 * here, on the host, for the same reason every rule is: it holds the only real
 * state, and a client that ran its own clock could simply lie about it. The
 * guest is sent absolute deadlines and renders a countdown from them — it never
 * decides that one has passed. The single exception is the guest watching the
 * HOST disappear, which by definition nobody authoritative is left to adjudicate;
 * see `createGuestSession` for how that resolves.
 */
import { applyAction, getLegalActions, createMatch } from '../engine/index.js';
import { redactStateFor } from '../engine/redact.js';
import { cloneState, pushLog } from '../engine/state.js';
import { endGame } from '../engine/effects.js';
import { TIMING, END_REASON, createPresence, createMatchClocks } from './presence.js';

export const HOST_SEAT = 0;
export const GUEST_SEAT = 1;

const otherSeat = (seat) => (seat === HOST_SEAT ? GUEST_SEAT : HOST_SEAT);

/**
 * The move made on behalf of a player who let the turn cap run out.
 *
 * Deliberately the most passive legal thing available rather than anything
 * clever: the point is to unstick the match, not to play someone's turn for
 * them. `getLegalActions` already hands back an END_TURN carrying a default
 * discard selection when the hand is over the limit, so the overflow case needs
 * no special handling here.
 *
 * During starter select there is no turn to end — a player who stalls there has
 * simply not picked, so the first offered Persona is taken for them.
 */
function autoPassActions(state, seat) {
  if (state.phase === 'starterSelect') {
    const [choice] = getLegalActions(state, seat);
    return choice ? [choice] : [];
  }
  const legal = getLegalActions(state, seat);
  const endTurn = legal.find((action) => action.type === 'END_TURN');
  return endTurn ? [endTurn] : [];
}

/**
 * Who the turn cap is currently counting against.
 *
 * In starter select both players may owe a choice at once, so it is whoever
 * still has one to make; in play it is simply whoever is on turn.
 */
function seatsOnClock(state) {
  if (state.winner !== null) return [];
  if (state.phase === 'starterSelect') {
    return [HOST_SEAT, GUEST_SEAT].filter((seat) => getLegalActions(state, seat).length > 0);
  }
  return [state.activePlayer];
}

/** Identifies the current turn, so a stale expiry cannot fire against a new one. */
function turnKeyOf(state) {
  return `${state.phase}:${state.turn}:${state.activePlayer}`;
}

function makeEmitter() {
  const listeners = new Set();
  return {
    add: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Extra arguments are passed through so a state update can carry a note
    // about ITSELF — currently only `{ resync: true }`, which tells the board
    // this is a reconnect handover and not a move that just happened.
    emit: (value, meta) => {
      for (const listener of listeners) listener(value, meta);
    },
    clear: () => listeners.clear(),
  };
}

/* ------------------------------------------------------------------ *
 * Host
 * ------------------------------------------------------------------ */

/**
 * @param transport  a connected transport to the guest
 * @param options    { hostName, guestName, hostDeckId, guestDeckId, seed }
 */
export function createHostSession(transport, options) {
  const {
    hostName = 'Host',
    guestName = 'Guest',
    hostDeckId = 'p3',
    guestDeckId = 'p5',
    hostArchetype = null,
    guestArchetype = null,
    seed = 1,
    now = () => Date.now(),
    timing = TIMING,
    /** Snapshot callback, so a host reload can resume. See hostSave.js. */
    onPersist = null,
    /**
     * A match being resumed after the host's page reloaded, rather than dealt
     * fresh. The state is trusted as-is: it came from this same closure.
     */
    resumeState = null,
    /** Off in tests, which drive `tick()` by hand against a fake clock. */
    autoTick = true,
  } = options;

  // The authoritative state. It never leaves this closure.
  let authoritative =
    resumeState ??
    createMatch({
      seed,
      players: [
        { name: hostName, deckId: hostDeckId, archetype: hostArchetype, controller: 'human' },
        { name: guestName, deckId: guestDeckId, archetype: guestArchetype, controller: 'remote' },
      ],
    });

  const changed = makeEmitter();
  const errors = makeEmitter();
  const presenceChanged = makeEmitter();
  let destroyed = false;

  const clocks = createMatchClocks({ now, timing });
  const presence = createPresence({
    send: (message) => transport.send(message),
    now,
    timing,
  });

  /** The last clock snapshot put on the wire, so unchanged ones are not resent. */
  let lastClockSent = '';
  let ticker = null;

  const viewFor = (seat) => redactStateFor(authoritative, seat);

  const persist = () => {
    if (!onPersist) return;
    try {
      onPersist(authoritative);
    } catch {
      /* storage is a convenience; a match must never die for want of it */
    }
  };

  const sendToGuest = (message) => {
    if (transport.closed) return false;
    try {
      transport.send(message);
      return true;
    } catch {
      // The peer is unreachable. Presence will notice on its own schedule;
      // there is nothing useful to do about it here.
      return false;
    }
  };

  /**
   * Push the deadlines to the guest, but only when they have actually moved.
   *
   * Because deadlines are absolute, the guest can animate a countdown from one
   * message indefinitely — there is no need to stream it a tick every quarter
   * second, and doing so would put a needless heartbeat of traffic through the
   * relay for the whole match.
   */
  function broadcastClock({ force = false } = {}) {
    const snapshot = clocks.snapshot();
    const fingerprint = JSON.stringify([
      snapshot.turnDeadline,
      snapshot.graceDeadline,
      snapshot.disconnectedSeat,
      snapshot.timeouts,
    ]);
    if (!force && fingerprint === lastClockSent) return;
    lastClockSent = fingerprint;
    sendToGuest({ t: 'clock', ...snapshot });
    presenceChanged.emit(localPresence());
  }

  /** What the host's own UI needs to draw its overlays. */
  function localPresence() {
    const snapshot = clocks.snapshot();
    return {
      opponentOnline: presence.online,
      graceDeadline: snapshot.graceDeadline,
      turnDeadline: snapshot.turnDeadline,
      disconnectedSeat: snapshot.disconnectedSeat,
      timeouts: snapshot.timeouts,
      // Down-but-retrying counts as offline: the overlay should say so while the
      // transport is re-dialling, not only once it has given up.
      selfOnline: transport.online !== false && !transport.closed,
    };
  }

  function broadcast() {
    changed.emit(viewFor(HOST_SEAT));
    sendToGuest({ t: 'state', view: viewFor(GUEST_SEAT) });
  }

  /** The turn the cap is currently counting, so it is not restarted mid-turn. */
  let clockedTurn = null;

  /** Restart the turn cap if the turn has moved on since it was last set. */
  function syncTurnClock() {
    if (authoritative.winner !== null) {
      clocks.clearTurn();
      clockedTurn = null;
      return;
    }
    const key = turnKeyOf(authoritative);
    if (key !== clockedTurn) {
      clockedTurn = key;
      clocks.startTurn(key);
    }
  }

  /**
   * Restart the cap whether or not the turn changed.
   *
   * Used after an auto-pass, because the pass is not guaranteed to have moved
   * the turn on — a position can refuse even END_TURN. Leaving the deadline in
   * the past would make `due()` fire again on the very next tick, and the
   * player would burn straight through the forfeit threshold in under a second
   * for a fault that was not theirs.
   */
  function restartTurnClock() {
    if (authoritative.winner !== null) {
      clocks.clearTurn();
      clockedTurn = null;
      return;
    }
    clockedTurn = turnKeyOf(authoritative);
    clocks.startTurn(clockedTurn);
  }

  /** End the match from outside the rules — a disconnect or a forfeit. */
  function finishMatch(winner, reason, logLine) {
    if (authoritative.winner !== null) return;
    const draft = cloneState(authoritative);
    pushLog(draft, logLine, 'system');
    endGame(draft, winner, reason);
    authoritative = draft;
    clocks.clearTurn();
    clocks.clearGrace();
    persist();
    broadcast();
    broadcastClock({ force: true });
  }

  /** Apply an action on behalf of a seat, refusing anything not theirs. */
  function commit(action, seat) {
    if (destroyed) return { ok: false, message: 'match is over' };
    if (action?.player !== seat) return { ok: false, message: 'you may only act for your own side' };
    try {
      authoritative = applyAction(authoritative, action);
      syncTurnClock();
      persist();
      broadcast();
      broadcastClock();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message.replace(/^Illegal action:\s*/, '') };
    }
  }

  /**
   * The turn cap ran out. Auto-pass, and forfeit the match if this is not the
   * first time this player has done it.
   *
   * Note the ORDER: the timeout is recorded and the forfeit decided BEFORE the
   * auto-pass is applied. Passing first would hand the turn to the opponent and
   * make the forfeit land on a match that has already moved on.
   */
  function handleTurnExpiry() {
    const seats = seatsOnClock(authoritative);
    if (!seats.length) {
      clocks.clearTurn();
      return;
    }

    for (const seat of seats) {
      const name = authoritative.players[seat].name;
      const forfeits = clocks.noteTimeout(seat);
      if (forfeits) {
        finishMatch(
          otherSeat(seat),
          END_REASON.TIMEOUT_FORFEIT,
          `${name} ran out of time ${timing.TURN_TIMEOUT_FORFEIT_COUNT} times and forfeits the match.`,
        );
        return;
      }
    }

    for (const seat of seats) {
      const name = authoritative.players[seat].name;
      for (const action of autoPassActions(authoritative, seat)) {
        try {
          authoritative = applyAction(authoritative, action);
        } catch {
          /* the position moved under us; the next tick will pick it up */
        }
      }
      pushLogSafely(`${name} ran out of time — their turn was passed automatically.`);
    }

    restartTurnClock();
    persist();
    broadcast();
    broadcastClock({ force: true });
  }

  /** A log line that does not disturb the state's identity for the differ. */
  function pushLogSafely(text) {
    const draft = cloneState(authoritative);
    pushLog(draft, text, 'system');
    authoritative = draft;
  }

  /**
   * The heartbeat of the whole disconnect system. Runs on a short interval and
   * does four things in a fixed order: refresh presence, start or stop the grace
   * clock to match it, act on whatever has expired, and publish the deadlines.
   */
  function tick() {
    if (destroyed || authoritative.winner !== null) return;

    presence.tick();

    // WHOSE fault the silence is matters, and the transport is the one thing
    // that knows. If OUR socket is the one that died, we are the disconnected
    // player and the match is ours to lose — awarding ourselves the win because
    // we can no longer hear anyone would be both wrong and, when both sides do
    // it at once, contradictory. When both players drop, each correctly
    // identifies itself as the absent one and neither claims a victory.
    const selfDown = transport.online === false || transport.closed;
    if (selfDown) clocks.startGrace(HOST_SEAT);
    else if (!presence.online) clocks.startGrace(GUEST_SEAT);
    else clocks.clearGrace();

    const due = clocks.due();
    if (due?.kind === 'grace') {
      // The 60 seconds are up. The player who stayed takes the match.
      finishMatch(
        otherSeat(due.seat),
        END_REASON.DISCONNECT,
        `${authoritative.players[due.seat].name} did not reconnect in time.`,
      );
      return;
    }
    if (due?.kind === 'turn') {
      handleTurnExpiry();
      return;
    }

    broadcastClock();
  }

  const offMessage = transport.onMessage((message) => {
    if (destroyed) return;
    // Every message is proof the guest is alive, which is what ends a grace
    // countdown — not just the ones the protocol cares about.
    presence.noteMessage(message);

    if (message?.t === 'ping' || message?.t === 'pong') return;

    if (message?.t === 'hello' || message?.t === 'resume') {
      transport.send({ t: 'welcome', seat: GUEST_SEAT, hostName });
      // A resuming guest gets the full picture and the live deadlines, which is
      // the whole of "resume exactly where it was" from their side.
      broadcast();
      broadcastClock({ force: true });
      return;
    }
    if (message?.t === 'action') {
      const result = commit(message.action, GUEST_SEAT);
      if (!result.ok) {
        sendToGuest({ t: 'reject', id: message.id, message: result.message });
        // Re-sync the guest: their optimistic view may have drifted.
        sendToGuest({ t: 'state', view: viewFor(GUEST_SEAT) });
      }
    }
  });

  /**
   * The peer's socket closed. This is a HINT that starts the grace period, not
   * the end of the match — the transport may well re-dial and the guest walk
   * straight back into their seat.
   */
  const offClose = transport.onPeerPresence
    ? transport.onPeerPresence((state) => {
        if (destroyed) return;
        if (state === 'left') {
          presence.markPeerGone();
          tick();
        }
      })
    : transport.onClose(() => {
        if (destroyed) return;
        presence.markPeerGone();
        tick();
      });

  syncTurnClock();

  return {
    role: 'host',
    seat: HOST_SEAT,

    /* --- the controller shape the board consumes --- */
    getState: () => viewFor(HOST_SEAT),
    isBotTurn: () => false,
    legalActions: (playerId) => getLegalActions(authoritative, playerId),
    dispatch(action) {
      const result = commit(action, HOST_SEAT);
      if (!result.ok) throw new Error(`Illegal action: ${result.message}`);
      return viewFor(HOST_SEAT);
    },
    subscribe: changed.add,
    onError: errors.add,

    /* --- disconnect handling --- */
    /** Deadlines and connection state, for the overlay and the countdowns. */
    presenceState: localPresence,
    onPresenceChange: presenceChanged.add,
    /** Exposed so tests can drive time by hand. */
    tick,

    start() {
      broadcast();
      broadcastClock({ force: true });
      persist();
      if (autoTick && ticker === null) {
        ticker = setInterval(tick, timing.TICK_MS);
        ticker.unref?.();
      }
    },
    destroy() {
      destroyed = true;
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      presence.stop();
      offMessage();
      offClose();
      changed.clear();
      errors.clear();
      presenceChanged.clear();
      if (!transport.closed) transport.close('host left', { deliberate: true });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Guest
 * ------------------------------------------------------------------ */

export function createGuestSession(transport, options = {}) {
  const {
    name = 'Guest',
    now = () => Date.now(),
    timing = TIMING,
    autoTick = true,
  } = options;

  let view = null;
  let nextId = 1;
  let destroyed = false;
  let ticker = null;
  /** Set while a `resume` is outstanding, so its answer can be marked as one. */
  let awaitingResync = false;

  const changed = makeEmitter();
  const errors = makeEmitter();
  const presenceChanged = makeEmitter();

  /** The deadlines the host last told us about. Absolute, in the host's clock. */
  let clock = { turnDeadline: null, graceDeadline: null, disconnectedSeat: null, timeouts: [0, 0] };
  /**
   * How far this machine's clock is from the host's. Applied to every countdown,
   * so a player whose system clock is wrong does not see a timer that starts at
   * zero or never moves.
   */
  let skew = 0;

  const presence = createPresence({
    send: (message) => transport.send(message),
    now,
    timing,
  });

  /**
   * The host vanished and stayed vanished.
   *
   * This is the one decision a guest makes for itself, because there is nobody
   * left to make it: the host holds the authoritative state, so if the host is
   * gone there is no authority to appeal to. The guest resolves the match
   * locally in its own favour, which is the outcome the rules prescribe — the
   * connected player wins — and the host, whose state is persisted, reaches the
   * same conclusion whenever it next runs.
   *
   * The result is written into the view rather than reported separately, so the
   * ordinary end-of-match screen renders it with no special case.
   */
  let localGraceDeadline = null;

  /** Which seat the local grace clock is counting against. */
  let localGraceSeat = HOST_SEAT;

  function resolveLocally(reason, losingSeat) {
    if (!view || view.winner !== null) return;
    const draft = cloneState(view);
    pushLog(draft, `${draft.players[losingSeat].name} did not reconnect in time.`, 'system');
    endGame(draft, losingSeat === HOST_SEAT ? GUEST_SEAT : HOST_SEAT, reason);
    view = draft;
    localGraceDeadline = null;
    changed.emit(view);
    presenceChanged.emit(presenceState());
  }

  function presenceState() {
    return {
      opponentOnline: presence.online,
      // Whichever countdown is live: the host's, or the one being run locally
      // because the host is the side that disappeared.
      graceDeadline: localGraceDeadline ?? clock.graceDeadline,
      turnDeadline: clock.turnDeadline,
      disconnectedSeat: localGraceDeadline !== null ? localGraceSeat : clock.disconnectedSeat,
      timeouts: clock.timeouts,
      selfOnline: transport.online !== false && !transport.closed,
      skew,
    };
  }

  function tick() {
    if (destroyed) return;
    presence.tick();

    // Same reasoning as the host's tick: a guest whose own socket died is the
    // absent player, and must not hand itself the match for being unable to
    // hear anyone.
    const selfDown = transport.online === false || transport.closed;

    if (selfDown || !presence.online) {
      if (localGraceDeadline === null) {
        localGraceDeadline = now() + timing.GRACE_PERIOD_MS;
        localGraceSeat = selfDown ? GUEST_SEAT : HOST_SEAT;
      }
      if (now() >= localGraceDeadline) {
        resolveLocally(END_REASON.DISCONNECT, localGraceSeat);
        return;
      }
    } else if (localGraceDeadline !== null) {
      // Back before the window closed. Discarded rather than paused, so a second
      // drop gets a fresh sixty seconds.
      localGraceDeadline = null;
      presenceChanged.emit(presenceState());
    }

    presenceChanged.emit(presenceState());
  }

  const offMessage = transport.onMessage((message) => {
    if (destroyed) return;
    presence.noteMessage(message);

    if (message?.t === 'state') {
      view = message.view;
      // The first state after asking to resume is the whole match handed back,
      // not a move. Flagged so the board snaps to it instead of animating every
      // change that happened while we were away.
      changed.emit(view, awaitingResync ? { resync: true } : undefined);
      awaitingResync = false;
    } else if (message?.t === 'clock') {
      const { serverNow, ...rest } = message;
      clock = rest;
      // Measured on arrival: the difference between the host's stamp and ours.
      if (typeof serverNow === 'number') skew = serverNow - now();
      presenceChanged.emit(presenceState());
    } else if (message?.t === 'reject') {
      errors.emit(message.message);
    }
  });

  /**
   * The host's socket dropped. A hint that starts the local grace countdown —
   * not the end of the match, because the transport will try to re-dial and the
   * host may simply be reloading.
   */
  const offClose = transport.onPeerPresence
    ? transport.onPeerPresence((state) => {
        if (destroyed) return;
        if (state === 'left') {
          presence.markPeerGone();
          tick();
        }
      })
    : transport.onClose(() => {
        if (destroyed) return;
        presence.markPeerGone();
        tick();
      });

  /**
   * Announce ourselves, and do it again after every reconnect. `resume` asks the
   * host for a full resync; the host answers with the state and the live
   * deadlines, which is the entire reconnection handshake from this side.
   */
  const offStatus = transport.onStatus
    ? transport.onStatus((status) => {
        if (destroyed || status !== 'online') return;
        try {
          awaitingResync = true;
          transport.send({ t: 'resume', name });
        } catch {
          /* the link went again already; the next status change will retry */
          awaitingResync = false;
        }
      })
    : null;

  transport.send({ t: 'hello', name });

  return {
    role: 'guest',
    seat: GUEST_SEAT,

    getState: () => view,
    isBotTurn: () => false,
    legalActions: (playerId) => (view ? getLegalActions(view, playerId) : []),

    /**
     * Check locally first so a mistake is refused instantly, then send. The
     * host re-validates authoritatively — the local check is a courtesy, never
     * the rule. Nothing is applied optimistically, so the board can never show
     * a state the host did not produce.
     */
    dispatch(action) {
      if (destroyed || !view) return view;
      if (transport.closed) throw new Error('Connection lost — you are no longer connected to the host.');
      // Down but not out: the transport is re-dialling. A move sent now would
      // arrive against a position that has moved on, so it is refused rather
      // than queued — and the board is behind the reconnect overlay anyway.
      if (transport.online === false) {
        throw new Error('Reconnecting — wait for the connection to come back.');
      }
      if (view.winner !== null) throw new Error('Illegal action: the match is already over');
      if (action.player !== GUEST_SEAT) throw new Error('Illegal action: you may only act for your own side');

      // Resigning is not a move in the game and is not gated on whose turn it
      // is, so it skips the local courtesy check and goes straight to the host,
      // who is the one that actually decides.
      if (action.type !== 'RESIGN') {
        const legal = getLegalActions(view, GUEST_SEAT);
        const matches = legal.some((candidate) => candidate.type === action.type);
        if (!matches) throw new Error('Illegal action: not something you can do right now');
      }

      try {
        transport.send({ t: 'action', id: nextId++, action });
      } catch {
        throw new Error('Connection lost — that move did not reach the host.');
      }
      return view;
    },

    subscribe: changed.add,
    onError: errors.add,

    /* --- disconnect handling --- */
    presenceState,
    onPresenceChange: presenceChanged.add,
    /** Exposed so tests can drive time by hand. */
    tick,

    start() {
      if (view) changed.emit(view);
      if (autoTick && ticker === null) {
        ticker = setInterval(tick, timing.TICK_MS);
        ticker.unref?.();
      }
    },
    destroy() {
      destroyed = true;
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      presence.stop();
      offMessage();
      offClose();
      offStatus?.();
      changed.clear();
      errors.clear();
      presenceChanged.clear();
      if (!transport.closed) transport.close('guest left', { deliberate: true });
    },
  };
}
