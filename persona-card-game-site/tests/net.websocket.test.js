/**
 * The WebSocket transport, against the real relay.
 *
 * Nothing is mocked: a relay listens on an ephemeral port, two transports
 * connect to it, and the real host/guest sessions play through them. That is
 * the claim worth testing — that `onlineMatch.js` accepts this transport with
 * no changes at all — and it cannot be tested with a fake socket.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRelayServer } from '../server/relay.js';
import { connectAsHost, connectAsGuest, closeReason, defaultRelayUrl } from '../src/net/websocket.js';
import { createHostSession, createGuestSession, HOST_SEAT, GUEST_SEAT } from '../src/net/onlineMatch.js';

let server;
let url;

beforeAll(async () => {
  server = createRelayServer();
  await new Promise((resolve) => server.listen(0, resolve));
  url = `ws://localhost:${server.address().port}/ws`;
});

afterAll(() => server?.close());

/**
 * Both sides of one room, connected and ready to be handed to a session.
 *
 * The host is awaited as far as `joined` before the guest is dialled: the relay
 * only creates a room when the host's socket is seated, so a guest that starts
 * connecting at the same moment can genuinely arrive first and be refused. In
 * the real flow the link cannot be shared until the room exists, which is what
 * `joined` is for.
 */
async function pair(code) {
  const host = connectAsHost({ url, code });
  await host.joined;
  const guest = connectAsGuest({ url, code });
  return { host: await host.connected, guest: await guest.connected };
}

/** Resolve on the next state the guest session is handed. */
const nextView = (session, ms = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no state arrived')), ms);
    const off = session.subscribe((view) => {
      clearTimeout(timer);
      off();
      resolve(view);
    });
  });

