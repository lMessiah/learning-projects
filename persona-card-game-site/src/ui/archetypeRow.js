/**
 * The archetype picker — a second row under the deck flavour, on every setup
 * screen (vs bot, hot-seat, online). Mario-Kart style: the flavour is the
 * character, the archetype is the loadout.
 */
import { ARCHETYPES } from '../data/archetypes.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param value    the currently selected archetype id
 * @param onPick   called with the new id
 * @returns the row element
 */
export function renderArchetypeRow({ value, onPick }) {
  const row = el('div', 'setup__row');
  const buttons = new Map();

  for (const archetype of ARCHETYPES) {
    const node = el('button', `setup-card setup-card--archetype setup-card--${archetype.id}`);
    node.type = 'button';
    node.dataset.archetype = archetype.id;
    node.appendChild(el('span', 'setup-card__icon', archetype.icon));
    node.appendChild(el('span', 'setup-card__title', archetype.name));
    node.appendChild(el('span', 'setup-card__desc', archetype.blurb));
    node.addEventListener('click', () => {
      onPick(archetype.id);
      for (const [id, btn] of buttons) btn.classList.toggle('setup-card--on', id === archetype.id);
    });
    buttons.set(archetype.id, node);
    row.appendChild(node);
  }

  buttons.get(value)?.classList.add('setup-card--on');
  return row;
}

export const ARCHETYPE_HEADING = 'Choose a play style';
export const ARCHETYPE_NOTE =
  'Your deck is built from the flavour you picked, weighted toward this play style. The 30 cards are ' +
  'rolled from the match seed, so no two matches deal you quite the same deck.';
