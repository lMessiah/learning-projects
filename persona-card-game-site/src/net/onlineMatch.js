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
 *
 * Both sides expose the same controller shape the board already consumes, so
 * the UI does not know or care that it is online.
 */
import { applyAction, getLegalActions, createMatch } from '../engine/index.js';
import { redactStateFor } from '../engine/redact.js';

export const HOST_SEAT = 0;
export const GUEST_SEAT = 1;

function makeEmitter() {
  const listeners = new Set();
  return {
    add: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (value) => {
      for (const listener of listeners) listener(value);
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
  const { hostName = 'Host', guestName = 'Guest', hostDeckId = 'p3', guestDeckId = 'p5', seed = 1 } = options;

  // The authoritative state. It never leaves this closure.
  let authoritative = createMatch({
    seed,
    players: [
      { name: hostName, deckId: hostDeckId, controller: 'human' },
      { name: guestName, deckId: guestDeckId, controller: 'remote' },
    ],
  });

  const changed = makeEmitter();
  const errors = makeEmitter();
  let destroyed = false;

  const viewFor = (seat) => redactStateFor(authoritative, seat);

  function broadcast() {
    changed.emit(viewFor(HOST_SEAT));
    if (!transport.closed) {
      try {
        transport.send({ t: 'state', view: viewFor(GUEST_SEAT) });
      } catch {
        /* peer went away; the close handler deals with it */
      }
    }
  }

  /** Apply an action on behalf of a seat, refusing anything not theirs. */
  function commit(action, seat) {
    if (destroyed) return { ok: false, message: 'match is over' };
    if (action?.player !== seat) return { ok: false, message: 'you may only act for your own side' };
    try {
      authoritative = applyAction(authoritative, action);
      broadcast();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message.replace(/^Illegal action:\s*/, '') };
    }
  }

  const offMessage = transport.onMessage((message) => {
    if (destroyed) return;
    if (message?.t === 'hello') {
      transport.send({ t: 'welcome', seat: GUEST_SEAT, hostName });
      broadcast();
      return;
    }
    if (message?.t === 'action') {
      const result = commit(message.action, GUEST_SEAT);
      if (!result.ok) {
        transport.send({ t: 'reject', id: message.id, message: result.message });
        // Re-sync the guest: their optimistic view may have drifted.
        transport.send({ t: 'state', view: viewFor(GUEST_SEAT) });
      }
    }
  });

  const offClose = transport.onClose((reason) => {
    errors.emit(`Your opponent disconnected (${reason}).`);
  });

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
    start: () => broadcast(),
    destroy() {
      destroyed = true;
      offMessage();
      offClose();
      changed.clear();
      errors.clear();
      if (!transport.closed) transport.close('host left');
    },
  };
}

/* ------------------------------------------------------------------ *
 * Guest
 * ------------------------------------------------------------------ */

export function createGuestSession(transport, { name = 'Guest' } = {}) {
  let view = null;
  let nextId = 1;
  let destroyed = false;

  const changed = makeEmitter();
  const errors = makeEmitter();

  const offMessage = transport.onMessage((message) => {
    if (destroyed) return;
    if (message?.t === 'state') {
      view = message.view;
      changed.emit(view);
    } else if (message?.t === 'reject') {
      errors.emit(message.message);
    }
  });

  const offClose = transport.onClose((reason) => {
    errors.emit(`The host disconnected (${reason}).`);
  });

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
      if (action.player !== GUEST_SEAT) throw new Error('Illegal action: you may only act for your own side');

      const legal = getLegalActions(view, GUEST_SEAT);
      const matches = legal.some((candidate) => candidate.type === action.type);
      if (!matches) throw new Error('Illegal action: not something you can do right now');

      try {
        transport.send({ t: 'action', id: nextId++, action });
      } catch {
        throw new Error('Connection lost — that move did not reach the host.');
      }
      return view;
    },

    subscribe: changed.add,
    onError: errors.add,
    start: () => {
      if (view) changed.emit(view);
    },
    destroy() {
      destroyed = true;
      offMessage();
      offClose();
      changed.clear();
      errors.clear();
      if (!transport.closed) transport.close('guest left');
    },
  };
}
