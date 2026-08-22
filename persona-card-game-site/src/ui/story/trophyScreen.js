/**
 * The Trophy Shelf.
 *
 * Reachable only once the first trophy has been earned — see trophyStore.js.
 * Every entry point into this screen checks `isShelfUnlocked()` first, and the
 * route itself checks again, so a bookmarked `#/trophies` cannot reveal the
 * system early.
 *
 * Locked trophies ARE shown here, with their names and conditions. Hiding them
 * would leave a screen that is mostly empty rectangles; the thing that was
 * hidden is the shelf itself, and that has already been earned by anyone
 * standing here.
 *
 * This screen is also where the full shelf is spent: filling it unlocks the two
 * custom messages (ui/flair.js), and the editor for them lives at the bottom of
 * this page because that is where the reward for finishing belongs.
 */
import { TROPHIES } from './trophies.js';
import { getEarnedTrophies, isShelfUnlocked } from './trophyStore.js';
import { isAdminUnlocked } from '../admin.js';
import { FLAIR_LIMITS, clearFlair, getFlair, setFlair } from '../flair.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** Has every trophy on the shelf been earned? */
export function hasEveryTrophy(earned = getEarnedTrophies()) {
  return TROPHIES.every((trophy) => Object.hasOwn(earned, trophy.id));
}

/**
 * May this player write their own match messages? See ui/flair.js.
 *
 * The admin clause is belt-and-braces: activating the unlock awards every
 * trophy, so `hasEveryTrophy` already covers it — until someone wipes the shelf
 * from Settings, at which point an admin who has been told they get everything
 * would find one thing missing.
 *
 * This is the ONE gate on the feature, and it lives here rather than in
 * ui/flair.js so that the board — which every mode shares — does not import the
 * trophy store and the whole campaign behind it just to print a heading.
 */
export function isFlairUnlocked(earned = getEarnedTrophies()) {
  return hasEveryTrophy(earned) || isAdminUnlocked();
}

/**
 * The custom-message editor.
 *
 * Two one-line inputs, saved as they are edited — there is no Save button
 * because there is nothing to fail: this is a string in localStorage, and a
 * player who typed something and navigated away would reasonably expect to find
 * it still there.
 *
 * Locked, it is a single line naming the reward rather than a hidden section.
 * The shelf already shows every locked trophy with its condition, and this is
 * the only reward for clearing the whole thing — hiding it would make the last
 * trophies feel like they were for nothing.
 */
function renderFlairEditor(unlocked) {
  const wrap = el('section', 'setup flair-editor');
  wrap.appendChild(el('h2', 'flair-editor__title', 'Custom messages'));

  if (!unlocked) {
    wrap.appendChild(
      el(
        'p',
        'flair-editor__locked',
        'Earn every trophy to write your own victory line and your own knockout note.'
      )
    );
    return wrap;
  }

  wrap.appendChild(
    el(
      'p',
      'setup__note',
      'Earned by filling the shelf. Both are yours to write, both are decoration, and neither ' +
        'changes a single rule.'
    )
  );

  const fields = [
    {
      key: 'win',
      label: 'Victory message',
      hint: 'Shown instead of "Victory" on your result screen when you win.',
      placeholder: 'Victory',
    },
    {
      key: 'knockout',
      label: 'Knockout message',
      hint: 'Pops up when you knock out one of their Personas — on your screen and on theirs.',
      placeholder: 'Say nothing',
    },
  ];

  const flair = getFlair();
  const inputs = [];

  for (const field of fields) {
    const row = el('label', 'seat-name seat-name--wide');
    row.appendChild(el('span', null, field.label));
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = FLAIR_LIMITS[field.key];
    input.placeholder = field.placeholder;
    input.value = flair[field.key];
    input.dataset.flair = field.key;
    // `change` rather than `input`: saving every keystroke would write to
    // localStorage a few dozen times per sentence for no benefit.
    input.addEventListener('change', () => {
      input.value = setFlair({ [field.key]: input.value })[field.key];
    });
    row.appendChild(input);
    wrap.appendChild(row);
    wrap.appendChild(el('p', 'flair-editor__hint', field.hint));
    inputs.push(input);
  }

  wrap.appendChild(
    button('Clear both', 'btn btn--small', () => {
      clearFlair();
      for (const input of inputs) input.value = '';
    })
  );

  return wrap;
}

