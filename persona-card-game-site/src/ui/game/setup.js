/**
 * Vs Bot setup: pick your deck and the bot's difficulty, then start the match.
 */
import { DECKS } from '../../data/cards.js';
import { DIFFICULTIES } from '../../engine/bot.js';
import { getProfileName } from '../profile.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const DECK_SYMBOL = { p3: '🌙', p4: '🌫️', p5: '🎭' };

export function renderBotSetup(root, { onStart, onExit }) {
  const choice = { deckId: DECKS[0].id, difficulty: 'medium' };
  root.innerHTML = '';

  const topbar = el('div', 'topbar');
  const back = el('button', 'btn btn--ghost', '← Menu');
  back.type = 'button';
  back.addEventListener('click', onExit);
  topbar.appendChild(back);
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'Against Bot'));
  titles.appendChild(el('div', 'topbar__sub', `Playing as ${getProfileName()}`));
  topbar.appendChild(titles);
  root.appendChild(topbar);

  const wrap = el('section', 'setup');

  // --- Deck -------------------------------------------------------------
  wrap.appendChild(el('h2', 'setup__heading', 'Choose your deck'));
  const deckRow = el('div', 'setup__row');
  const deckButtons = new Map();
  for (const deck of DECKS) {
    const node = el('button', 'setup-card');
    node.type = 'button';
    node.appendChild(el('span', 'setup-card__icon', DECK_SYMBOL[deck.id] || '🃏'));
    node.appendChild(el('span', 'setup-card__title', deck.name));
    node.appendChild(el('span', 'setup-card__tag', deck.game.toUpperCase()));
    node.appendChild(el('span', 'setup-card__desc', deck.tagline));
    node.addEventListener('click', () => {
      choice.deckId = deck.id;
      for (const [id, btn] of deckButtons) btn.classList.toggle('setup-card--on', id === deck.id);
    });
    deckButtons.set(deck.id, node);
    deckRow.appendChild(node);
  }
  deckButtons.get(choice.deckId).classList.add('setup-card--on');
  wrap.appendChild(deckRow);

  // --- Difficulty -------------------------------------------------------
  wrap.appendChild(el('h2', 'setup__heading', 'Choose a difficulty'));
  const diffRow = el('div', 'setup__row');
  const diffButtons = new Map();
  for (const difficulty of DIFFICULTIES) {
    const node = el('button', `setup-card setup-card--diff setup-card--${difficulty.id}`);
    node.type = 'button';
    node.appendChild(el('span', 'setup-card__title', difficulty.label));
    node.appendChild(el('span', 'setup-card__desc', difficulty.blurb));
    node.addEventListener('click', () => {
      choice.difficulty = difficulty.id;
      for (const [id, btn] of diffButtons) btn.classList.toggle('setup-card--on', id === difficulty.id);
    });
    diffButtons.set(difficulty.id, node);
    diffRow.appendChild(node);
  }
  diffButtons.get(choice.difficulty).classList.add('setup-card--on');
  wrap.appendChild(diffRow);

  wrap.appendChild(
    el(
      'p',
      'setup__note',
      'Your opponent draws one of the other two decks at random. Both of you will pick a starting Persona from 3 offered before the first turn.'
    )
  );

  const start = el('button', 'btn btn--primary setup__start', 'Start match');
  start.type = 'button';
  start.addEventListener('click', () => onStart({ ...choice }));
  wrap.appendChild(start);

  root.appendChild(wrap);
}
