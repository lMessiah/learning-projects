/**
 * @vitest-environment jsdom
 *
 * Story Mode stages 2 and 3: retries, the checkpoint, and the escalating tips.
 *
 * Losses are produced by resigning rather than by playing a match out. A resign
 * is a real loss through the real engine — `winner` flips, `endReason` is set,
 * the story subscriber fires exactly as it would after twenty turns — it just
 * costs a millisecond instead of ten seconds. The one full match this feature
 * pays for is in story.win.test.js.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const built = [];

vi.mock('../src/ui/game/controller.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createController(...args) {
      const controller = actual.createController(...args);
      built.push(controller);
      return controller;
    },
  };
});

const { renderStory } = await import('../src/ui/story/index.js');
const { BATTLES, BATTLE_COUNT, MAX_RETRIES, CHECKPOINT_AFTER_BATTLE, checkpointFor, getBattle } = await import(
  '../src/ui/story/campaign.js'
);
const { LOSS_TIPS, lossTip, tipDepth, battlesMissingTips } = await import('../src/ui/story/tips.js');
const {
  getStoryProgress,
  recordBattleCleared,
  recordBattleLost,
  lossesOn,
  retriesRemaining,
  resetStoryProgress,
  reloadStoryProgress,
} = await import('../src/ui/story/progress.js');
const { resetTrophies } = await import('../src/ui/story/trophyStore.js');

let root;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  document.body.className = '';
  window.location.hash = '';
  localStorage.clear();
  resetStoryProgress();
  resetTrophies();
  built.length = 0;
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  renderStory(root, {});
  for (const controller of built) controller.destroy();
  built.length = 0;
  document.body.innerHTML = '';
  document.body.className = '';
  vi.useRealTimers();
});

const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const $$ = (sel) => [...root.querySelectorAll(sel)];
const resultButtons = () => $$('.result__actions .btn').map((b) => b.textContent);

/** Enter a battle and lose it by resigning. Returns the live controller. */
function loseBattle(number) {
  renderStory(root, { battleNumber: number });
  const controller = built.at(-1);
  // No starter click: a story battle chooses its starters inside the builder,
  // so the board mounts straight into the playing phase. See battleSetup.js.
  vi.advanceTimersByTime(2000);
  controller.dispatch({ type: 'RESIGN', player: 0 });
  vi.advanceTimersByTime(2000);
  // Skip the defeat outro so the result screen is on the page.
  const outro = root.querySelector('.match-outro');
  if (outro) click(outro);
  return controller;
}

/* ------------------------------------------------------------------ *
 * Stage 2 — the retry counter
 * ------------------------------------------------------------------ */

describe('retries', () => {
  it('starts every battle with a full allowance', () => {
    expect(retriesRemaining(1)).toBe(MAX_RETRIES);
    expect(lossesOn(1)).toBe(0);
  });

  it('spends one per loss and reports what is left', () => {
    const first = recordBattleLost(1);
    expect(first.failedOut).toBe(false);
    expect(first.retriesRemaining).toBe(MAX_RETRIES - 1);

    const second = recordBattleLost(1);
    expect(second.failedOut).toBe(false);
    expect(second.retriesRemaining).toBe(MAX_RETRIES - 2);
  });

  it('fails the run out on the MAX_RETRIES-th loss', () => {
    for (let i = 1; i < MAX_RETRIES; i++) expect(recordBattleLost(1).failedOut).toBe(false);
    const last = recordBattleLost(1);
    expect(last.failedOut).toBe(true);
    expect(last.retriesRemaining).toBe(0);
  });

  it('gives a beaten battle its retries back if it is played again', () => {
    recordBattleLost(1);
    expect(retriesRemaining(1)).toBe(MAX_RETRIES - 1);
    recordBattleCleared(1);
    expect(retriesRemaining(1)).toBe(MAX_RETRIES);
    expect(lossesOn(1)).toBe(0);
  });

  it('counts retries spent across the whole run, and a fallback does not forgive them', () => {
    for (let i = 0; i < MAX_RETRIES; i++) recordBattleLost(1);
    // The run fell back here; the tally must survive it, or No Continues would
    // be earnable by a player who failed out and recovered.
    expect(getStoryProgress().retriesUsed).toBe(MAX_RETRIES);
    expect(reloadStoryProgress().retriesUsed).toBe(MAX_RETRIES);
  });

  it('is wiped by a full campaign reset', () => {
    recordBattleLost(1);
    resetStoryProgress();
    expect(getStoryProgress().retriesUsed).toBe(0);
    expect(retriesRemaining(1)).toBe(MAX_RETRIES);
  });
});