export function renderTrophies(root) {
  root.innerHTML = '';

  // Not an error screen: someone who types the URL early should simply find the
  // menu, not a notice telling them there is something to find.
  if (!isShelfUnlocked()) {
    window.location.hash = '#/';
    return;
  }

  const earned = getEarnedTrophies();
  const count = TROPHIES.filter((t) => Object.hasOwn(earned, t.id)).length;

  const topbar = el('div', 'topbar');
  topbar.appendChild(
    button('← Menu', 'btn btn--ghost', () => {
      window.location.hash = '#/';
    })
  );
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'Trophy Shelf'));
  titles.appendChild(el('div', 'topbar__sub', `${count} of ${TROPHIES.length} earned`));
  topbar.appendChild(titles);
  root.appendChild(topbar);

  const wrap = el('section', 'setup');
  const grid = el('div', 'trophy-grid');

  for (const trophy of TROPHIES) {
    const at = earned[trophy.id];
    const held = Object.hasOwn(earned, trophy.id);

    const node = el('div', `trophy${held ? ' trophy--earned' : ' trophy--locked'}`);
    node.dataset.trophy = trophy.id;
    node.appendChild(el('span', 'trophy__icon', held ? trophy.icon : '🔒'));
    node.appendChild(el('span', 'trophy__name', trophy.name));
    node.appendChild(el('span', 'trophy__desc', trophy.description));
    node.appendChild(
      el('span', 'trophy__when', held ? (at ? `Earned ${DATE.format(new Date(at))}` : 'Earned') : 'Locked')
    );
    grid.appendChild(node);
  }

  wrap.appendChild(grid);
  wrap.appendChild(
    el(
      'p',
      'setup__note',
      'Trophies are kept on this device and are not tied to your campaign progress — ' +
        'resetting Story Mode leaves the shelf exactly as it is.'
    )
  );
  root.appendChild(wrap);
  root.appendChild(renderFlairEditor(isFlairUnlocked(earned)));
}

/**
 * The reveal, and the "you earned these" strip on a result screen.
 *
 * @param ids           trophy ids awarded by the match just finished
 * @param onOpenShelf   navigates to the shelf; the reveal makes a point of it
 */
export function renderTrophyAwards(ids, { onOpenShelf, revealed = false } = {}) {
  if (!ids.length) return null;

  const box = el('div', `trophy-awards${revealed ? ' trophy-awards--reveal' : ''}`);
  box.appendChild(
    el(
      'h3',
      'trophy-awards__heading',
      revealed
        ? 'You have unlocked the Trophy Shelf'
        : ids.length === 1
          ? 'Trophy earned'
          : `${ids.length} trophies earned`
    )
  );

  if (revealed) {
    box.appendChild(
      el(
        'p',
        'trophy-awards__blurb',
        `There were trophies all along. There are ${TROPHIES.length - 1} more of them, ` +
          'and now you can see what they are.'
      )
    );
  }

  const list = el('div', 'trophy-awards__list');
  for (const id of ids) {
    const trophy = TROPHIES.find((t) => t.id === id);
    if (!trophy) continue;
    const row = el('div', 'trophy-awards__item');
    row.dataset.trophy = trophy.id;
    row.appendChild(el('span', 'trophy__icon', trophy.icon));
    const text = el('span', 'trophy-awards__text');
    text.appendChild(el('span', 'trophy__name', trophy.name));
    text.appendChild(el('span', 'trophy__desc', trophy.description));
    row.appendChild(text);
    list.appendChild(row);
  }
  box.appendChild(list);

  if (onOpenShelf) {
    box.appendChild(button('🏆 Open the Trophy Shelf', 'btn btn--small', onOpenShelf));
  }
  return box;
}
