/**
 * Resignation, engine side.
 *
 * The asymmetry between `getLegalActions` (your turn only) and the handler
 * (any time) is deliberate and is the main thing worth pinning down: the legal
 * list is what the bot and the auto-end-turn logic read, and neither should
 * ever consider conceding, but a human who wants out should not have to wait
 * for their opponent's turn to finish.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, createRng, createMatch } from '../src/engine/index.js';
import { chooseBotAction, explainBotActions, DIFFICULTIES } from '../src/engine/bot.js';
import { setupMatch, endTurn } from './helpers.js';

describe('as a legal action', () => {
  it('is offered on your own turn', () => {
    const state = setupMatch();
    expect(getLegalActions(state, 0).some((a) => a.type === 'RESIGN')).toBe(true);
  });

  it('is not offered on your opponent\'s turn — but still works', () => {
    const state = setupMatch();
    expect(getLegalActions(state, 1).some((a) => a.type === 'RESIGN')).toBe(false);

    const next = applyAction(state, { type: 'RESIGN', player: 1 });
    expect(next.winner).toBe(0);
  });

  it('is not offered during starter selection, where there is no match yet', () => {
    const state = createMatch({ seed: 5, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p4' }] });
    expect(getLegalActions(state, 0).every((a) => a.type === 'CHOOSE_STARTER')).toBe(true);
  });

  it('carries a confirmation flag, so no UI can fire it by accident', () => {
    const resign = getLegalActions(setupMatch(), 0).find((a) => a.type === 'RESIGN');
    expect(resign.needsConfirmation).toBe(true);
  });
});

describe('resolving', () => {
  it('hands the win to the other player and ends the match', () => {
    const state = setupMatch();
    const next = applyAction(state, { type: 'RESIGN', player: 0 });

    expect(next.winner).toBe(1);
    expect(next.endReason).toBe('resign');
    expect(next.phase).toBe('gameOver');
    expect(next.log.some((e) => e.kind === 'resign' && e.text.includes('resigned'))).toBe(true);
  });

  it('works from either seat', () => {
    expect(applyAction(setupMatch(), { type: 'RESIGN', player: 1 }).winner).toBe(0);
  });

  it('does not touch the knockout tallies — you lost, you were not wiped out', () => {
    const next = applyAction(setupMatch(), { type: 'RESIGN', player: 0 });
    expect(next.players[0].koCount).toBe(0);
    expect(next.players[1].koCount).toBe(0);
  });

  it('cannot be done twice, or after the match has already ended', () => {
    const next = applyAction(setupMatch(), { type: 'RESIGN', player: 0 });
    expect(() => applyAction(next, { type: 'RESIGN', player: 1 })).toThrow(/already over/);
  });

  it('leaves the state it was given untouched, like every other action', () => {
    const state = setupMatch();
    const snapshot = JSON.stringify(state);
    applyAction(state, { type: 'RESIGN', player: 0 });
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('still works mid-turn, with an action already spent', () => {
    let state = setupMatch();
    state = applyAction(state, { type: 'GUARD', player: 0 });
    expect(state.turnState.actionsRemaining).toBe(0);
    expect(applyAction(state, { type: 'RESIGN', player: 0 }).winner).toBe(1);
  });
});

describe('the bot never resigns', () => {
  it('is filtered out of every difficulty\'s move list', () => {
    const state = setupMatch();
    for (const { id } of DIFFICULTIES) {
      expect(explainBotActions(state, 0, id).some((e) => e.action.type === 'RESIGN')).toBe(false);
    }
  });

  it('never picks it, however cornered, over a long run of seeds', () => {
    for (const { id } of DIFFICULTIES) {
      let state = setupMatch({ seed: 31 });
      let rng = createRng(9);
      for (let i = 0; i < 400 && state.winner === null; i++) {
        const [action, next] = chooseBotAction(state, state.activePlayer, id, rng);
        rng = next;
        if (!action) {
          state = endTurn(state);
          continue;
        }
        expect(action.type, `${id} tried to resign`).not.toBe('RESIGN');
        state = applyAction(state, action);
      }
      // Whatever happened, it was not a concession.
      if (state.winner !== null) expect(state.endReason).not.toBe('resign');
    }
  });
});
