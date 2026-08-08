/**
 * Card inspection: hover tooltip on desktop, tap-through detail overlay
 * everywhere. Both show the *full* card — stats, every skill with its cost,
 * and whatever weaknesses the viewer is allowed to know.
 */
import { getPersona, getCard } from '../../data/cards.js';
import { renderCard } from '../cardView.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ *
 * Full card for a board Persona or a hand card
 * ------------------------------------------------------------------ */

/** Build the full inspection card for a live Persona instance. */
export function fullPersonaCard(persona, viewer) {
  const own = persona.owner === viewer;
  return renderCard(getPersona(persona.cardId), {
    instance: persona,
    showAllHidden: own,
    revealed: own ? null : persona.revealedTypes,
  });
}

/** Build the full inspection card for a card sitting in hand. */
export function fullHandCard(cardId) {
  return renderCard(getCard(cardId), { showAllHidden: true });
}

/* ------------------------------------------------------------------ *
 * Hover tooltip (desktop)
 * ------------------------------------------------------------------ */

let tooltipHost = null;

function ensureTooltipHost() {
  if (tooltipHost && document.body.contains(tooltipHost)) return tooltipHost;
  tooltipHost = el('div', 'card-tooltip');
  tooltipHost.setAttribute('role', 'tooltip');
  tooltipHost.hidden = true;
  document.body.appendChild(tooltipHost);
  return tooltipHost;
}

export function hideTooltip() {
  if (tooltipHost) {
    tooltipHost.hidden = true;
    tooltipHost.innerHTML = '';
  }
}

function showTooltip(anchor, buildCard) {
  // Pointer-driven only: touch devices get the overlay instead.
  if (window.matchMedia?.('(hover: none)').matches) return;

  const host = ensureTooltipHost();
  host.innerHTML = '';
  host.appendChild(buildCard());
  host.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const box = host.getBoundingClientRect();
  const margin = 10;

  // Prefer to the right, flip left if it would overflow, then clamp vertically.
  let left = rect.right + margin;
  if (left + box.width > window.innerWidth - margin) left = rect.left - box.width - margin;
  if (left < margin) left = margin;

  let top = rect.top + rect.height / 2 - box.height / 2;
  top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));

  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}

/* ------------------------------------------------------------------ *
 * Detail overlay (works on touch)
 * ------------------------------------------------------------------ */

/**
 * Open the large card detail. `actions` is a list of { label, hint, onPick }
 * so the overlay is also how you act on a card without a mouse.
 */
export function openCardDetail(host, { buildCard, title, subtitle, actions = [], onClose }) {
  const overlay = el('div', 'modal-overlay card-detail-overlay');

  const box = el('div', 'card-detail');
  const head = el('div', 'card-detail__head');
  const titles = el('div');
  titles.appendChild(el('h3', null, title));
  if (subtitle) titles.appendChild(el('span', 'card-detail__sub', subtitle));
  head.appendChild(titles);

  const close = el('button', 'btn btn--ghost btn--small', '✕');
  close.type = 'button';
  head.appendChild(close);
  box.appendChild(head);

  const body = el('div', 'card-detail__body');
  body.appendChild(buildCard());
  box.appendChild(body);

  if (actions.length) {
    const bar = el('div', 'card-detail__actions');
    for (const action of actions) {
      const btn = el('button', `btn ${action.primary ? 'btn--primary' : ''}`, action.label);
      btn.type = 'button';
      if (action.hint) btn.title = action.hint;
      btn.disabled = Boolean(action.disabled);
      if (!action.disabled) {
        btn.addEventListener('click', () => {
          dismiss();
          action.onPick();
        });
      }
      bar.appendChild(btn);
    }
    box.appendChild(bar);
  } else {
    box.appendChild(el('p', 'card-detail__note', 'Nothing you can do with this card right now.'));
  }

  overlay.appendChild(box);

  function dismiss() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  function onKey(event) {
    if (event.key === 'Escape') dismiss();
  }

  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKey);

  host.appendChild(overlay);
  return dismiss;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

/**
 * Make a board/hand element inspectable.
 *  - hover  -> tooltip with the full card (pointer devices only)
 *  - click  -> detail overlay, unless `onDirectClick` claims it (targeting mode,
 *              where an explicit prompt is already on screen)
 */
export function makeInspectable(node, { buildCard, detail, onDirectClick = null }) {
  node.classList.add('inspectable');

  node.addEventListener('mouseenter', () => showTooltip(node, buildCard));
  node.addEventListener('mouseleave', hideTooltip);
  node.addEventListener('focus', () => showTooltip(node, buildCard));
  node.addEventListener('blur', hideTooltip);

  node.addEventListener('click', (event) => {
    event.stopPropagation();
    hideTooltip();
    if (onDirectClick) onDirectClick();
    else detail();
  });

  node.tabIndex = 0;
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      node.click();
    }
  });

  return node;
}
