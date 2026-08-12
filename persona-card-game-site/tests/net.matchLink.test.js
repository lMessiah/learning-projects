/**
 * @vitest-environment jsdom
 *
 * The shareable match link: how it is built, how it is read back off the URL,
 * and the two ends of the flow it drives — a host waiting on a link and a guest
 * arriving through one. The relay is real (see net.websocket.test.js); what is
 * exercised here is the routing and the screens either side of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { createRelayServer } from '../server/relay.js';
import { shareLinkFor, joinCodeFromHash, renderOnline } from '../src/ui/game/online.js';
import { getRelayUrl, setSetting, resetSettings, DEFAULT_RELAY } from '../src/ui/settings.js';
import { relayHealthUrl, defaultRelayUrl } from '../src/net/websocket.js';

let root;
let server;
let relayUrl;

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const text = () => root.textContent;
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/** Let pending promises (probe, connect) settle. */
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 20));
};

/**
 * jsdom has no WebSocket, and Node's built-in one cannot be used from inside it:
 * it builds events with jsdom's `Event` constructor and then dispatches them on
 * its own EventTarget, which rejects them as foreign. The `ws` client is a real
 * WebSocket that speaks the browser's `addEventListener` interface, so the code
 * under test runs exactly as it does in a browser.
 */
const originalWebSocket = globalThis.WebSocket;

beforeEach(async () => {
  globalThis.WebSocket = NodeWebSocket;
  localStorage.clear();
  resetSettings();
  root = document.createElement('div');
  document.body.appendChild(root);
  window.location.hash = '#/online';

  server = createRelayServer();
  await new Promise((resolve) => server.listen(0, resolve));
  relayUrl = `ws://localhost:${server.address().port}/ws`;
  setSetting('relayUrl', relayUrl);
});

afterEach(() => {
  root.remove();
  server?.close();
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

describe('the link itself', () => {
  it('puts the code in the hash, where a static site can route on it', () => {
    const link = shareLinkFor('ABC234', { origin: 'https://game.example', pathname: '/' });
    expect(link).toBe('https://game.example/#/join/ABC234');
  });

  it('survives a subdirectory deployment', () => {
    const link = shareLinkFor('K7M2QX', { origin: 'https://example.com', pathname: '/persona/' });
    expect(link).toBe('https://example.com/persona/#/join/K7M2QX');
  });

  it('reads the code back, forgiving the case a mail client mangled', () => {
    expect(joinCodeFromHash('#/join/ABC234')).toBe('ABC234');
    expect(joinCodeFromHash('#/join/abc234')).toBe('ABC234');
    expect(joinCodeFromHash('#/online')).toBe('');
    expect(joinCodeFromHash('#/')).toBe('');
    expect(joinCodeFromHash(undefined)).toBe('');
  });

  it('round-trips: a link built here is a code read back there', () => {
    const link = shareLinkFor('MJ7PQ2', { origin: 'https://game.example', pathname: '/' });
    expect(joinCodeFromHash(new URL(link).hash)).toBe('MJ7PQ2');
  });
});

describe('the relay address', () => {
  it('defaults to the page it was served from, so a deployed site needs no setting', () => {
    resetSettings();
    expect(getRelayUrl({ relayUrl: '' })).toBe(defaultRelayUrl());
    expect(getRelayUrl({ relayUrl: DEFAULT_RELAY })).toBe(DEFAULT_RELAY);
  });

  it('derives the health probe from the socket address', () => {
    expect(relayHealthUrl('wss://game.example/ws')).toBe('https://game.example/ws/health');
    expect(relayHealthUrl('ws://localhost:8788/ws')).toBe('http://localhost:8788/ws/health');
    expect(relayHealthUrl('')).toBe('');
  });

  it('answers the health probe under both paths', async () => {
    const base = relayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
    for (const path of ['/health', '/ws/health']) {
      const response = await fetch(`${base}${path}`);
      expect(response.ok).toBe(true);
      expect((await response.json()).ok).toBe(true);
    }
  });
});

describe('hosting by link', () => {
  it('shows a copyable link and waits, without a second code to paste', async () => {
    renderOnline(root);
    click($$('.setup-card').find((c) => c.dataset.role === 'host'));
    click($('.setup__start')); // create the invite
    await settle();

    const link = $('.code-block__code--link');
    expect(link).toBeTruthy();
    expect(link.value).toContain('#/join/');
    expect(joinCodeFromHash(new URL(link.value).hash)).toHaveLength(6);

    // The code is offered as well, for when a link is awkward to send.
    expect($('.short-code')).toBeTruthy();
    expect(text()).toContain('Waiting for them to join');
    // The peer-to-peer handshake is gone from this path entirely.
    expect(text()).not.toContain('paste');
  });
});

describe('joining by link', () => {
  it('refuses a malformed code without touching the network', async () => {
    renderOnline(root, { joinCode: 'NOPE' });
    await settle();
    expect(text()).toContain('not a valid match code');
  });

  it('reports a dead relay in terms a player can act on', async () => {
    setSetting('relayUrl', 'ws://localhost:1/ws'); // nothing listening
    renderOnline(root, { joinCode: 'ABC234' });
    await settle();
    expect(text()).toMatch(/needs a relay server/i);
    expect(text()).toContain('npm run relay');
  });

  it('tells the guest when the code names no open match', async () => {
    renderOnline(root, { joinCode: 'ABC234' }); // nobody is hosting it
    await settle();
    expect(text()).toMatch(/unknown or has expired/i);
    expect($$('button').some((b) => /back to online menu/i.test(b.textContent))).toBe(true);
  });

  it('connects two browsers through the relay and deals the match', async () => {
    // The host, in this document...
    renderOnline(root, {});
    click($$('.setup-card').find((c) => c.dataset.role === 'host'));
    click($('.setup__start'));
    await settle();
    const code = joinCodeFromHash(new URL($('.code-block__code--link').value).hash);

    // ...and the guest, in a second root, sharing the same relay.
    //
    // The guest needs a SECOND INSTANCE of the route module. `online.js` keeps
    // one module-level teardown handle, which is right for a browser (one page,
    // one connection) but means that in one process the guest's render would
    // cancel the host's connection. Two players are two pages; `resetModules`
    // is how a single process gets two of them.
    vi.resetModules();
    const guestModule = await import('../src/ui/game/online.js');
    const guestRoot = document.createElement('div');
    document.body.appendChild(guestRoot);
    guestModule.renderOnline(guestRoot, { joinCode: code });
    await settle(12);

    // Both sides left their waiting screens and mounted a board. A match opens
    // in starter select, so that — not the play area — is what is on screen.
    expect(root.querySelector('.starter-select')).toBeTruthy();
    expect(guestRoot.querySelector('.starter-select')).toBeTruthy();
    expect(root.textContent).toContain('You are hosting');
    expect(guestRoot.textContent).toContain('Connected to host');
    expect(root.textContent).not.toContain('Waiting for them to join');

    // Each side is offered its own three Personas and cannot see the other's.
    expect(guestRoot.querySelectorAll('.starter-select .card').length).toBeGreaterThan(0);

    guestRoot.remove();
  });
});
