/**
 * Story Mode — the deck-select screen.
 *
 * Reached by exactly one route: a battle whose `playerDeck` is PLAYER_CHOICE.
 * Six of the seven battles hand the player an assigned loadout and never come
 * here at all, which is what makes arriving here feel like the campaign
 * stepping back rather than another setup screen.
 *
 * The pick is remembered (progress.js) so re-entering the battle does not mean
 * re-choosing from scratch.
 */
import { DECKS } from '../../data/cards.js';
import { renderArchetypeRow, ARCHETYPE_NOTE } from '../archetypeRow.js';
import { getChosenDeck, setChosenDeck } from './progress.js';

const DECK_SYMBOL = { p3: '🌙', p4: '🌫️', p5: '🎭' };

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

/**
 * @param battle   the battle being entered — captioned, never modified
 * @param onStart  called with { deckId, archetype } once the player commits
 * @param onExit   back to the campaign map
 */
export function renderStoryDeckSelect(root, { battle, onStart, onExit }) {
  root.innerHTML = '';
  const choice = { ...getChosenDeck() };

  const topbar = el('div', 'topbar');
  topbar.appendChild(button('← Campaign map', 'btn btn--ghost', onExit));
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', `Battle ${battle.number} · ${battle.name}`));
  titles.appendChild(el('div', 'topbar__sub', 'Choose what you bring.'));
  topbar.appendChild(titles);
  root.appendChild(topbar);

  const wrap = el('section', 'setup');
  wrap.appendChild(
    el(
      'p',
      'setup__note',
      'Every battle up to here handed you a deck to learn it with. This one does not — ' +
        'bring whichever of them you got on with, built however you like.'
    )
  );

  wrap.appendChild(el('h2', 'setup__heading', 'Choose your deck'));
  const deckRow = el('div', 'setup__row');
  const deckButtons = new Map();
  for (const deck of DECKS) {
    const node = el('button', 'setup-card');
    node.type = 'button';
    node.dataset.deck = deck.id;
    node.appendChild(el('span', 'setup-card__icon', DECK_SYMBOL[deck.id] || '🃏'));
    node.appendChild(el('span', 'setup-card__title', deck.name));
    node.appendChild(el('span', 'setup-card__tag', deck.game.toUpperCase()));
    node.appendChild(el('span', 'setup-card__desc', deck.playstyle || deck.tagline));
    node.addEventListener('click', () => {
      choice.deckId = deck.id;
      for (const [id, btn] of deckButtons) btn.classList.toggle('setup-card--on', id === deck.id);
    });
    deckButtons.set(deck.id, node);
    deckRow.appendChild(node);
  }
  deckButtons.get(choice.deckId)?.classList.add('setup-card--on');
  wrap.appendChild(deckRow);

  wrap.appendChild(el('h2', 'setup__heading', "Choose your deck's play style"));
  wrap.appendChild(
    renderArchetypeRow({
      value: choice.archetype,
      onPick: (id) => {
        choice.archetype = id;
      },
    })
  );
  wrap.appendChild(el('p', 'setup__note', ARCHETYPE_NOTE));

  const start = el('button', 'btn btn--primary setup__start', `▶ Face ${battle.opponent}`);
  start.type = 'button';
  start.addEventListener('click', () => {
    // Remembered before the match starts, so a mid-battle quit still keeps it.
    setChosenDeck(choice);
    onStart({ ...choice });
  });
  wrap.appendChild(start);

  root.appendChild(wrap);
}
