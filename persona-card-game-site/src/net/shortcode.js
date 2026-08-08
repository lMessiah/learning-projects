/**
 * Short connection codes.
 *
 * A WebRTC session description cannot itself be shortened below ~86 characters
 * — it carries a 32-byte DTLS fingerprint, ~26 bytes of ICE credentials and the
 * candidate addresses, and none of that is redundant. A six-character code is
 * therefore not the connection details; it is a *key* to them, held briefly by
 * a rendezvous server (see server/rendezvous.js).
 *
 * That server is optional. With none configured the app falls back to the
 * serverless copy-paste handshake, which needs no infrastructure at all.
 */

/**
 * Unambiguous alphabet. Drops both halves of every pair that is easy to
 * mis-read or mis-hear: 0/O, 1/I/L, 5/S. 29^6 is still ~594 million, far more
 * than enough for codes that live ten minutes.
 */
export const CODE_ALPHABET = '2346789ABCDEFGHJKMNPQRTUVWXYZ';
export const CODE_LENGTH = 6;

/** A fresh random code. */
export function generateCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Accept what a human actually types: lower case, spaces, dashes. Characters
 * outside the alphabet are dropped rather than guessed at — the alphabet
 * already excludes every pair that is easy to confuse.
 */
export function normaliseCode(input) {
  return [...String(input ?? '').toUpperCase()]
    .filter((char) => CODE_ALPHABET.includes(char))
    .join('')
    .slice(0, CODE_LENGTH);
}

export function isValidCode(input) {
  return normaliseCode(input).length === CODE_LENGTH;
}

/* ------------------------------------------------------------------ *
 * Rendezvous client
 * ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT = 120000;
const POLL_INTERVAL = 1200;

/**
 * Client for the rendezvous server. It only ever stores two opaque blobs under
 * a short key — it never sees game state, and the peers still talk directly to
 * each other once connected.
 *
 * `fetchImpl` is injected rather than reaching for a global, so tests can drive
 * it without patching anything.
 */
export function createRendezvousClient(baseUrl, { fetchImpl = null } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);

  async function call(path, options = {}) {
    const response = await doFetch(`${base}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? 'That code has expired or does not exist.'
          : `The rendezvous server returned an error (${response.status}).`
      );
    }
    return response.json();
  }

  return {
    /** Is a server actually there? Decides which mode the UI offers. */
    async available() {
      try {
        const response = await doFetch(`${base}/health`, { method: 'GET' });
        return response.ok;
      } catch {
        return false;
      }
    },

    /** Host: publish the offer, get back the short code players will type. */
    async publishOffer(offer) {
      const { code } = await call('/session', { method: 'POST', body: JSON.stringify({ offer }) });
      return code;
    },

    /** Guest: exchange the short code for the offer blob. */
    async fetchOffer(code) {
      const { offer } = await call(`/session/${encodeURIComponent(code)}`, { method: 'GET' });
      return offer;
    },

    /** Guest: post the answer back under the same code. */
    async publishAnswer(code, answer) {
      await call(`/session/${encodeURIComponent(code)}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer }),
      });
    },

    /** Host: wait for the guest's answer to appear. */
    async waitForAnswer(code, { timeout = DEFAULT_TIMEOUT, signal } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('Cancelled.');
        const { answer } = await call(`/session/${encodeURIComponent(code)}/answer`, { method: 'GET' });
        if (answer) return answer;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }
      throw new Error('Nobody joined in time. Create a new code and try again.');
    },
  };
}
