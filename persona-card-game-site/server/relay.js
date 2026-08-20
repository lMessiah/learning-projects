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
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { TIMING } from '../src/net/presence.js';

/** A room with one lonely peer is swept after this long. */
export const ROOM_TTL_MS = 10 * 60 * 1000;
/**
 * How long a seat is held for a player who dropped.
 *
 * Shared with the client rather than duplicated, because it has to outlast the
 * grace period: a player reconnecting on the 59th second must still find their
 * seat waiting. See src/net/presence.js, which owns every timing value.
 */
export const SEAT_RESERVATION_MS = TIMING.SEAT_RESERVATION_MS;
/**
 * Dead sockets are detected by ping/pong on this interval.
 *
 * Tightened from 30s so that a socket which died without a close frame is
 * reaped before the player behind it finishes reconnecting — otherwise they
 * arrive to find their own zombie still sitting in the seat.
 */
const HEARTBEAT_MS = 5 * 1000;
/** A redacted state view is a few KB; anything this large is not ours. */
const MAX_PAYLOAD = 256 * 1024;
const MAX_ROOMS = 500;

/** Close codes, in the 4000-4999 range applications own. */
export const CLOSE = {
  BAD_REQUEST: 4000,
  UNKNOWN_ROOM: 4004,
  ROOM_FULL: 4009,
  PEER_LEFT: 4010,
  /** This seat was resumed from somewhere else; this socket is the stale one. */
  SEAT_RESUMED: 4011,
  /**
   * Sent BY a client that is leaving on purpose — the match resolved, or the
   * player quit to the menu. It is the difference between "I am gone" and "I
   * dropped": a goodbye frees the seat at once, anything else holds it for the
   * reconnect window. Using a close code rather than a message keeps the relay's
   * promise that it never parses what it forwards.
   */
  GOODBYE: 4012,
};

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */

/**
 * The room book. Exported separately from the socket handling so it can be
 * driven by a test without opening a port.
 */
