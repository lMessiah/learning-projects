/**
 * WebSocket transport — the same four methods as every other transport in this
 * project (see transport.js), carried over a socket to the relay.
 *
 * The relay (server/relay.js) is a dumb pipe: it seats two players in a room and
 * forwards their messages verbatim. Everything above this file — the match
 * protocol, the board, the rules engine — is unchanged and unaware. Swapping
 * WebRTC for this is swapping which object is handed to `createHostSession`.
 *
 * Two responsibilities beyond `send`/`onMessage`:
 *
 *  1. **Pipe is not payload.** The relay's own messages are namespaced under
 *     `relay` and are consumed here; the game never sees them.
 *  2. **Connected means BOTH players are here.** A host connects to an empty
 *     room and waits. `connected` resolves only once the relay reports a peer,
 *     because `createHostSession` starts dealing the moment it is constructed.
 */

/** Close codes the relay uses, mirrored from server/relay.js. */
const RELAY_CLOSE = {
  4000: 'The relay rejected the connection.',
  4004: 'That match code is unknown or has expired.',
  4009: 'That match is already full.',
  4010: 'Your opponent disconnected.',
};

/**
 * Turn a close code into something worth showing a player.
 *
 * 1006 is the one worth knowing about: it means the socket died without a
 * proper close handshake, which in practice is almost always a proxy that has
 * not been told to forward the WebSocket upgrade (see the nginx config) or a
 * relay that is not running.
 */
export function closeReason(code, fallback = 'connection closed') {
  if (RELAY_CLOSE[code]) return RELAY_CLOSE[code];
  if (code === 1000 || code === 1005) return 'connection closed';
  if (code === 1006) return 'the connection dropped — is the relay running and proxied correctly?';
  if (code === 1001) return 'the other side navigated away';
  return fallback;
}

export function websocketSupported() {
  return typeof globalThis.WebSocket === 'function';
}

/**
 * Where the relay lives when nothing is configured: the same host the page came
 * from, at `/ws`, with the scheme upgraded alongside the page's own. That is
 * what the nginx config in the README sets up, so a deployed site needs no
 * setting at all.
 *
 * In `vite dev` the page is served from :5173 and the relay is not, so a
 * development override is expected — hence the setting.
 */
