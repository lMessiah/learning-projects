#!/usr/bin/env node
/**
 * End-to-end smoke check for the relay (server/relay.js).
 *
 *   node tools/relay-smoke.js                    # starts its own server
 *   RELAY_URL=ws://localhost:8788 node tools/relay-smoke.js
 *   RELAY_URL=wss://yoursite/ws   node tools/relay-smoke.js
 *
 * The second form is the one that matters after deployment: it proves nginx is
 * forwarding the WebSocket upgrade correctly, from outside the box, without a
 * browser in the way.
 */
import { WebSocket } from 'ws';
import { createRelayServer } from '../server/relay.js';

const ROOM = 'SMOKE1';
let failures = 0;

const check = (label, ok) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) failures++;
};

/**
 * A test client that buffers.
 *
 * The listeners are attached the instant the socket is created, before anything
 * is awaited — the relay greets a connection the moment it opens, so a client
 * that waits for `open` and only then listens has already missed the first
 * message. Everything received is queued, and `next()` either shifts one off
 * the queue or waits for the next arrival.
 */
function client(url) {
  const socket = new WebSocket(url);
  const queue = [];
  let waiting = null;
  let closeCode = null;
  let closeWaiter = null;

  const deliver = (message) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(message);
    } else {
      queue.push(message);
    }
  };

  socket.on('message', (data) => deliver(JSON.parse(String(data))));
  socket.on('close', (code) => {
    closeCode = code;
    closeWaiter?.(code);
  });
  socket.on('error', () => {
    /* a refused connection surfaces as a close; nothing to do here */
  });

  const withTimeout = (promise, what, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref?.()),
    ]);

  return {
    socket,
    opened: () =>
      withTimeout(new Promise((resolve) => socket.once('open', resolve)), 'the connection to open', 3000),
    next: (ms = 3000) =>
      withTimeout(
        queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => (waiting = resolve)),
        'a message',
        ms
      ),
    closed: (ms = 3000) =>
      withTimeout(
        closeCode !== null ? Promise.resolve(closeCode) : new Promise((resolve) => (closeWaiter = resolve)),
        'the socket to close',
        ms
      ),
    send: (payload) => socket.send(JSON.stringify(payload)),
    close: () => socket.close(),
  };
}

const open = async (url) => {
  const peer = client(url);
  await peer.opened();
  return peer;
};

async function main() {
  let server = null;
  let base = process.env.RELAY_URL;

  if (!base) {
    server = createRelayServer();
    await new Promise((resolve) => server.listen(0, resolve));
    base = `ws://localhost:${server.address().port}/ws`;
    console.log(`Started a relay on ${base}\n`);
  } else {
    console.log(`Testing the relay at ${base}\n`);
  }

  const url = (room, role) => `${base}?room=${room}&role=${role}`;

  // 1. A guest for a room nobody opened is turned away, not left hanging.
  const stray = await open(url('NOROOM', 'guest'));
  const strayMessage = await stray.next();
  check('unknown room is refused', strayMessage.relay === 'error' && (await stray.closed()) === 4004);

  // 2. The host opens the room and is told it is empty.
  const host = await open(url(ROOM, 'host'));
  const hostJoined = await host.next();
  check('host is seated', hostJoined.relay === 'joined' && hostJoined.seat === 'host');
  check('host is told the room is empty', hostJoined.peer === false);

  // 3. The guest arrives; both sides learn about it.
  const guest = await open(url(ROOM, 'guest'));
  const guestJoined = await guest.next();
  check('guest is seated', guestJoined.relay === 'joined' && guestJoined.seat === 'guest');
  check('guest sees the host already there', guestJoined.peer === true);
  check('host is told the guest arrived', (await host.next()).relay === 'peer');

  // 4. A second guest is refused — a room is two seats.
  const gatecrasher = await open(url(ROOM, 'guest'));
  await gatecrasher.next();
  check('a third player is refused', (await gatecrasher.closed()) === 4009);

  // 5. The actual job: a message crosses verbatim, in both directions.
  host.send({ t: 'state', view: { turn: 1, nested: [1, 2, 3] } });
  const arrived = await guest.next();
  check('host -> guest forwarded intact', arrived.t === 'state' && arrived.view.nested[2] === 3);

  guest.send({ t: 'action', id: 7, action: { type: 'END_TURN' } });
  const back = await host.next();
  check('guest -> host forwarded intact', back.t === 'action' && back.id === 7);

  // 6. When one side leaves, the other is told and closed rather than stranded.
  guest.close();
  const notice = await host.next();
  check('surviving player is told the peer left', notice.relay === 'peer' && notice.state === 'left');
  check('surviving socket is closed', (await host.closed()) === 4010);

  server?.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nSmoke check could not run: ${error.message}`);
  process.exit(1);
});
