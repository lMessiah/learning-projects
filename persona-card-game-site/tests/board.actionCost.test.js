/**
 * @vitest-environment jsdom
 *
 * What the player is TOLD a play costs.
 *
 * The engine half of this rule lives in tests/engine.actionCost.test.js. This
 * is the other half, and it is the one that actually broke: the fusion confirm
 * button read "Fuse — uses your action" for a long time after fusion stopped
 * costing one. The engine was never inconsistent. The promise was.
 *
 * So the test is not "does the copy look right" — it is "does every price the
 * UI quotes come from the engine's own verdict". These assertions are written
 * against CONFIG.FUSION_USES_ACTION rather than against whichever answer is
 * current, so that flipping the switch either way cannot leave a stale label
 * behind: if the copy stops tracking the engine, this fails in both directions.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, describeFusions } from '../src/engine/index.js';
import { CONFIG } from '../src/engine/config.js';
import { renderFusionPanel } from '../src/ui/game/fusionPanel.js';
import { setupMatch, setField, unlockFusion } from './helpers.js';

/** Jack Frost (Magician) + Apsaras (Priestess) at level 20 each -> Black Frost. */
function fusableBoard() {
  const state = setupMatch();
  setField(state, 0, [
    { cardId: 'jack-frost', active: true, level: 20 },
    { cardId: 'apsaras', level: 20 },
  ]);
  setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
  return unlockFusion(state);
}

const firstFusion = (state) => getLegalActions(state, 0).find((a) => a.type === 'FUSE');

const panelText = (options) =>
  renderFusionPanel({ skillNameOf: (id) => id, onDraft: () => {}, onConfirm: () => {}, onClose: () => {}, ...options })
    .body.textContent;

/** The confirm step for the first available fusion. */
function confirmText(state) {
  const fuse = firstFusion(state);
  expect(fuse).toBeTruthy();
  return panelText({
    state,
    playerId: 0,
    draft: { recipeId: fuse.recipeId, pairIndex: 0, inherit: [...fuse.inherit] },
  });
}

const CLAIMS_FREE = /free|costs no action|keeps your action/i;
const CLAIMS_COSTLY = /uses your action|costs your action|cost your action/i;

describe('the fusion panel quotes the price the engine actually charges', () => {
  it('names a price at all on the confirm button', () => {
    const text = confirmText(fusableBoard());
    expect(text).toMatch(/fuse/i);
    expect(text).toMatch(CLAIMS_FREE.test(text) ? CLAIMS_FREE : CLAIMS_COSTLY);
  });

  it('quotes the price the engine charges, and not the other one', () => {
    const text = confirmText(fusableBoard());

    if (CONFIG.FUSION_USES_ACTION) {
      expect(text).toMatch(CLAIMS_COSTLY);
      expect(text).not.toMatch(/costs no action|keeps your action/i);
    } else {
      expect(text).toMatch(CLAIMS_FREE);
      expect(text).not.toMatch(/uses your action|costs your action/i);
    }
  });

  it('agrees with the price carried on the legal action itself', () => {
    // The button reads entry.usesAction, so this pins the two together rather
    // than pinning the button to a remembered rule.
    const state = fusableBoard();
    expect(firstFusion(state).usesAction).toBe(CONFIG.FUSION_USES_ACTION);
    expect(CLAIMS_COSTLY.test(confirmText(state))).toBe(CONFIG.FUSION_USES_ACTION);
  });

  it('says the same thing in the read-only recipe list', () => {
    const text = panelText({ state: fusableBoard(), playerId: 0, draft: {}, readOnly: true });

    if (CONFIG.FUSION_USES_ACTION) {
      expect(text).toMatch(/costs your action/i);
      expect(text).not.toMatch(/does not cost your action|costs no action/i);
    } else {
      expect(text).toMatch(/does not cost your action|costs no action/i);
    }
  });

  it('marks every listed recipe as offence or defence', () => {
    // The alignment is what deck building uses to decide which material an
    // archetype is dealt, so the player is shown the same word rather than
    // being left to infer the plan from a statline.
    const { body } = renderFusionPanel({
      state: fusableBoard(),
      playerId: 0,
      draft: {},
      readOnly: true,
      skillNameOf: (id) => id,
      onDraft: () => {},
      onConfirm: () => {},
      onClose: () => {},
    });

    const rows = [...body.querySelectorAll('.fusion-recipe')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const tag = row.querySelector('.fusion-recipe__align');
      expect(tag, row.querySelector('.fusion-recipe__name')?.textContent).toBeTruthy();
      expect(tag.textContent).toMatch(/Offence|Defence/);
    }
    // Both kinds are on show, so neither branch is dead code.
    const text = body.textContent;
    expect(text).toMatch(/Offence/);
    expect(text).toMatch(/Defence/);
  });

  it('explains a spent action rather than blaming the materials', () => {
    // Attack first, then open the panel. Under the paid rule the recipe is no
    // longer offered, and the player is owed the real reason: the pair is fine,
    // the price cannot be met.
    let state = fusableBoard();
    state = applyAction(state, { type: 'GUARD', player: 0 });
    expect(state.turnState.actionsRemaining).toBe(0);

    if (CONFIG.FUSION_USES_ACTION) {
      expect(firstFusion(state)).toBeUndefined();
      // The panel lists every recipe, and the ones with no materials rightly say
      // so — this is only about the one whose materials are sitting on the board.
      const entry = describeFusions(state, 0).find((e) => e.recipe.id === 'fuse-black-frost');
      expect(entry.pairs.length).toBeGreaterThan(0);
      expect(entry.reason).toMatch(/no action left/i);
      expect(panelText({ state, playerId: 0, draft: {}, readOnly: true })).toMatch(/no action left/i);
    } else {
      expect(firstFusion(state)).toBeTruthy();
      expect(confirmText(state)).not.toMatch(/uses your action/i);
    }
  });
});