/* ------------------------------------------------------------------ *
 * Stage 2 — the checkpoint
 * ------------------------------------------------------------------ */

describe('the checkpoint', () => {
  it('sends battles at or before it back to the start, and later ones to just past it', () => {
    for (let n = 1; n <= CHECKPOINT_AFTER_BATTLE; n++) expect(checkpointFor(n)).toBe(1);
    for (let n = CHECKPOINT_AFTER_BATTLE + 1; n <= BATTLE_COUNT; n++) {
      expect(checkpointFor(n)).toBe(CHECKPOINT_AFTER_BATTLE + 1);
    }
  });

  it('rolls the run back to Battle 1 when failing out early', () => {
    recordBattleCleared(1);
    recordBattleCleared(2);
    for (let i = 0; i < MAX_RETRIES; i++) recordBattleLost(3);

    const progress = getStoryProgress();
    expect(progress.currentBattle).toBe(1);
    expect(progress.cleared).toEqual([]);
  });

  it('rolls back only to the checkpoint when failing out late', () => {
    for (let n = 1; n <= 5; n++) recordBattleCleared(n);
    expect(getStoryProgress().currentBattle).toBe(6);

    for (let i = 0; i < MAX_RETRIES; i++) recordBattleLost(6);

    const progress = getStoryProgress();
    expect(progress.currentBattle).toBe(CHECKPOINT_AFTER_BATTLE + 1);
    // Everything past the checkpoint has to be earned again, or the map would
    // show battles as beaten while sending the player back before them.
    expect(progress.cleared).toEqual([1, 2, 3]);
  });

  it('clears the loss counters so the checkpoint battle starts fresh', () => {
    for (let n = 1; n <= 3; n++) recordBattleCleared(n);
    recordBattleLost(4);
    for (let i = 0; i < MAX_RETRIES; i++) recordBattleLost(5);

    expect(getStoryProgress().attempts).toEqual({});
    expect(retriesRemaining(4)).toBe(MAX_RETRIES);
  });

  it('survives a reload at the moment of the fallback', () => {
    for (let n = 1; n <= 4; n++) recordBattleCleared(n);
    for (let i = 0; i < MAX_RETRIES; i++) recordBattleLost(5);
    // The rollback is written on the loss, not on the button press — a player
    // who closes the tab on the "you fell back" screen comes back to Battle 4.
    expect(reloadStoryProgress().currentBattle).toBe(CHECKPOINT_AFTER_BATTLE + 1);
  });
});

/* ------------------------------------------------------------------ *
 * Stage 2 — what the player is actually shown
 * ------------------------------------------------------------------ */

