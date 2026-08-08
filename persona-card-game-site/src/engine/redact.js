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
import { cloneState, opponentOf } from './state.js';

/** Placeholder for a card the viewer is not allowed to identify. */
export const HIDDEN_CARD = null;

/**
 * The state as `viewerId` is permitted to see it.
 *
 *  - the opponent's hand becomes face-down placeholders (count preserved)
 *  - BOTH deck orders are hidden — you do not know your own next draw either
 *  - the RNG is stripped, so nobody can predict an ailment or instant-kill roll
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

  view.players[foe].hand = view.players[foe].hand.map((entry) => ({
    uid: entry.uid,
    cardId: HIDDEN_CARD,
    hidden: true,
  }));

  // Deck contents are secret from everyone, including their owner.
  for (const player of view.players) {
    player.deck = player.deck.map(() => HIDDEN_CARD);
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

  for (const entry of view.players[foe].hand) {
    if (entry.cardId !== HIDDEN_CARD) leaks.push(`opponent hand card ${entry.uid} is identifiable`);
  }
  for (const [index, player] of view.players.entries()) {
    for (const card of player.deck) {
      if (card !== HIDDEN_CARD) leaks.push(`player ${index} deck order is visible`);
    }
  }
  if (view.rng && view.rng.s !== undefined) leaks.push('RNG state is visible');
  if (view.seed) leaks.push('match seed is visible');
  if (view.starterOptions?.[foe]?.length) leaks.push("opponent's starter options are visible");

  return leaks;
}
