/**
 * Hidden-information redaction.
 *
 * The authoritative state holds everything: both hands, both deck orders, the
 * RNG seed. A player must never receive that, so every view handed to a client
 * goes through here first.
 *
 * This is deliberately part of the engine rather than the network layer: it is
 * a rule about what a player is allowed to know, and the same function will be
 * what an authoritative server sends down the wire.
 */
import { cloneState, opponentOf, remainingPersonaArcana } from './state.js';
import { getCard } from '../data/cards.js';

/**
 * How far into their own deck a player is currently allowed to look.
 *
 * Only a card in hand grants it, and only for as long as it is in hand — Shuffle
 * Time reads 3, Providence reads 5.
 */
function deckPeekDepth(player) {
  let depth = 0;
  for (const entry of player.hand) {
    if (!entry.cardId) continue;
    const effect = getCard(entry.cardId).effect;
    if (effect?.kind === 'shuffleTime') depth = Math.max(depth, effect.look ?? 3);
    if (effect?.kind === 'providence') depth = Math.max(depth, effect.look ?? 5);
  }
  return depth;
}

/** Placeholder for a card the viewer is not allowed to identify. */
export const HIDDEN_CARD = null;

/**
 * The state as `viewerId` is permitted to see it.
 *
 *  - the opponent's hand becomes face-down placeholders (count preserved)
 *  - BOTH deck orders are hidden — you do not know your own next draw either
 *  - the RNG is stripped, so nobody can predict an ailment roll or a draw
 *  - the opponent's offered starter choices are hidden
 *
 * Everything else — fields, HP/SP, buffs, discards, KO tallies, the log — is
 * public by the rules of the game and passes through untouched. Weakness
 * masking is handled separately by `visibleAffinities`, which already works
 * off `revealedTypes` on each Persona.
 */
export function redactStateFor(state, viewerId) {
  const view = cloneState(state);
  const foe = opponentOf(viewerId);

  // Full Analysis buys the right to read the opponent's hand for the turn. It
  // is a rule about what a player may KNOW, so it belongs here rather than in
  // a UI that quietly peeks at a hidden hand.
  const peeking = Boolean(state.turnState?.peekHand) && state.activePlayer === viewerId;
  if (!peeking) {
    view.players[foe].hand = view.players[foe].hand.map((entry) => ({
      uid: entry.uid,
      cardId: HIDDEN_CARD,
      hidden: true,
    }));
  }

  // Deck ORDER is secret from everyone, including its owner. What is still in
  // your own deck is not: you built it, and Fortune's Draw asks you to name an
  // Arcana from it. So the viewer keeps an order-free summary of their own.
  for (const [index, player] of view.players.entries()) {
    if (index === viewerId) {
      player.deckArcana = remainingPersonaArcana(view, viewerId);
      // Shuffle Time and Providence are the only things that let a player read
      // the top of their own deck, and only while they hold the card.
      const look = deckPeekDepth(player);
      if (look) player.deckTop = player.deck.slice(0, look);
    }
    player.deck = player.deck.map(() => HIDDEN_CARD);

    // Whims of Fate resolves against weaknesses the caller may never have
    // uncovered. The card fetches the answer; it does not hand over the
    // question, so the resolved type list never reaches either client.
    if (player.pendingDraw?.types) player.pendingDraw = { fate: true };
  }

  view.rng = { hidden: true };
  view.seed = null;

  if (view.starterOptions) {
    view.starterOptions = view.starterOptions.map((options, index) => (index === viewerId ? options : []));
  }

  view.viewer = viewerId;
  view.redacted = true;
  return view;
}

/**
 * True when a state has been redacted. The UI uses this to avoid assuming it
 * can read anything secret, and tests use it as a tripwire.
 */
export function isRedacted(state) {
  return Boolean(state?.redacted);
}

/**
 * Everything a redacted view must never contain. Exported so tests can assert
 * the guarantee rather than restating it.
 */
export function findLeaks(view, viewerId) {
  const leaks = [];
  const foe = opponentOf(viewerId);

  // Full Analysis legitimately opens the opponent's hand for the turn.
  const peeking = Boolean(view.turnState?.peekHand) && view.activePlayer === viewerId;
  if (!peeking) {
    for (const entry of view.players[foe].hand) {
      if (entry.cardId !== HIDDEN_CARD) leaks.push(`opponent hand card ${entry.uid} is identifiable`);
    }
  }
  for (const [index, player] of view.players.entries()) {
    for (const card of player.deck) {
      if (card !== HIDDEN_CARD) leaks.push(`player ${index} deck order is visible`);
    }
    if (index === foe && player.deckArcana) leaks.push("opponent's deck contents are visible");
    if (index === foe && player.deckTop) leaks.push("opponent's deck order is visible");
    if (index === viewerId && player.deckTop && !deckPeekDepth(player)) {
      leaks.push('deck order is visible without a card that grants it');
    }
    if (player.pendingDraw?.types) leaks.push(`player ${index}'s Whims of Fate reading is visible`);
  }
  if (view.rng && view.rng.s !== undefined) leaks.push('RNG state is visible');
  if (view.seed) leaks.push('match seed is visible');
  if (view.starterOptions?.[foe]?.length) leaks.push("opponent's starter options are visible");

  return leaks;
}
