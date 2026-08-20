/**
 * The reconnecting transport, against the real relay.
 *
 * The claim under test is the one everything else depends on: a socket can die
 * and be replaced underneath a live transport without the layer above noticing —
 * same object, same handlers, same seat.
 *
 * Disconnects are staged by reaching into the relay's own room book and killing
 * the server side of a socket, which is what a lost network actually looks like:
 * an abrupt close with no goodbye frame, from a client that did not choose it.
 * Nothing here mocks the transport.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRelayServer, createRooms } from '../server/relay.js';
import { connectAsHost, createResilientTransport } from '../src/net/websocket.js';

let server;
let url;
let rooms;

beforeAll(async () => {
  rooms = createRooms();
  server = createRelayServer({ rooms });
  await new Promise((resolve) => server.listen(0, resolve));
  url = `ws://localhost:${server.address().port}/ws`;
});

afterAll(() => server?.close());

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, polling — reconnection is inherently asynchronous. */
async function until(predicate, { timeout = 5000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('condition never became true');
}

/** Yank the network out from under one side of a room. */
function killSocket(code, seat) {
  const room = rooms.get(code);
  if (!room?.[seat]) throw new Error(`no ${seat} socket in ${code}`);
  room[seat].terminate();
}

/** A plain host and a resilient guest, both seated in one room. */
async function pairWithResilientGuest(code) {
  const host = connectAsHost({ url, code });
  await host.joined;
  const guest = createResilientTransport('guest', { url, code, backoff: [20, 30, 50] });
  const [hostTransport] = await Promise.all([host.connected, guest.connected]);
  return { hostTransport, guest };
}

describe('surviving a dropped socket', () => {
  it('re-dials into the same seat and keeps the handlers attached', async () => {
    const { hostTransport, guest } = await pairWithResilientGuest('RC0001');

    const received = [];
    // Registered ONCE, before the drop. If reconnecting rebuilt the transport
    // this handler would be lost and the assertion below would time out.
    guest.transport.onMessage((m) => received.push(m));

    hostTransport.send({ t: 'state', view: { tag: 'before' } });
    await until(() => received.length === 1);

    const statuses = [];
    guest.transport.onStatus((s) => statuses.push(s));

    killSocket('RC0001', 'guest');

    // Wait for the drop to register before waiting for the recovery — polling
    // straight for 'online' would pass on the very first tick, before the socket
    // death has even reached us, and prove nothing.
    await until(() => guest.transport.status === 'reconnecting');
    await until(() => guest.transport.status === 'online');
    expect(statuses).toContain('reconnecting');
    expect(statuses[statuses.length - 1]).toBe('online');
    expect(guest.transport.closed).toBe(false);

    // The same handler, on the same transport object, over a brand new socket.
    hostTransport.send({ t: 'state', view: { tag: 'after' } });
    await until(() => received.length === 2);
    expect(received[1]).toEqual({ t: 'state', view: { tag: 'after' } });

    guest.transport.close();
    hostTransport.close();
  });

  it('leaves the surviving side connected throughout', async () => {
    const { hostTransport, guest } = await pairWithResilientGuest('RC0002');

    killSocket('RC0002', 'guest');
    await settle(100);
    // The host is still here. Under the old relay it would have been hung up on
    // the instant the guest's socket closed, and there would be no match left.
    expect(hostTransport.closed).toBe(false);

    await until(() => guest.transport.status === 'online');
    expect(hostTransport.closed).toBe(false);

    guest.transport.close();
    hostTransport.close();
  });

  it('reports the peer leaving and returning to the other side', async () => {
    const host = createResilientTransport('host', { url, code: 'RC0003', backoff: [20] });
    await host.joined;
    const guest = createResilientTransport('guest', { url, code: 'RC0003', backoff: [20, 30] });
    await Promise.all([host.connected, guest.connected]);

    const seen = [];
    host.transport.onPeerPresence((state) => seen.push(state));

    killSocket('RC0003', 'guest');

    // 'left' starts the grace countdown; 'joined' is what cancels it.
    await until(() => seen.includes('left'));
    await until(() => seen.includes('joined'));

    host.transport.close();
    guest.transport.close();
  });

  it('refuses to send while the link is down rather than queueing a stale move', async () => {
    const { hostTransport, guest } = await pairWithResilientGuest('RC0004');

    killSocket('RC0004', 'guest');
    await until(() => guest.transport.status === 'reconnecting');

    // A move made during the gap would land against a position that has moved
    // on, and the host would reject it. Failing now is the honest answer.
    expect(() => guest.transport.send({ t: 'action' })).toThrow(/down|closed/i);

    await until(() => guest.transport.status === 'online');
    expect(() => guest.transport.send({ t: 'action', id: 1 })).not.toThrow();

    guest.transport.close();
    hostTransport.close();
  });

  it('stops trying, and stays closed, after a deliberate exit', async () => {
    const { hostTransport, guest } = await pairWithResilientGuest('RC0005');

    const statuses = [];
    guest.transport.onStatus((s) => statuses.push(s));
    guest.transport.close('quit'); // deliberate by default

    await settle(250);
    expect(guest.transport.closed).toBe(true);
    expect(statuses).toEqual(['closed']);
    expect(statuses).not.toContain('reconnecting');

    hostTransport.close();
  });

  it('frees the seat on a deliberate exit, so it is not held for 90 seconds', async () => {
    const { hostTransport, guest } = await pairWithResilientGuest('RC0006');
    guest.transport.close('quit');
    await settle(150);

    // A goodbye releases the seat outright, which is what lets a fresh guest in.
    const room = rooms.get('RC0006');
    expect(room?.guest).toBe(null);
    expect(room?.tokens.guest).toBe(null);

    hostTransport.close();
  });

  it('gives up on a room the relay no longer knows about', async () => {
    const guest = createResilientTransport('guest', { url, code: 'NOROOM', backoff: [10] });
    await expect(guest.connected).rejects.toThrow(/unknown or has expired/i);
    guest.cancel();
  });
});