export function defaultRelayUrl(location = globalThis.location) {
  if (!location?.host) return '';
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

/**
 * The relay's plain-HTTP health route, derived from its WebSocket URL.
 * `wss://host/ws` -> `https://host/ws/health`, which is what nginx forwards.
 */
export function relayHealthUrl(wsUrl) {
  const url = String(wsUrl || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  return `${url.replace(/^ws/, 'http')}/health`;
}

/**
 * Is a relay actually there?
 *
 * Asked before the UI offers a link, so "no relay configured" and "relay is
 * down" both fall back to the copy-paste handshake rather than presenting a
 * link that cannot work. A failed probe is never an error the player sees.
 */
export async function relayAvailable(wsUrl, { fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  const url = relayHealthUrl(wsUrl);
  if (!url || typeof fetchImpl !== 'function') return false;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;

  const probe = (async () => {
    try {
      const response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
      return Boolean(response?.ok);
    } catch (error) {
      // A signal and a fetch from different realms (jsdom's AbortController over
      // Node's fetch, say) are refused by the implementation. The abort is a
      // courtesy, not the timeout — so drop it and let the race below do the
      // timing out, rather than reporting a live relay as dead.
      if (controller && /signal/i.test(error?.message ?? '')) {
        try {
          return Boolean((await fetchImpl(url))?.ok);
        } catch {
          return false;
        }
      }
      return false;
    }
  })();

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(false);
    }, timeoutMs);
  });

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** `wss://host/ws` + room + role, with the code normalised the way the relay expects. */
function relayUrl(base, code, role) {
  const url = String(base || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('No relay server is configured.');
  return `${url}?room=${encodeURIComponent(String(code).toUpperCase())}&role=${role}`;
}

/* ------------------------------------------------------------------ *
 * The transport
 * ------------------------------------------------------------------ */

/**
 * Wrap a live socket in the transport interface.
 *
 * DESIGN NOTE — the queue. `createHostSession` attaches its message handler
 * when it is constructed, which is AFTER `connected` resolves. The guest's
 * `hello` can easily arrive in between, and a dropped `hello` is a match that
 * never starts. So messages received before anyone is listening are queued and
 * flushed to the first handler that registers. This is the same race that bit
 * the relay smoke test, and it is the reason both files buffer.
 */
function wrapSocket(socket, { onPeerLeft } = {}) {
  const messageHandlers = new Set();
  const closeHandlers = new Set();
  const pending = [];
  let closed = false;

  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler(reason);
  };

  socket.addEventListener('message', (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return; // not our protocol; ignore rather than crash the match
    }

    // Pipe, not payload: the relay's own chatter stops here.
    if (parsed?.relay) {
      if (parsed.relay === 'peer' && parsed.state === 'left') onPeerLeft?.();
      return;
    }

    if (!messageHandlers.size) {
      pending.push(parsed);
      return;
    }
    for (const handler of messageHandlers) handler(parsed);
  });

  socket.addEventListener('close', (event) => shutdown(closeReason(event?.code)));
  socket.addEventListener('error', () => shutdown('connection error'));

  return {
    name: 'websocket',
    get closed() {
      return closed || socket.readyState !== 1;
    },
    send(message) {
      if (this.closed) throw new Error('Connection is closed');
      socket.send(JSON.stringify(message));
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      // Whatever arrived before anyone was listening belongs to this handler.
      if (pending.length) {
        const queued = pending.splice(0, pending.length);
        for (const message of queued) handler(message);
      }
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close(reason = 'closed') {
      shutdown(reason);
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Open a socket to the relay and wait until the room holds both players.
 *
 * @returns {{ code: string, connected: Promise<object>, cancel: () => void }}
 *   `connected` resolves with a transport, or rejects with a message fit to put
 *   in front of a player.
 */
function connect(role, { url, code, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('This browser does not support WebSockets.');
  const target = relayUrl(url, code, role);
  const socket = new WebSocketImpl(target);

  let settled = false;
  let peerLeft = false;
  let seat = null;

  /**
   * Resolves as soon as the relay confirms the room, before any peer arrives.
   *
   * This is the difference between "I asked for a room" and "I have one". The
   * host must not show a match link until the room actually exists, or a code
   * the relay refused would be shared as though it worked.
   */
  let markJoined;
  let markJoinFailed;
  const joined = new Promise((resolve, reject) => {
    markJoined = resolve;
    markJoinFailed = reject;
  });

  const connected = new Promise((resolve, reject) => {
    // Built before the handshake completes, so no message can be missed
    // between the peer arriving and the game attaching its handlers.
    const transport = wrapSocket(socket, { onPeerLeft: () => (peerLeft = true) });

    const fail = (message) => {
      markJoinFailed(new Error(message));
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* nothing to close */
      }
      reject(new Error(message));
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(transport);
    };

    socket.addEventListener('message', (event) => {
      if (settled) return;
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed?.relay === 'error') fail(parsed.message || 'The relay refused the connection.');
      if (parsed?.relay === 'joined') {
        seat = parsed.seat;
        markJoined({ seat: parsed.seat, room: parsed.room });
      }
      // `joined` already carries whether the other player is in the room, so a
      // guest joining a waiting host connects without a second round trip.
      if (parsed?.relay === 'joined' && parsed.peer) succeed();
      if (parsed?.relay === 'peer' && parsed.state === 'joined') succeed();
    });

    socket.addEventListener('close', (event) => {
      // Losing the socket before both players are seated is a failure to
      // connect; losing it afterwards is the transport's business, not ours.
      fail(closeReason(event?.code, 'The connection closed before the match began.'));
    });

    socket.addEventListener('error', () => {
      fail('Could not reach the relay server.');
    });
  });

  // Both promises are optional to the caller: the host awaits `joined` then
  // `connected`, the guest only `connected`. A rejection nobody is listening to
  // yet would otherwise surface as an unhandled rejection, so each is given a
  // no-op handler. Callers still see their own rejections as normal.
  joined.catch(() => {});
  connected.catch(() => {});

  return {
    code: String(code).toUpperCase(),
    joined,
    connected,
    /** Which seat the relay gave us, once it has said so. */
    get seat() {
      return seat;
    },
    /** True once the peer has been reported gone — used by the waiting screen. */
    get peerLeft() {
      return peerLeft;
    },
    cancel() {
      try {
        socket.close();
      } catch {
        /* nothing to close */
      }
    },
  };
}

/**
 * Host side: creates the room and waits for someone to open the link.
 * The code is generated by the caller (see shortcode.js) — the relay does not
 * mint codes, it only seats whoever quotes one.
 */
export function connectAsHost(options) {
  return connect('host', options);
}

/** Guest side: joins an existing room, failing fast if the code is wrong. */
export function connectAsGuest(options) {
  return connect('guest', options);
}