export function createRooms({ now = () => Date.now() } = {}) {
  /**
   * code -> {
   *   host, guest,        sockets, or null when that seat is empty
   *   tokens,             per-seat secret, minted on first claim
   *   vacated,            per-seat time the socket dropped, or null
   *   createdAt,
   * }
   */
  const rooms = new Map();

  /**
   * A seat that has been claimed before is held for its original occupant, so a
   * player who drops mid-match can come back to it. Once the reservation lapses
   * the seat is genuinely gone and so, shortly after, is the room.
   */
  const reservationLive = (room, seat) =>
    room.vacated[seat] !== null && now() - room.vacated[seat] < SEAT_RESERVATION_MS;

  const sweep = () => {
    const cutoff = now() - ROOM_TTL_MS;
    for (const [code, room] of rooms) {
      // A room is dead once BOTH seats are empty AND neither is still being
      // held for someone. Deleting the moment the last socket closed — which is
      // what this used to do — is precisely what made reconnecting impossible.
      const held = ['host', 'guest'].some((seat) => room[seat] || reservationLive(room, seat));
      if (!held) {
        rooms.delete(code);
        continue;
      }
      // The TTL is for a room nobody ever joined: a host who opened a link and
      // wandered off. It deliberately does NOT apply once both players have met,
      // or a match that runs past ten minutes would be swept out from under a
      // player who was briefly disconnected.
      if (!room.everFilled && room.createdAt <= cutoff) rooms.delete(code);
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
     * Seat a socket. Returns `{ ok:true, room, seat, token, rejoined }`, or
     * `{ ok:false, code, message }` with a close code the caller hands over.
     *
     * RESUMING A SEAT. A seat that has been occupied before can only be taken
     * by presenting the token minted when it was first claimed. Without that,
     * anyone who saw the match link could wait for a player's connection to
     * wobble and steal their side of a match in progress. The token also lets a
     * genuine reconnect evict its own zombie: a socket that died without a close
     * frame may still be sitting in the seat, and the side that can prove it is
     * the real occupant should win that argument, not the corpse.
     */
    join(code, role, socket, token = '') {
      sweep();
      let room = rooms.get(code);

      if (!room) {
        if (role !== 'host') {
          return { ok: false, code: CLOSE.UNKNOWN_ROOM, message: 'That match code is unknown or has expired.' };
        }
        if (rooms.size >= MAX_ROOMS) {
          return { ok: false, code: CLOSE.BAD_REQUEST, message: 'Too many matches in flight — try again shortly.' };
        }
        room = {
          code,
          host: null,
          guest: null,
          tokens: { host: null, guest: null },
          vacated: { host: null, guest: null },
          createdAt: now(),
          /** Set once both seats have been occupied together; gates the TTL. */
          everFilled: false,
        };
        rooms.set(code, room);
      }

      // The seat you asked for, or nothing. Two hosts in one room would both
      // think they owned the authoritative state, which is the one failure this
      // server exists to make impossible.
      const seat = role === 'host' ? 'host' : 'guest';
      const claimed = room.tokens[seat] !== null;

      if (claimed) {
        if (!token || token !== room.tokens[seat]) {
          return { ok: false, code: CLOSE.ROOM_FULL, message: `This match already has a ${seat}.` };
        }
        if (!reservationLive(room, seat) && !room[seat]) {
          return {
            ok: false,
            code: CLOSE.UNKNOWN_ROOM,
            message: 'That match has already been given up as lost.',
          };
        }
        // Same player, new socket. Whatever is in the seat is stale by
        // definition — they cannot be connected twice.
        const stale = room[seat];
        room[seat] = socket;
        room.vacated[seat] = null;
        if (room.host && room.guest) room.everFilled = true;
        return { ok: true, room, seat, token, rejoined: true, stale };
      }

      const minted = randomUUID();
      room.tokens[seat] = minted;
      room[seat] = socket;
      room.vacated[seat] = null;
      if (room.host && room.guest) room.everFilled = true;
      return { ok: true, room, seat, token: minted, rejoined: false, stale: null };
    },
    /**
     * A socket left. The seat is held rather than freed, so the player behind it
     * can come back; the room survives until both reservations lapse.
     */
    leave(room, seat, socket = null) {
      if (!room) return;
      // A stale socket being cleaned up after its seat was already resumed must
      // not evict the live occupant that replaced it.
      if (socket && room[seat] !== socket) return;
      room[seat] = null;
      room.vacated[seat] = now();
      sweep();
    },
    /** Give up a seat for good — used when a match ends properly. */
    release(room, seat) {
      if (!room) return;
      room[seat] = null;
      room.tokens[seat] = null;
      room.vacated[seat] = null;
      if (!room.host && !room.guest && !room.tokens.host && !room.tokens.guest) rooms.delete(room.code);
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
  // Present only when resuming a seat this client already held.
  const token = String(searchParams.get('token') ?? '').trim();
  if (!room || room.length > 32) return { error: 'A match code is required.' };
  if (role !== 'host' && role !== 'guest') return { error: 'role must be host or guest.' };
  if (token.length > 64) return { error: 'Bad resume token.' };
  return { room, role, token };
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

    const seated = rooms.join(target.room, target.role, socket, target.token);
    if (!seated.ok) {
      control(socket, { relay: 'error', message: seated.message });
      socket.close(seated.code, 'rejected');
      return;
    }

    const { room, seat, rejoined, stale } = seated;
    const other = () => (seat === 'host' ? room.guest : room.host);

    // A socket that died without a close frame can still be sitting in the seat
    // its owner is trying to resume. The one that just proved it holds the token
    // is the real occupant; the other is hung up on.
    if (stale && stale !== socket) {
      try {
        stale.close(CLOSE.SEAT_RESUMED, 'seat resumed elsewhere');
      } catch {
        /* already gone */
      }
    }

    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    // Tell the newcomer where it landed, and whether anyone is home yet. The
    // token comes back so the client can present it if it has to reconnect —
    // the relay holds no other notion of who anybody is.
    control(socket, {
      relay: 'joined',
      room: room.code,
      seat,
      peer: Boolean(other()),
      token: seated.token,
      resumed: rejoined,
    });
    // ...and tell the peer, if there is one, that the room just filled up. This
    // is the signal the host waits on before dealing the opening hands, and —
    // when `resumed` is set — the signal that ends a reconnect countdown.
    control(other(), { relay: 'peer', state: 'joined', resumed: rejoined });

    // The forwarding rule, in one line: whatever came in goes out the other
    // side untouched. `isBinary` is preserved so a future binary protocol needs
    // no change here.
    socket.on('message', (data, isBinary) => {
      const peer = other();
      if (peer?.readyState === 1) peer.send(data, { binary: isBinary });
    });

    socket.on('close', (code) => {
      // Read the peer BEFORE leaving, and pass our own socket so that a stale
      // socket closing after its seat was resumed cannot evict the live one.
      const peer = other();
      if (code === CLOSE.GOODBYE) {
        // A deliberate exit. Nothing is being held for someone who has said
        // they are not coming back.
        if (room[seat] === socket) rooms.release(room, seat);
        control(peer, { relay: 'peer', state: 'left', deliberate: true });
        return;
      }
      rooms.leave(room, seat, socket);
      // The survivor is told, and deliberately left connected.
      //
      // This used to close the survivor's socket too, on the reasoning that a
      // match cannot continue without both sides. That is true only if the
      // absence is permanent, and most are not — a phone changing network, a
      // laptop lid, a tunnel. Hanging up made every blip terminal and left the
      // remaining player with nothing to reconnect TO. The seat is now held (see
      // rooms.leave) and this message starts the grace countdown on the client;
      // if it expires, the client ends the match itself, which is the side that
      // actually knows the rules.
      control(peer, { relay: 'peer', state: 'left' });
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
