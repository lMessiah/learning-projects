#!/usr/bin/env node
/**
 * WebSocket relay — the pipe that carries an online match.
 *
 *   node server/relay.js            # port 8788
 *   PORT=9100 node server/relay.js
 *
 * DESIGN NOTE: this server is deliberately stupid. It knows about ROOMS and
 * SOCKETS and nothing else — it never imports the rules engine, never parses a
 * game message, and holds no state that matters if it restarts. Every client
 * message is forwarded to the other side of the room verbatim, as the bytes
 * arrived. That is what keeps the match host-authoritative: the host's browser
 * is still the only thing in the world that calls `applyAction`, exactly as it
 * is over WebRTC today (see src/net/onlineMatch.js).
 *
 * A room is exactly two sockets. The first to arrive is the host, the second
 * the guest, and a third is refused rather than queued — there are two seats in
 * a match and no meaning to a spectator here.
 *
 * Connect with:  ws://host:8788/ws?room=ABC234&role=host
 *                ws://host:8788/ws?room=ABC234&role=guest
 *
 * Only `role=host` creates a room. A guest naming a room that does not exist is
 * told so immediately, which is what turns a mistyped link into an error message
 * instead of an empty screen waiting for a peer who will never come.
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/** A room with one lonely peer is swept after this long. */
export const ROOM_TTL_MS = 10 * 60 * 1000;
/** Dead sockets are detected by ping/pong on this interval. */
const HEARTBEAT_MS = 30 * 1000;
/** A redacted state view is a few KB; anything this large is not ours. */
const MAX_PAYLOAD = 256 * 1024;
const MAX_ROOMS = 500;

/** Close codes, in the 4000-4999 range applications own. */
export const CLOSE = {
  BAD_REQUEST: 4000,
  UNKNOWN_ROOM: 4004,
  ROOM_FULL: 4009,
  PEER_LEFT: 4010,
};

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */

/**
 * The room book. Exported separately from the socket handling so it can be
 * driven by a test without opening a port.
 */
