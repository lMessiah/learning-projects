/**
 * Transport interface + an in-memory implementation.
 *
 * A transport is only:
 *   send(message)        - deliver a JSON-serialisable object to the peer
 *   onMessage(handler)   - receive them
 *   onClose(handler)
 *   close()
 *
 * Keeping it this narrow means the match protocol has no idea whether it is
 * talking over a WebRTC data channel, a WebSocket to a future authoritative
 * server, or nothing at all (the loopback pair below, used by the tests).
 */

function createEndpoint(name) {
  const messageHandlers = new Set();
  const closeHandlers = new Set();
  let peer = null;
  let closed = false;

  return {
    name,
    get closed() {
      return closed;
    },
    _attach(other) {
      peer = other;
    },
    _deliver(message) {
      if (closed) return;
      for (const handler of messageHandlers) handler(message);
    },
    _shutdown(reason) {
      if (closed) return;
      closed = true;
      for (const handler of closeHandlers) handler(reason);
    },
    send(message) {
      if (closed) throw new Error(`${name}: transport is closed`);
      // Round-trip through JSON so the loopback pair cannot accidentally share
      // object references — a real connection never would.
      peer?._deliver(JSON.parse(JSON.stringify(message)));
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close(reason = 'closed') {
      const other = peer;
      this._shutdown(reason);
      other?._shutdown(reason);
    },
  };
}

/** Two directly-wired endpoints. Used by the tests and for local debugging. */
export function createLoopbackPair() {
  const a = createEndpoint('host');
  const b = createEndpoint('guest');
  a._attach(b);
  b._attach(a);
  return [a, b];
}
