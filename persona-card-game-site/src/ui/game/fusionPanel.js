/**
 * The fusion panel: a guided three-step flow.
 *
 *   recipes  -> every recipe, satisfiable ones highlighted, the rest greyed
 *               out with the reason ("Need a Death Persona", "Combined 14/20")
 *   material -> pick which two of your Personas to sacrifice
 *   confirm  -> preview the result and choose one inherited skill per parent
 *
 * Also doubles as a read-only recipe reference (`readOnly`), reachable from the
 * in-match menu so recipes are never a memory test.
 */
import { describeFusions, CONFIG, passiveDefinition, PASSIVE_CHOICE_PREFIX } from '../../engine/index.js';
import { getPersona } from '../../data/cards.js';
import { renderCard } from '../cardView.js';
import { arcanaStyle, personaSymbol } from '../arcana.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick, { disabled = false, title = '' } = {}) {
  const node = el('button', className, label);
  node.type = 'button';
  node.disabled = disabled;
  if (title) node.title = title;
  if (!disabled) node.addEventListener('click', onClick);
  return node;
}

/** True when at least one recipe could be performed right now. */
export function hasSatisfiableFusion(state, playerId) {
  return describeFusions(state, playerId).some((entry) => entry.satisfiable);
}

function parentChip(candidate) {
  const chip = el('span', 'fusion-parent');
  chip.appendChild(el('span', 'fusion-parent__name', `${candidate.name} Lv${candidate.level}`));
  chip.appendChild(
    el('span', `fusion-parent__zone fusion-parent__zone--${candidate.isActive ? 'active' : candidate.zone}`,
      candidate.isActive ? 'active' : candidate.zone)
  );
  return chip;
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

function renderRecipeList(entries, { readOnly, onPick, skillNameOf }) {
  const list = el('div', 'fusion-list');

  for (const entry of entries) {
    const row = el('div', `fusion-recipe${entry.satisfiable ? ' fusion-recipe--ready' : ' fusion-recipe--blocked'}`);
    const style = arcanaStyle(entry.result.arcana);
    row.style.setProperty('--arcana', style.color);

    const head = el('div', 'fusion-recipe__head');
    head.appendChild(el('span', 'fusion-recipe__symbol', personaSymbol(entry.result)));

    const titles = el('div', 'fusion-recipe__titles');
    const nameRow = el('div', 'fusion-recipe__nameRow');
    nameRow.appendChild(el('span', 'fusion-recipe__name', entry.result.name));
    // What the result is for, in one word. Worth the pixels because the whole
    // point of a recipe is deciding whether it is the one you want, and a
    // statline does not answer that at a glance.
    if (entry.alignment) {
      const tag = el(
        'span',
        `fusion-recipe__align fusion-recipe__align--${entry.alignment}`,
        entry.alignment === 'aggressive' ? '⚔️ Offence' : '🛡️ Defence'
      );
      tag.title =
        entry.alignment === 'aggressive'
          ? 'An offensive result: damage, reach and pressure.'
          : 'A defensive result: healing, bulk and staying power.';
      nameRow.appendChild(tag);
    }
    titles.appendChild(nameRow);
    titles.appendChild(
      el('span', 'fusion-recipe__formula',
        `${entry.arcana.join(' + ')} · combined Lv ${entry.minCombinedLevel}+ · result Lv ${entry.result.level}`)
    );
    head.appendChild(titles);

    if (entry.satisfiable) head.appendChild(el('span', 'fusion-recipe__badge', `${entry.pairs.length} way${entry.pairs.length === 1 ? '' : 's'}`));
    else head.appendChild(el('span', 'fusion-recipe__reason', entry.reason || 'Unavailable'));
    row.appendChild(head);

    if (!readOnly && entry.satisfiable) {
      row.appendChild(button('Choose material →', 'btn btn--primary btn--small', () => onPick(entry)));
    }
    list.appendChild(row);
  }

  return list;
}

function renderMaterial(entry, { onPick, onBack }) {
  const wrap = el('div', 'fusion-step');
  wrap.appendChild(
    el('p', 'modal__hint', `Choose the two Personas to sacrifice for ${entry.result.name}. Sacrifices do not count toward your opponent's KO tally.`)
  );

  for (const [index, pair] of entry.pairs.entries()) {
    const row = el('div', 'fusion-pair');
    const chips = el('div', 'fusion-pair__chips');
    chips.appendChild(parentChip(pair.a));
    chips.appendChild(el('span', 'fusion-pair__plus', '+'));
    chips.appendChild(parentChip(pair.b));
    row.appendChild(chips);
    row.appendChild(el('span', 'fusion-pair__level', `combined Lv ${pair.combined}`));
    row.appendChild(button('Select', 'btn btn--small', () => onPick(index)));
    wrap.appendChild(row);
  }

  wrap.appendChild(button('← Back to recipes', 'btn btn--ghost btn--small', onBack));
  return wrap;
}

function renderConfirm(entry, pair, draft, { onChange, onConfirm, onBack, skillNameOf }) {
  const wrap = el('div', 'fusion-step');

  const preview = el('div', 'fusion-preview');
  preview.appendChild(renderCard(entry.result, { showAllHidden: true }));

  const side = el('div', 'fusion-preview__side');
  side.appendChild(el('h4', 'fusion-preview__title', `${entry.result.name} enters at level ${entry.result.level}`));

  const cost = el('div', 'fusion-row__cost');
  cost.appendChild(el('span', 'fusion-row__cost-label', 'Sacrifice'));
  cost.appendChild(parentChip(pair.a));
  cost.appendChild(parentChip(pair.b));
  side.appendChild(cost);

  side.appendChild(
    el('p', 'modal__hint',
      'It keeps its own printed skills. From each parent, take ONE thing: a skill, or that parent\'s passive.')
  );

  [pair.a, pair.b].forEach((parent, index) => {
    const field = el('label', 'fusion-pick');
    field.appendChild(el('span', null, `Inherit from ${parent.name}`));
    const select = el('select');
    for (const skill of parent.skills) {
      const option = el('option', null, `${skill.name} — ${skill.description}`);
      option.value = skill.id;
      select.appendChild(option);
    }
    const parentPassive = parent.passive ? passiveDefinition(parent.passive) : null;
    if (parentPassive) {
      const option = el('option', null, `⭐ ${parentPassive.name} (passive) — ${parentPassive.description}`);
      option.value = `${PASSIVE_CHOICE_PREFIX}${parent.passive}`;
      select.appendChild(option);
    }
    select.value = draft.inherit[index] || parent.skills[0].id;
    select.addEventListener('change', () => onChange(index, select.value));
    field.appendChild(select);
    side.appendChild(field);
  });

  // Two passives can't both stick, and overwriting the result's own passive is
  // a real loss — so say so before the button rather than after the throw.
  const chosenPassives = draft.inherit.filter((c) => typeof c === 'string' && c.startsWith(PASSIVE_CHOICE_PREFIX));
  const nativePassive = entry.resultPassive ? passiveDefinition(entry.resultPassive) : null;
  const doubleUp = chosenPassives.length > 1;
  const overwrites =
    chosenPassives.length === 1 &&
    nativePassive &&
    chosenPassives[0] !== `${PASSIVE_CHOICE_PREFIX}${entry.resultPassive}`;

  if (nativePassive) {
    side.appendChild(
      el('p', 'modal__hint', `${entry.result.name} has its own passive: ${nativePassive.name}.`)
    );
  }
  if (doubleUp) {
    side.appendChild(el('p', 'fusion-warn', 'A fusion result can carry at most one passive — pick a skill from one parent.'));
  } else if (overwrites) {
    const incoming = passiveDefinition(chosenPassives[0].slice(PASSIVE_CHOICE_PREFIX.length));
    side.appendChild(
      el('p', 'fusion-warn', `This replaces ${nativePassive.name} with ${incoming?.name ?? 'the inherited passive'}. Confirm below.`)
    );
  }

  const actions = el('div', 'fusion-preview__actions');
  actions.appendChild(button('← Back', 'btn btn--ghost btn--small', onBack));
  // DESIGN NOTE: the price is read off `entry.usesAction`, which is the engine's
  // own verdict, and is never restated from memory here. This button once read
  // "Fuse — uses your action" while the engine charged nothing, and that stale
  // promise was the whole of a bug: whether fusing "took the turn" looked
  // random to the player. Reading the flag means the label cannot drift again,
  // in either direction — flipping FUSION_USES_ACTION rewrites this by itself.
  const priceLabel = entry.usesAction ? 'Fuse — uses your action' : 'Fuse — free, keeps your action';
  const priceHint = entry.usesAction
    ? `Fusion costs your action for this turn, and you get ${CONFIG.FUSIONS_PER_TURN} per turn.`
    : `Fusion costs no action — you can fuse and still attack. ${CONFIG.FUSIONS_PER_TURN} per turn.`;
  actions.appendChild(
    button(overwrites ? 'Replace passive and fuse' : priceLabel, 'btn btn--primary', () => onConfirm(), {
      disabled: doubleUp,
      title: doubleUp ? 'Only one passive can survive a fusion' : priceHint,
    })
  );
  side.appendChild(actions);

  preview.appendChild(side);
  wrap.appendChild(preview);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

/**
 * @param options { state, playerId, draft, readOnly, onDraft, onConfirm, onClose, skillNameOf }
 * @returns the modal body element and a title
 */
export function renderFusionPanel(options) {
  const { state, playerId, draft, readOnly = false, onDraft, onConfirm, skillNameOf } = options;
  const entries = describeFusions(state, playerId);
  const body = el('div', 'modal__body');

  if (readOnly) {
    body.appendChild(
      el('p', 'modal__hint',
        `${CONFIG.FUSION_USES_ACTION
          ? `Fusion costs your action, and you get ${CONFIG.FUSIONS_PER_TURN} per turn — fuse or attack, not both.`
          : `Fusion is a free play, ${CONFIG.FUSIONS_PER_TURN} per turn — it does not cost your action, so you can fuse and still attack.`
        } Sacrifice two of your Personas (field and/or hand) matching a recipe. The result enters at its printed level and inherits one thing from each parent: a skill, or that parent's passive. Field cap is ${CONFIG.FIELD_CAP}.`)
    );
    body.appendChild(renderRecipeList(entries, { readOnly: true, skillNameOf }));
    return { body, title: 'Fusion recipes' };
  }

  const entry = draft.recipeId ? entries.find((e) => e.recipe.id === draft.recipeId) : null;

  // The board may have changed under a half-finished selection (a Persona was
  // knocked out, say) — fall back to the recipe list rather than showing junk.
  if (!entry || !entry.satisfiable) {
    body.appendChild(
      el('p', 'modal__hint', 'Pick a recipe. Ready recipes are highlighted; the rest show what they still need.')
    );
    body.appendChild(
      renderRecipeList(entries, {
        readOnly: false,
        skillNameOf,
        onPick: (picked) => onDraft({ recipeId: picked.recipe.id, pairIndex: null, inherit: [] }),
      })
    );
    const ready = entries.filter((e) => e.satisfiable).length;
    return { body, title: `Fusion — ${ready} of ${entries.length} ready` };
  }

  if (draft.pairIndex == null || !entry.pairs[draft.pairIndex]) {
    body.appendChild(
      renderMaterial(entry, {
        onPick: (index) =>
          onDraft({
            ...draft,
            pairIndex: index,
            inherit: [entry.pairs[index].a.skills[0].id, entry.pairs[index].b.skills[0].id],
          }),
        onBack: () => onDraft({ recipeId: null, pairIndex: null, inherit: [] }),
      })
    );
    return { body, title: `Fusion — ${entry.result.name}` };
  }

  const pair = entry.pairs[draft.pairIndex];
  body.appendChild(
    renderConfirm(entry, pair, draft, {
      skillNameOf,
      onChange: (index, value) => {
        const inherit = [...draft.inherit];
        inherit[index] = value;
        onDraft({ ...draft, inherit });
      },
      onConfirm: () =>
        onConfirm({
          type: 'FUSE',
          player: playerId,
          recipeId: entry.recipe.id,
          result: entry.recipe.result,
          sacrifices: [
            { zone: pair.a.zone, uid: pair.a.uid },
            { zone: pair.b.zone, uid: pair.b.uid },
          ],
          inherit: [draft.inherit[0] || pair.a.skills[0].id, draft.inherit[1] || pair.b.skills[0].id],
          // Reaching the confirm button IS the confirmation: the panel spells
          // out what would be overwritten right above it.
          replacePassive: true,
        }),
      onBack: () => onDraft({ ...draft, pairIndex: null, inherit: [] }),
    })
  );
  return { body, title: `Fusion — ${entry.result.name}` };
}