const nextError = (session, ms = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no error arrived')), ms);
    session.onError((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });

describe('connecting', () => {
  it('waits for the guest before reporting the host connected', async () => {
    const host = connectAsHost({ url, code: 'WAIT01' });
    let resolved = false;
    host.connected.then(() => (resolved = true));

    // A host alone in a room is not connected to anything yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);

    const guest = connectAsGuest({ url, code: 'WAIT01' });
    await Promise.all([host.connected, guest.connected]);
    expect(resolved).toBe(true);
  });

  it('confirms the room before the peer arrives, so a link is never shared blind', async () => {
    const host = connectAsHost({ url, code: 'ROOM01' });
    const seated = await host.joined;
    expect(seated.seat).toBe('host');
    expect(seated.room).toBe('ROOM01');
    expect(host.seat).toBe('host');

    // ...and `connected` is still pending: a room is not an opponent. The
    // rejection handler is not optional — cancelling below rejects `connected`,
    // and a bare `.then` would leave that derived promise unhandled.
    let opponentHere = false;
    host.connected.then(
      () => (opponentHere = true),
      () => {}
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(opponentHere).toBe(false);
    host.cancel();
  });

  it('fails `joined` too when the relay refuses, rather than hanging', async () => {
    const guest = connectAsGuest({ url, code: 'GHOST1' });
    await expect(guest.joined).rejects.toThrow(/unknown or has expired/i);
  });

  it('refuses a guest whose code names no room', async () => {
    const guest = connectAsGuest({ url, code: 'NOSUCH' });
    await expect(guest.connected).rejects.toThrow(/unknown or has expired/i);
  });

  it('refuses a second guest — a match is two seats', async () => {
    const { host, guest } = await pair('FULL01');
    const gatecrasher = connectAsGuest({ url, code: 'FULL01' });
    await expect(gatecrasher.connected).rejects.toThrow(/already has a guest/i);
    host.close();
    guest.close();
  });

  it('lower-cases and normalises the code, so a mangled link still works', async () => {
    const host = connectAsHost({ url, code: 'MiXeD1' });
    const guest = connectAsGuest({ url, code: 'mixed1' });
    const [a, b] = await Promise.all([host.connected, guest.connected]);
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
    a.close();
    b.close();
  });
});

describe('a real match over the wire', () => {
  it('hands the guest a redacted view and accepts their moves', async () => {
    const { host: hostTransport, guest: guestTransport } = await pair('MATCH1');

    const host = createHostSession(hostTransport, {
      hostName: 'Alex',
      guestName: 'Sam',
      seed: 42,
    });
    const guest = createGuestSession(guestTransport, { name: 'Sam' });

    const view = await nextView(guest);
    expect(view).toBeTruthy();
    expect(view.players[HOST_SEAT].name).toBe('Alex');

    // What arrived is a redacted view, not the authoritative state. A match
    // opens in starter select, so the secret at this moment is the deck order
    // and the host's own starter offer — the hands are not dealt yet.
    expect(view.redacted).toBe(true);
    expect(view.seed).toBe(null);
    expect(view.players[HOST_SEAT].deck.every((entry) => entry === null)).toBe(true);
    expect(view.starterOptions[GUEST_SEAT].length).toBeGreaterThan(0); // their own offer
    expect(view.starterOptions[HOST_SEAT]).toEqual([]); // ...but not the host's

    // A legal guest move crosses the wire and moves the host's real state.
    const [choice] = guest.legalActions(GUEST_SEAT);
    expect(choice?.type).toBe('CHOOSE_STARTER');
    const applied = nextView(guest);
    guest.dispatch(choice);
    await applied;
    expect(host.getState().players[GUEST_SEAT].field.length).toBeGreaterThan(0);

    // And once both starters are down, the hands are dealt — the moment the
    // hand redaction actually has something to hide.
    const dealt = nextView(guest);
    host.dispatch({ ...host.legalActions(HOST_SEAT)[0] });
    const afterDeal = await dealt;
    expect(afterDeal.players[GUEST_SEAT].hand.some((entry) => entry.cardId)).toBe(true);
    expect(afterDeal.players[HOST_SEAT].hand.every((entry) => !entry.cardId)).toBe(true);

    host.destroy();
    guest.destroy();
  });

  it('tells the survivor when the other side vanishes', async () => {
    const { host: hostTransport, guest: guestTransport } = await pair('MATCH2');
    const host = createHostSession(hostTransport, { seed: 7 });
    const guest = createGuestSession(guestTransport);
    await nextView(guest);

    const notice = nextError(guest);
    host.destroy();
    expect(await notice).toMatch(/disconnected/i);

    guest.destroy();
  });

  it('refuses a guest action for the hostseat, whatever the guest sends', async () => {
    const { host: hostTransport, guest: guestTransport } = await pair('MATCH3');
    const host = createHostSession(hostTransport, { seed: 9 });
    const guest = createGuestSession(guestTransport);
    await nextView(guest);

    // Straight down the transport, bypassing the guest session's own checks —
    // this is what a tampered client would send.
    const rejected = nextError(guest);
    guestTransport.send({ t: 'action', id: 99, action: { type: 'END_TURN', player: HOST_SEAT } });
    expect(await rejected).toMatch(/only act for your own side/i);

    host.destroy();
    guest.destroy();
  });
});

describe('helpers', () => {
  it('explains the close codes a player might actually hit', () => {
    expect(closeReason(4004)).toMatch(/unknown or has expired/i);
    expect(closeReason(4009)).toMatch(/full/i);
    expect(closeReason(4010)).toMatch(/disconnected/i);
    expect(closeReason(1006)).toMatch(/proxied/i);
  });

  it('derives the relay URL from the page, upgrading the scheme with it', () => {
    expect(defaultRelayUrl({ protocol: 'https:', host: 'game.example' })).toBe('wss://game.example/ws');
    expect(defaultRelayUrl({ protocol: 'http:', host: 'localhost:4173' })).toBe('ws://localhost:4173/ws');
    expect(defaultRelayUrl({})).toBe('');
  });
});