describe('the loss screen', () => {
  it('states the retries remaining and offers a retry', () => {
    loseBattle(1);
    expect(root.querySelector('.story-result__banner').textContent).toContain(`${MAX_RETRIES - 1} retries remaining`);
    expect(resultButtons()[0]).toContain(`Try again (${MAX_RETRIES - 1} left)`);
    expect(resultButtons().some((l) => l.includes('Campaign map'))).toBe(true);
  });

  it('counts down across losses', () => {
    loseBattle(1);
    click($$('.result__actions .btn')[0]); // Try again
    const controller = built.at(-1);
    vi.advanceTimersByTime(2000);
    controller.dispatch({ type: 'RESIGN', player: 0 });
    vi.advanceTimersByTime(2000);
    click(root.querySelector('.match-outro'));

    const left = MAX_RETRIES - 2;
    expect(root.querySelector('.story-result__banner').textContent).toContain(
      `${left} ${left === 1 ? 'retry' : 'retries'} remaining`
    );
    expect(retriesRemaining(1)).toBe(left);
  });

  it('announces the fallback and routes to the checkpoint on the last loss', () => {
    // Burn every retry but the last through the store, then lose on screen.
    for (let i = 0; i < MAX_RETRIES - 1; i++) recordBattleLost(1);
    loseBattle(1);

    const banner = root.querySelector('.story-result__banner--fail');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Out of retries');
    expect(banner.textContent).toContain('Battle 1');
    expect(resultButtons()[0]).toContain('Restart from Battle 1');
  });

  it('restarts from the checkpoint even when it is the battle already open', () => {
    // The bug this guards: `location.hash` is already '#/story/1', so setting it
    // fires no hashchange and the button would do nothing at all.
    for (let i = 0; i < MAX_RETRIES - 1; i++) recordBattleLost(1);
    window.location.hash = '#/story/1';
    loseBattle(1);

    click($$('.result__actions .btn')[0]);
    expect(root.querySelector('.board-screen')).toBeTruthy();
    expect(root.querySelector('.result')).toBeNull(); // a fresh match, not the old result
  });

  it('shows the retry count on the campaign map too', () => {
    recordBattleLost(1);
    renderStory(root, {});
    const status = root.querySelector('.story-card .story-card__status');
    expect(status.textContent).toContain(`${MAX_RETRIES - 1} retries left`);
    expect(status.className).toContain('story-card__status--warn');
  });

  it('marks where the checkpoint is before the player needs it', () => {
    renderStory(root, {});
    const marked = $$('.story-card__checkpoint');
    expect(marked).toHaveLength(1);
    expect($$('.story-card')[CHECKPOINT_AFTER_BATTLE - 1].querySelector('.story-card__checkpoint')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Stage 3 — the tips
 * ------------------------------------------------------------------ */

describe('loss tips', () => {
  it('authors a tip for every battle in the campaign', () => {
    expect(battlesMissingTips()).toEqual([]);
  });

  it('authors enough escalation steps to cover every retry', () => {
    for (const battle of BATTLES) {
      expect(tipDepth(battle.id), `${battle.id} tip depth`).toBeGreaterThanOrEqual(MAX_RETRIES);
    }
  });

  it('escalates: each attempt gets different, later text', () => {
    for (const battle of BATTLES) {
      const seen = new Set();
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const tip = lossTip(battle.id, attempt);
        expect(tip, `${battle.id} attempt ${attempt}`).toBeTruthy();
        seen.add(tip);
      }
      expect(seen.size, `${battle.id} repeats itself`).toBe(MAX_RETRIES);
    }
  });

  it('clamps out-of-range attempts to the clearest tip rather than going silent', () => {
    const battle = BATTLES[0];
    const last = LOSS_TIPS[battle.id].at(-1);
    expect(lossTip(battle.id, 99)).toBe(last);
    expect(lossTip(battle.id, 0)).toBe(LOSS_TIPS[battle.id][0]);
    expect(lossTip(battle.id, -3)).toBe(LOSS_TIPS[battle.id][0]);
  });

  it('returns null for a battle with nothing authored', () => {
    expect(lossTip('no-such-battle', 1)).toBeNull();
    expect(tipDepth('no-such-battle')).toBe(0);
  });

  it('is keyed by battle id, so reordering the campaign carries tips with it', () => {
    for (const id of Object.keys(LOSS_TIPS)) {
      expect(BATTLES.some((b) => b.id === id), `${id} has tips but is not a battle`).toBe(true);
    }
  });

  it('puts the right escalation step on screen for the attempt just lost', () => {
    loseBattle(1);
    expect(root.querySelector('.story-result__tip-text').textContent).toBe(lossTip(BATTLES[0].id, 1));

    click($$('.result__actions .btn')[0]);
    const controller = built.at(-1);
    vi.advanceTimersByTime(2000);
    controller.dispatch({ type: 'RESIGN', player: 0 });
    vi.advanceTimersByTime(2000);
    click(root.querySelector('.match-outro'));

    expect(root.querySelector('.story-result__tip-text').textContent).toBe(lossTip(BATTLES[0].id, 2));
  });

  it('names the battle the tip is about', () => {
    const battle = getBattle(1);
    loseBattle(1);
    expect(root.querySelector('.story-result__tip-who').textContent).toContain(battle.name);
  });
});
