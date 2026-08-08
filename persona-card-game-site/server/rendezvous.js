#!/usr/bin/env node
/**
 * Optional rendezvous server — the only server in this project, and it is not
 * required to play.
 *
 * Its entire job is to hold two opaque strings (a WebRTC offer and answer)
 * under a six-character code for ten minutes, so players can type `K7M2QX`
 * instead of pasting a 2 KB blob. It never sees game state, never runs the
 * rules engine, and the peers still connect directly to each other.
 *
 *   node server/rendezvous.js            # port 8787
 *   PORT=9000 node server/rendezvous.js
 *
 * Zero dependencies, in-memory only: restart it and every code is gone.
 */
import { createServer } from 'node:http';
import { generateCode } from '../src/net/shortcode.js';

export const TTL_MS = 10 * 60 * 1000;
const MAX_BLOB = 16 * 1024; // an SDP is ~2 KB; anything larger is not ours
const MAX_SESSIONS = 500;

/** Session store, exported so the tests can drive it without a socket. */
export function createStore({ now = () => Date.now() } = {}) {
  const sessions = new Map();

  const sweep = () => {
    const cutoff = now();
    for (const [code, session] of sessions) {
      if (session.expiresAt <= cutoff) sessions.delete(code);
    }
  };

  return {
    get size() {
      sweep();
      return sessions.size;
    },
    create(offer) {
      sweep();
      if (sessions.size >= MAX_SESSIONS) throw new Error('busy');
      let code;
      do {
        code = generateCode();
      } while (sessions.has(code));
      sessions.set(code, { offer, answer: null, expiresAt: now() + TTL_MS });
      return code;
    },
    get(code) {
      sweep();
      return sessions.get(code) ?? null;
    },
    setAnswer(code, answer) {
      const session = this.get(code);
      if (!session) return false;
      session.answer = answer;
      return true;
    },
    /** Once both sides have what they need the code has served its purpose. */
    consume(code) {
      sessions.delete(code);
    },
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BLOB) {
        reject(new Error('payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

/**
 * The routing table, separated from the socket so it can be unit tested.
 * @returns {{status:number, body:object}}
 */
export async function handle({ method, path, body }, store) {
  if (method === 'GET' && path === '/health') {
    return { status: 200, body: { ok: true, sessions: store.size } };
  }

  if (method === 'POST' && path === '/session') {
    const offer = body?.offer;
    if (typeof offer !== 'string' || !offer) return { status: 400, body: { error: 'offer required' } };
    try {
      return { status: 200, body: { code: store.create(offer) } };
    } catch {
      return { status: 503, body: { error: 'too many sessions in flight, try again shortly' } };
    }
  }

  const answerMatch = path.match(/^\/session\/([^/]+)\/answer$/);
  if (answerMatch) {
    const code = decodeURIComponent(answerMatch[1]).toUpperCase();
    const session = store.get(code);
    if (!session) return { status: 404, body: { error: 'unknown or expired code' } };

    if (method === 'POST') {
      const answer = body?.answer;
      if (typeof answer !== 'string' || !answer) return { status: 400, body: { error: 'answer required' } };
      store.setAnswer(code, answer);
      return { status: 200, body: { ok: true } };
    }
    if (method === 'GET') {
      // Handing the answer over completes the handshake; drop the session.
      if (session.answer) {
        const answer = session.answer;
        store.consume(code);
        return { status: 200, body: { answer } };
      }
      return { status: 200, body: { answer: null } };
    }
  }

  const sessionMatch = path.match(/^\/session\/([^/]+)$/);
  if (method === 'GET' && sessionMatch) {
    const code = decodeURIComponent(sessionMatch[1]).toUpperCase();
    const session = store.get(code);
    if (!session) return { status: 404, body: { error: 'unknown or expired code' } };
    return { status: 200, body: { offer: session.offer } };
  }

  return { status: 404, body: { error: 'not found' } };
}

export function createRendezvousServer({ store = createStore() } = {}) {
  return createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS);
      response.end();
      return;
    }

    const url = new URL(request.url, 'http://localhost');
    let body = {};
    if (request.method === 'POST') {
      try {
        body = await readBody(request);
      } catch (error) {
        send(response, 400, { error: error.message });
        return;
      }
    }

    try {
      const result = await handle({ method: request.method, path: url.pathname, body }, store);
      send(response, result.status, result.body);
    } catch {
      send(response, 500, { error: 'internal error' });
    }
  });
}

// Run directly (not when imported by a test).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  createRendezvousServer().listen(port, () => {
    console.log(`Rendezvous server listening on http://localhost:${port}`);
    console.log('It stores connection codes only — no game data passes through it.');
  });
}
