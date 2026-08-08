/**
 * @vitest-environment jsdom
 *
 * Full matches played through the real board UI, one per bot difficulty.
 *
 * These live in their own file because each match drives hundreds of actions
 * and rebuilds the whole board every time; giving them a fresh environment
 * keeps the jsdom heap from piling up behind the lighter interaction tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, createRng, CONFIG } from '../src/engine/index.js';
import { chooseBotAction, DIFFICULTIES } from '../src/engine/bot.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';

let root;
let unmount;
let controller;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  unmount?.();
  controller?.destroy();
  root.remove();
  vi.useRealTimers();
});

/**
 * Play a whole match through the UI. The human seat is driven by the medium
 * AI: a player who only ever ends their turn would never put Personas on the
 * field, so they could never be knocked out and the match would never finish.
 */
function playFullMatch(difficulty, seed) {
  const state = createMatch({
    seed,
    players: [
      { name: 'You', deckId: 'p3', controller: 'human' },
      { name: `Bot (${difficulty})`, deckId: 'p4', controller: 'bot', difficulty },
    ],
  });
  controller = createController({ state, botPlayer: 1, difficulty, botSeed: seed + 1 });
  unmount = mountBoard(root, { controller, viewer: 0, title: 'Against Bot', subtitle: difficulty, onExit() {} });

  // Starter selection: click one of the three offered cards, let the bot pick.
  root.querySelectorAll('.starter-select .card')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  vi.advanceTimersByTime(5000);

  let humanRng = createRng(seed * 13 + 5);
  for (let i = 0; i < 4000 && controller.getState().winner === null; i++) {
    const current = controller.getState();
    if (current.activePlayer === 0) {
      const [action, next] = chooseBotAction(current, 0, 'medium', humanRng);
      humanRng = next;
      if (!action) break;
      controller.dispatch(action);
    } else {
      vi.advanceTimersByTime(600);
    }
  }
  return controller.getState();
}

describe('a full match through the UI', () => {
  for (const { id, label } of DIFFICULTIES) {
    it(`reaches a decisive result against the ${label} bot with no errors`, () => {
      const errors = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));

      const state = playFullMatch(id, 7);

      expect(errors).toEqual([]); // the controller logs here if the bot ever plays an illegal move
      expect(state.winner).not.toBe(null);
      expect(state.phase).toBe('gameOver');
      expect(state.players[state.winner === 0 ? 1 : 0].koCount).toBeGreaterThanOrEqual(CONFIG.KO_TARGET);

      // The result overlay is on screen with a rematch route out.
      expect(root.querySelector('.result')).toBeTruthy();
      expect(root.querySelector('.result h2').textContent).toMatch(/Victory|Defeat/);

      // The log stays bounded however long the match ran — the state is deep
      // copied on every action, so an unbounded log would be quadratic.
      expect(state.log.length).toBeLessThanOrEqual(400);
      expect(root.querySelectorAll('.log-entry').length).toBeLessThanOrEqual(151);

      spy.mockRestore();
    });
  }
});
