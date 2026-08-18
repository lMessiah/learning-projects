/**
 * @vitest-environment jsdom
 *
 * "This Persona already knows eight skills — what does it forget?"
 *
 * The engine refuses a learn that would overflow MAX_SKILLS_PER_PERSONA unless
 * the action names a replacement, and fills in a sensible default so the bot
 * and a one-click player both work. This is the other half: the player must be
 * ABLE to overrule that default, and must be told the choice is happening.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, applyAction, CONFIG } from '../src/engine/index.js';
import { personaSkills } from '../src/engine/state.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { setField, setHand, activeOf } from './helpers.js';

const CAP = CONFIG.MAX_SKILLS_PER_PERSONA;
let root;
let unmount;
let controller;

/** Seat 0's active Pixie filled to exactly the cap, holding a Skill Card. */
function boot() {
  let state = createMatch({
    seed: 24,
    players: [
      { name: 'You', deckId: 'p5', controller: 'human' },
      { name: 'Them', deckId: 'p4', controller: 'human' },
    ],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });

  setField(state, 0, [{ cardId: 'pixie', level: 14, active: true }]);
  setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
  const p = activeOf(state, 0);
  const room = CAP - personaSkills(state, p).length;
  p.inheritedSkills = ['bufu', 'garu', 'agi', 'eiha', 'cleave', 'tarunda'].slice(0, room);
  setHand(state, 0, ['skill-card-agilao']);

  controller = createController({ state, botPlayer: null });
  unmount = mountBoard(root, { controller, viewer: 0, title: 'Test', onExit() {} });
  return controller;
}

const $$ = (sel) => [...document.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const byText = (sel, re) => $$(sel).find((n) => re.test(n.textContent));

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  unmount?.();
  controller?.destroy();
  root?.remove();
  unmount = null; controller = null; root = null;
  vi.useRealTimers();
});

describe('the skill-cap picker', () => {
  /** Play the Skill Card onto the full Pixie, reaching the drop step. */
  function reachPicker() {
    boot();
    // Hand cards are played through the inspect overlay, like every other card.
    const tile = root.querySelector('.hand-tile[data-card-id="skill-card-agilao"]');
    expect(tile, 'the Skill Card should be in hand').toBeTruthy();
    click(tile);
    const play = [...document.querySelectorAll('.card-detail-overlay button')]
      .find((b) => /^Play /.test(b.textContent));
    expect(play, 'the overlay should offer to play it').toBeTruthy();
    click(play);
    // Pixie is our only living Persona, so the engine already resolved the
    // target and we land straight on the drop question.
  }

  it('opens a picker instead of silently choosing for you', () => {
    reachPicker();
    const modal = document.querySelector('.modal');
    expect(modal).toBeTruthy();
    expect(modal.textContent).toMatch(new RegExp(`already knows ${CAP} skills`, 'i'));
    expect($$('.option-choice').length).toBe(CAP);
  });

  it('offers every skill it knows, and marks the engine suggestion', () => {
    reachPicker();
    const state = controller.getState();
    const known = personaSkills(state, activeOf(state, 0));
    const text = document.querySelector('.modal').textContent;
    for (const skill of known) expect(text).toContain(skill.name);
    expect($$('.option-choice--default')).toHaveLength(1);
    expect(document.querySelector('.option-choice--default').textContent).toMatch(/suggested/i);
  });

  it('forgets the one the player actually clicked, not the default', () => {
    reachPicker();
    const chosen = $$('.option-choice').find((n) => !n.className.includes('--default'));
    const forgetting = chosen.textContent.match(/Forget ([^·]+)/)[1].trim();

    click(chosen);

    const state = controller.getState();
    const now = personaSkills(state, activeOf(state, 0));
    expect(now).toHaveLength(CAP); // still at the cap, never over
    expect(now.map((s) => s.name)).not.toContain(forgetting);
    expect(now.map((s) => s.name)).toContain('Agilao'); // and it did learn
  });

  it('cancels out of the play entirely, learning nothing', () => {
    reachPicker();
    const before = personaSkills(controller.getState(), activeOf(controller.getState(), 0)).map((s) => s.id);

    click(byText('.modal .btn', /Cancel/i));

    const now = personaSkills(controller.getState(), activeOf(controller.getState(), 0)).map((s) => s.id);
    expect(now).toEqual(before);
    expect(document.querySelector('.modal')).toBeFalsy();
  });
});
