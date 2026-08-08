/**
 * Short match codes: the code alphabet, the rendezvous client, and the bundled
 * server's routing — all driven in-process, no sockets.
 */
import { describe, it, expect } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  generateCode,
  normaliseCode,
  isValidCode,
  createRendezvousClient,
} from '../src/net/shortcode.js';
import { createStore, handle, TTL_MS } from '../server/rendezvous.js';

describe('code format', () => {
  it('is short enough to say out loud', () => {
    expect(CODE_LENGTH).toBeLessThan(15);
    expect(generateCode()).toHaveLength(CODE_LENGTH);
  });

  it('excludes every character pair that is easy to confuse', () => {
    for (const confusable of ['0', 'O', '1', 'I', 'L', '5', 'S']) {
      expect(CODE_ALPHABET).not.toContain(confusable);
    }
    // Still a big enough space for short-lived codes.
    expect(CODE_ALPHABET.length ** CODE_LENGTH).toBeGreaterThan(100_000_000);
  });

  it('draws from the alphabet only', () => {
    for (let i = 0; i < 200; i++) {
      expect([...generateCode()].every((char) => CODE_ALPHABET.includes(char))).toBe(true);
    }
  });

  it('forgives how a human types it', () => {
    expect(normaliseCode('abc234')).toBe('ABC234');
    expect(normaliseCode('ABC-234')).toBe('ABC234');
    expect(normaliseCode('  abc 234  ')).toBe('ABC234');
    expect(isValidCode('abc 234')).toBe(true);
    expect(isValidCode('ABC23')).toBe(false); // too short
    expect(isValidCode('')).toBe(false);
  });

  it('drops characters outside the alphabet rather than guessing', () => {
    expect(normaliseCode('AB!C23@4')).toBe('ABC234');
  });
});

describe('rendezvous server', () => {
  /** Drive the real routing table without opening a socket. */
  function server({ now = () => Date.now() } = {}) {
    const store = createStore({ now });
    return {
      store,
      call: (method, path, body) => handle({ method, path, body }, store),
    };
  }

  it('answers a health check', async () => {
    const { call } = server();
    const result = await call('GET', '/health');
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it('stores an offer under a short code and hands it back', async () => {
    const { call } = server();
    const created = await call('POST', '/session', { offer: 'OFFER-BLOB' });
    expect(created.status).toBe(200);
    expect(isValidCode(created.body.code)).toBe(true);

    const fetched = await call('GET', `/session/${created.body.code}`);
    expect(fetched.body.offer).toBe('OFFER-BLOB');
  });

  it('is case-insensitive about the code', async () => {
    const { call } = server();
    const { body } = await call('POST', '/session', { offer: 'BLOB' });
    const lower = await call('GET', `/session/${body.code.toLowerCase()}`);
    expect(lower.status).toBe(200);
  });

  it('carries the answer back to the host, then forgets the session', async () => {
    const { call } = server();
    const { body } = await call('POST', '/session', { offer: 'OFFER' });
    const code = body.code;

    // Host polls before the guest has replied.
    expect((await call('GET', `/session/${code}/answer`)).body.answer).toBe(null);

    await call('POST', `/session/${code}/answer`, { answer: 'ANSWER' });
    const collected = await call('GET', `/session/${code}/answer`);
    expect(collected.body.answer).toBe('ANSWER');

    // The handshake is done, so the code is spent.
    expect((await call('GET', `/session/${code}`)).status).toBe(404);
  });

  it('rejects unknown and expired codes', async () => {
    let clock = 1000;
    const { call } = server({ now: () => clock });
    const { body } = await call('POST', '/session', { offer: 'OFFER' });

    expect((await call('GET', '/session/ZZZZZZ')).status).toBe(404);

    clock += TTL_MS + 1;
    expect((await call('GET', `/session/${body.code}`)).status).toBe(404);
  });

  it('validates its inputs', async () => {
    const { call } = server();
    expect((await call('POST', '/session', {})).status).toBe(400);
    expect((await call('POST', '/session', { offer: '' })).status).toBe(400);

    const { body } = await call('POST', '/session', { offer: 'OFFER' });
    expect((await call('POST', `/session/${body.code}/answer`, {})).status).toBe(400);
    expect((await call('GET', '/nope')).status).toBe(404);
  });

  it('never stores anything but the two opaque blobs', async () => {
    const { call, store } = server();
    const { body } = await call('POST', '/session', { offer: 'OFFER' });
    const session = store.get(body.code);
    expect(Object.keys(session).sort()).toEqual(['answer', 'expiresAt', 'offer']);
  });
});

describe('rendezvous client', () => {
  /** A tiny in-process transport from the client straight into the routing table. */
  function wiredClient() {
    const store = createStore();
    const fetchImpl = async (url, options = {}) => {
      const { pathname } = new URL(url);
      const body = options.body ? JSON.parse(options.body) : {};
      const result = await handle({ method: options.method || 'GET', path: pathname, body }, store);
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body,
      };
    };
    return createRendezvousClient('http://rendezvous.test', { fetchImpl });
  }

  it('reports availability', async () => {
    expect(await wiredClient().available()).toBe(true);
  });

  it('reports a server that is not there rather than throwing', async () => {
    const dead = createRendezvousClient('http://nope.test', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await dead.available()).toBe(false);
  });

  it('runs the whole handshake through short codes', async () => {
    const client = wiredClient();

    const code = await client.publishOffer('OFFER-BLOB');
    expect(isValidCode(code)).toBe(true);
    expect(code.length).toBeLessThan(15);

    // Guest side.
    expect(await client.fetchOffer(code)).toBe('OFFER-BLOB');
    await client.publishAnswer(code, 'ANSWER-BLOB');

    // Host side.
    expect(await client.waitForAnswer(code, { timeout: 5000 })).toBe('ANSWER-BLOB');
  });

  it('explains an expired or mistyped code', async () => {
    await expect(wiredClient().fetchOffer('ZZZZZZ')).rejects.toThrow(/expired or does not exist/);
  });

  it('gives up waiting rather than hanging forever', async () => {
    const client = wiredClient();
    const code = await client.publishOffer('OFFER');
    await expect(client.waitForAnswer(code, { timeout: 1 })).rejects.toThrow(/Nobody joined/);
  });
});
