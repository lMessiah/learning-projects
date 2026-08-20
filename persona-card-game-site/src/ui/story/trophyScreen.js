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
 */
import { TROPHIES } from './trophies.js';
import { getEarnedTrophies, isShelfUnlocked } from './trophyStore.js';

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
