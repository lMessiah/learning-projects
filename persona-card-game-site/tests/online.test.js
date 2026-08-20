/**
 * Online multiplayer: hidden-information redaction and the host-authoritative
 * protocol. The transport is swapped for an in-memory loopback pair, so a full
 * two-player match is played here with no network involved.
 */
import { describe, it, expect } from 'vitest';
import {
  createMatch,
  applyAction,
  getLegalActions,
  createRng,
  redactStateFor,
  isRedacted,
  findLeaks,
  HIDDEN_CARD,
  CONFIG,
} from '../src/engine/index.js';
import { chooseBotAction } from '../src/engine/bot.js';
import { createLoopbackPair } from '../src/net/transport.js';
import { createHostSession, createGuestSession, HOST_SEAT, GUEST_SEAT } from '../src/net/onlineMatch.js';
import { encodeSignal, decodeSignal } from '../src/net/webrtc.js';

function startedMatch(seed = 5) {
  let state = createMatch({
    seed,
    players: [{ name: 'Host', deckId: 'p3' }, { name: 'Guest', deckId: 'p5' }],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  return state;
}

describe('state redaction', () => {
  it('hides the opponent\'s hand but keeps the count', () => {
    const state = startedMatch();
    const view = redactStateFor(state, HOST_SEAT);

    expect(view.players[GUEST_SEAT].hand).toHaveLength(state.players[GUEST_SEAT].hand.length);
    for (const entry of view.players[GUEST_SEAT].hand) {
      expect(entry.cardId).toBe(HIDDEN_CARD);
      expect(entry.hidden).toBe(true);
      expect(entry.uid).toBeTruthy(); // identity is kept so counts and animations line up
    }
  });

  it('keeps your own hand fully readable', () => {
    const state = startedMatch();
    const view = redactStateFor(state, HOST_SEAT);
    expect(view.players[HOST_SEAT].hand.map((c) => c.cardId))
      .toEqual(state.players[HOST_SEAT].hand.map((c) => c.cardId));
  });

  it('hides both deck orders and the RNG, so nothing can be predicted', () => {
    const view = redactStateFor(startedMatch(), HOST_SEAT);
    for (const player of view.players) {
      expect(player.deck.every((card) => card === HIDDEN_CARD)).toBe(true);
    }
    expect(view.rng.s).toBeUndefined();
    expect(view.seed).toBe(null);
  });

  it('leaves public information alone', () => {
    const state = startedMatch();
    const view = redactStateFor(state, GUEST_SEAT);

    expect(view.players[HOST_SEAT].field).toEqual(state.players[HOST_SEAT].field);
    expect(view.players[HOST_SEAT].koCount).toBe(state.players[HOST_SEAT].koCount);
    expect(view.players[HOST_SEAT].discard).toEqual(state.players[HOST_SEAT].discard);
    expect(view.log).toEqual(state.log);
    expect(view.turn).toBe(state.turn);
  });

  it('reports no leaks for either seat, at any point in a match', () => {
    let state = createMatch({ seed: 11, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p5' }] });
    let rng = createRng(99);

    for (let i = 0; i < 250 && state.winner === null; i++) {
      for (const seat of [HOST_SEAT, GUEST_SEAT]) {
        const view = redactStateFor(state, seat);
        expect(isRedacted(view)).toBe(true);
        expect(findLeaks(view, seat)).toEqual([]);
      }
      const pid = state.phase === 'starterSelect'
        ? state.players.findIndex((p) => p.field.length === 0)
        : state.activePlayer;
      const [action, next] = chooseBotAction(state, pid, 'medium', rng);
      rng = next;
      if (!action) break;
      state = applyAction(state, action);
    }
  });

  it('never mutates the authoritative state', () => {
    const state = startedMatch();
    const before = JSON.stringify(state);
    redactStateFor(state, HOST_SEAT);
    redactStateFor(state, GUEST_SEAT);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('still supports computing your own legal actions', () => {
    const state = startedMatch();
    const view = redactStateFor(state, HOST_SEAT);
    // The board and the guest both rely on this working off a redacted view.
    expect(getLegalActions(view, HOST_SEAT).map((a) => a.type).sort())
      .toEqual(getLegalActions(state, HOST_SEAT).map((a) => a.type).sort());
  });
});

describe('host-authoritative protocol', () => {
  function connect({ seed = 7 } = {}) {
    const [hostWire, guestWire] = createLoopbackPair();
    const host = createHostSession(hostWire, {
      hostName: 'Alice',
      guestName: 'Bob',
      hostDeckId: 'p3',
      guestDeckId: 'p5',
      seed,
      // Time is driven by hand in the disconnect tests; here it simply must not
      // run on its own and end a match mid-assertion.
      autoTick: false,
    });
    const guest = createGuestSession(guestWire, { name: 'Bob', autoTick: false });
    host.start();
    guest.start();
    return { host, guest, hostWire, guestWire };
  }

  it('hands the guest a redacted view as soon as it connects', () => {
    const { guest } = connect();
    const view = guest.getState();
    expect(view).toBeTruthy();
    expect(isRedacted(view)).toBe(true);
    expect(findLeaks(view, GUEST_SEAT)).toEqual([]);
  });

  it('gives each side its own viewpoint of the same match', () => {
    const { host, guest } = connect();
    expect(host.getState().turn).toBe(guest.getState().turn);
    // Each can read their own hand and neither can read the other's.
    expect(host.getState().players[HOST_SEAT].hand.every((c) => c.cardId)).toBe(true);
    expect(host.getState().players[GUEST_SEAT].hand.every((c) => c.cardId === HIDDEN_CARD)).toBe(true);
    expect(guest.getState().players[GUEST_SEAT].hand.every((c) => c.cardId)).toBe(true);
    expect(guest.getState().players[HOST_SEAT].hand.every((c) => c.cardId === HIDDEN_CARD)).toBe(true);
  });

  it('applies a guest action on the host and pushes the result back', () => {
    const { host, guest } = connect();

    // Starter selection, one seat at a time.
    host.dispatch({ type: 'CHOOSE_STARTER', player: HOST_SEAT, cardId: host.getState().starterOptions[HOST_SEAT][0] });
    const guestOption = guest.getState().starterOptions[GUEST_SEAT][0];
    guest.dispatch({ type: 'CHOOSE_STARTER', player: GUEST_SEAT, cardId: guestOption });

    expect(host.getState().phase).toBe('playing');
    expect(guest.getState().phase).toBe('playing');
    expect(guest.getState().players[GUEST_SEAT].field[0].cardId).toBe(guestOption);
  });

  it('refuses an action played for the other side', () => {
    const { host, guest } = connect();
    expect(() => guest.dispatch({ type: 'CHOOSE_STARTER', player: HOST_SEAT, cardId: 'pixie' }))
      .toThrow(/only act for your own side/);
    expect(() => host.dispatch({ type: 'CHOOSE_STARTER', player: GUEST_SEAT, cardId: 'pixie' }))
      .toThrow(/only act for your own side/);
  });

  it('refuses an illegal move locally, before it ever reaches the wire', () => {
    const { host, guest } = connect();
    host.dispatch({ type: 'CHOOSE_STARTER', player: HOST_SEAT, cardId: host.getState().starterOptions[HOST_SEAT][0] });
    guest.dispatch({ type: 'CHOOSE_STARTER', player: GUEST_SEAT, cardId: guest.getState().starterOptions[GUEST_SEAT][0] });

    // It is the host's turn, so the guest cannot act. The local check gives
    // instant feedback rather than waiting for a round trip.
    expect(() => guest.dispatch({ type: 'PASS', player: GUEST_SEAT })).toThrow(/not something you can do/);
  });

  it('and the host refuses it too, even if a client skips that check', () => {
    const { host, guestWire } = connect();
    const errors = [];
    host.dispatch({ type: 'CHOOSE_STARTER', player: HOST_SEAT, cardId: host.getState().starterOptions[HOST_SEAT][0] });

    guestWire.onMessage((message) => {
      if (message.t === 'reject') errors.push(message.message);
    });

    const before = JSON.stringify(host.getState());
    // A tampered client sending a raw action straight down the wire.
    guestWire.send({ t: 'action', id: 99, action: { type: 'PASS', player: GUEST_SEAT } });

    expect(JSON.stringify(host.getState())).toBe(before); // authoritative state untouched
    expect(errors.length).toBe(1);
  });

  it('will not let a tampered client act for the host', () => {
    const { host, guestWire } = connect();
    const before = JSON.stringify(host.getState());
    guestWire.send({
      t: 'action',
      id: 1,
      action: { type: 'CHOOSE_STARTER', player: HOST_SEAT, cardId: host.getState().starterOptions[HOST_SEAT][0] },
    });
    expect(JSON.stringify(host.getState())).toBe(before);
  });

  it('never lets the guest see a state the host did not produce', () => {
    const { host, guest } = connect();
    const seen = [];
    guest.subscribe((view) => seen.push(view.turn));

    host.dispatch({ type: 'CHOOSE_STARTER', player: HOST_SEAT, cardId: host.getState().starterOptions[HOST_SEAT][0] });
    guest.dispatch({ type: 'CHOOSE_STARTER', player: GUEST_SEAT, cardId: guest.getState().starterOptions[GUEST_SEAT][0] });

    expect(seen.length).toBeGreaterThan(0);
    expect(guest.getState().turn).toBe(host.getState().turn);
  });

  /**
   * A dropped connection used to be reported to both sides as an error and that
   * was the end of it. It is now the START of the grace period: both sides put
   * up a countdown and the match is left intact, because the player may well be
   * back. See tests/net.disconnect.test.js for the countdown itself.
   */
  it('starts a grace countdown on both sides when the connection drops', () => {
    const { host, guest, guestWire } = connect();

    guestWire.close('network lost');
    host.tick();
    guest.tick();

    expect(host.presenceState().opponentOnline).toBe(false);
    expect(host.presenceState().graceDeadline).not.toBe(null);
    expect(guest.presenceState().graceDeadline).not.toBe(null);

    // Neither side has decided anything yet — that is what the 60 seconds are for.
    expect(host.getState().winner).toBe(null);
    expect(guest.getState().winner).toBe(null);
  });

  it('plays a complete match end to end across the wire', () => {
    const { host, guest } = connect({ seed: 3 });
    const sides = { [HOST_SEAT]: host, [GUEST_SEAT]: guest };
    let rng = createRng(2024);

    for (let steps = 0; steps < 6000; steps++) {
      const view = host.getState();
      if (view.winner !== null) break;

      const seat = view.phase === 'starterSelect'
        ? view.players.findIndex((p) => p.field.length === 0)
        : view.activePlayer;
      const side = sides[seat];

      // Each side decides using ONLY its own redacted view — exactly what a
      // real client has to work with.
      const [action, next] = chooseBotAction(side.getState(), seat, 'medium', rng);
      rng = next;
      if (!action) break;
      side.dispatch(action);
    }

    const final = host.getState();
    expect(final.winner).not.toBe(null);
    expect(guest.getState().winner).toBe(final.winner);
    expect(final.players[final.winner === 0 ? 1 : 0].koCount).toBeGreaterThanOrEqual(CONFIG.KO_TARGET);
    // And the guest never once saw anything it should not have.
    expect(findLeaks(guest.getState(), GUEST_SEAT)).toEqual([]);
  });

  it('reports a dropped connection in plain language', () => {
    const { host, guest } = connect();
    host.destroy();
    expect(() => guest.dispatch({ type: 'CHOOSE_STARTER', player: GUEST_SEAT, cardId: 'pixie' }))
      .toThrow(/Connection lost/);
  });
});

describe('connection codes', () => {
  it('round-trips a session description', () => {
    const description = { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\na=test\r\n' };
    const code = encodeSignal(description);

    expect(code).toMatch(/^[A-Za-z0-9+/]+$/); // one pasteable token, no padding
    expect(decodeSignal(code)).toEqual(description);
    expect(decodeSignal(`  ${code.slice(0, 10)}\n${code.slice(10)}  `)).toEqual(description); // whitespace tolerant
  });

  it('explains itself when the code is wrong', () => {
    expect(() => decodeSignal('')).toThrow(/empty/);
    expect(() => decodeSignal('!!!not a code!!!')).toThrow(/valid code/);
    expect(() => decodeSignal(btoa('{"nope":1}'))).toThrow(/missing part/);
  });
});