export function createRooms({ now = () => Date.now() } = {}) {
  /** code -> { host, guest, createdAt } — `host`/`guest` are sockets or null. */
  const rooms = new Map();

  const sweep = () => {
    const cutoff = now() - ROOM_TTL_MS;
    for (const [code, room] of rooms) {
      const empty = !room.host && !room.guest;
      if (empty || (room.createdAt <= cutoff && !(room.host && room.guest))) rooms.delete(code);
    }
  };

  return {
    get size() {
      sweep();
      return rooms.size;
    },
    get(code) {
      return rooms.get(code) ?? null;
    },
    /**
     * Seat a socket. Returns `{ ok:true, room, seat }`, or `{ ok:false, code,
     * message }` with a close code the caller hands to the client.
     */
    join(code, role, socket) {
      sweep();
      let room = rooms.get(code);

      if (!room) {
        if (role !== 'host') {
          return { ok: false, code: CLOSE.UNKNOWN_ROOM, message: 'That match code is unknown or has expired.' };
        }
        if (rooms.size >= MAX_ROOMS) {
          return { ok: false, code: CLOSE.BAD_REQUEST, message: 'Too many matches in flight — try again shortly.' };
        }
        room = { code, host: null, guest: null, createdAt: now() };
        rooms.set(code, room);
      }

      // The seat you asked for, or nothing. Two hosts in one room would both
      // think they owned the authoritative state, which is the one failure this
      // server exists to make impossible.
      const seat = role === 'host' ? 'host' : 'guest';
      if (room[seat]) {
        return { ok: false, code: CLOSE.ROOM_FULL, message: `This match already has a ${seat}.` };
      }

      room[seat] = socket;
      return { ok: true, room, seat };
    },
    /** Remove a socket from its room, dropping the room once both are gone. */
    leave(room, seat) {
      if (!room) return;
      room[seat] = null;
      if (!room.host && !room.guest) rooms.delete(room.code);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Sockets
 * ------------------------------------------------------------------ */

/**
 * The relay's own messages travel down the same socket as the game's, so they
 * are namespaced under `relay` rather than sharing the game protocol's `t`
 * field. The client transport can then tell pipe from payload with certainty
 * and forever, however the game protocol grows.
 */
const control = (socket, payload) => {
  if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
};

/**
 * Parse `?room=&role=` off the connection URL.
 *
 * Room codes are normalised to upper case here so a link that survived a
 * lower-casing mail client still finds its room.
 */
function readTarget(url) {
  const { searchParams } = new URL(url, 'http://relay.invalid');
  const room = String(searchParams.get('room') ?? '').trim().toUpperCase();
  const role = String(searchParams.get('role') ?? '').trim().toLowerCase();
  if (!room || room.length > 32) return { error: 'A match code is required.' };
  if (role !== 'host' && role !== 'guest') return { error: 'role must be host or guest.' };
  return { room, role };
}

export function createRelayServer({ rooms = createRooms() } = {}) {
  const http = createServer((request, response) => {
    // One plain HTTP route, so you can check the thing is alive from a browser
    // or a monitoring script without speaking WebSocket.
    //
    // Answered under `/ws/health` as well as `/health` so that a single nginx
    // `location /ws` block can forward both the health probe and the socket
    // upgrade — see the deployment notes in the README.
    const path = request.url.split('?')[0];
    if (request.method === 'GET' && (path === '/health' || path === '/ws/health')) {
      // The probe is a cross-origin fetch whenever the relay is not served from
      // the same host as the site, which is a perfectly ordinary way to deploy
      // it. WebSocket connections are not subject to CORS, but this GET is.
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_PAYLOAD });

  wss.on('connection', (socket, request) => {
    const target = readTarget(request.url);
    if (target.error) {
      control(socket, { relay: 'error', message: target.error });
      socket.close(CLOSE.BAD_REQUEST, 'bad request');
      return;
    }

    const seated = rooms.join(target.room, target.role, socket);
    if (!seated.ok) {
      control(socket, { relay: 'error', message: seated.message });
      socket.close(seated.code, 'rejected');
      return;
    }

    const { room, seat } = seated;
    const other = () => (seat === 'host' ? room.guest : room.host);

    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    // Tell the newcomer where it landed, and whether anyone is home yet.
    control(socket, { relay: 'joined', room: room.code, seat, peer: Boolean(other()) });
    // ...and tell the peer, if there is one, that the room just filled up. This
    // is the signal the host waits on before dealing the opening hands.
    control(other(), { relay: 'peer', state: 'joined' });

    // The forwarding rule, in one line: whatever came in goes out the other
    // side untouched. `isBinary` is preserved so a future binary protocol needs
    // no change here.
    socket.on('message', (data, isBinary) => {
      const peer = other();
      if (peer?.readyState === 1) peer.send(data, { binary: isBinary });
    });

    socket.on('close', () => {
      rooms.leave(room, seat);
      const peer = seat === 'host' ? room.guest : room.host;
      control(peer, { relay: 'peer', state: 'left' });
      // A match cannot continue without either side, so the survivor is closed
      // rather than left holding a socket that will never speak again. The UI
      // reads this as "your opponent disconnected".
      peer?.close(CLOSE.PEER_LEFT, 'peer left');
    });

    socket.on('error', () => socket.terminate());
  });

  // A browser that loses its network never sends a close frame; without this
  // the room would stay occupied until the TTL swept it.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  return http;
}

// Run directly (not when imported by a test).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const port = Number(process.env.PORT) || 8788;
  // Loopback by default: in the deployment this is written for, nginx is the
  // only thing that should be able to reach the relay, and binding every
  // interface would quietly publish it on whatever else the machine listens on.
  // Set HOST=0.0.0.0 to expose it directly.
  const host = process.env.HOST || '127.0.0.1';
  createRelayServer().listen(port, host, () => {
    console.log(`Relay listening on http://${host}:${port}  (WebSocket path /ws)`);
    console.log('It forwards messages between two players and stores no game data.');
  });
}
