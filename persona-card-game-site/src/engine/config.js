/**
 * Tunable rule constants. Everything the designers might want to retune lives
 * here so the rest of the engine never hard-codes a number.
 */
export const CONFIG = Object.freeze({
  // Board
  FIELD_CAP: 8, // active + bench, KO'd Personas don't count
  KO_TARGET: 8, // KO this many of the opponent's Personas to win

  // Power curve: a Persona card can only be played to the field if its printed
  // level is at most (highest level among your field Personas + this). High
  // tier cards sit in hand until the rest of your board has grown into them,
  // so a turn-3 draw can never drop a level 46 Persona onto the board.
  PLAY_LEVEL_GAP: 10,
  // Nothing above this level appears in a prebuilt deck; stronger Personas are
  // fusion-only. Enforced by validateDatabase().
  DECK_MAX_PERSONA_LEVEL: 25,

  // Cards
  OPENING_HAND: 5,
  DRAW_PER_TURN: 1,
  PASS_DRAW: 1, // extra card drawn when you pass your action
  HAND_LIMIT: 7, // discard down to this at end of turn

  // Per-turn allowances
  ACTIONS_PER_TURN: 1,
  PERSONA_CHANGES_PER_TURN: 1,
  // One More is granted only by knocking a STANDING enemy down with a weakness
  // hit. Baseline is one per turn; the Trickster passive lifts the cap so
  // knockdowns scored *during* a One More keep the chain alive.
  MAX_ONE_MORE_PER_TURN: 1,
  ITEMS_PER_TURN: 1, // you may play at most one Item card per turn
  SPECIALS_PER_TURN: 1, // ...and at most one Special card per turn
  // Fusion does NOT cost your action — it is a free play like an Item or a
  // Special, and is rationed the same way instead.
  //
  // DESIGN NOTE: it used to cost the action, and that was the reason fusion
  // hardly ever happened: it competed directly with attacking, and attacking
  // wins that comparison almost every turn. Metering it per turn rather than
  // through the action budget keeps it from running away — without a cap you
  // could fuse your whole board into one Persona in a single turn.
  FUSIONS_PER_TURN: 1,

  // SP economy
  //
  // Every Persona ENTERS PLAY AT FULL SP — starters, cards played from hand,
  // fusion results and revivals alike. Scarcity comes from spending under the
  // active-only tap below, never from arriving broke: a Persona you just paid
  // a card for should be able to do something the turn it lands.
  //
  // SP regenerates in the ACTIVE SLOT ONLY: the bench neither gains nor loses.
  // That is what makes rotating a spent Persona out a real cost rather than a
  // free refill, and it is the only tap in the game.
  SP_REGEN_PER_TURN: 3,

  // Damage multipliers
  WEAK_MULT: 2,
  RESIST_MULT: 0.5,
  GUARD_MULT: 0.5,
  BUFF_MULT: 1.4, // debuffs divide by this
  CHARGE_MULT: 2.5, // Concentrate / Charge
  SHOCK_TAKEN_MULT: 1.5,
  // Technical: hitting an ailing target with the right follow-up type. Replaces
  // SHOCK_TAKEN_MULT when the Technical itself came from Shock, so the two
  // never stack — see resolveAttack.
  TECHNICAL_MULT: 1.5,

  // Basic attack (no cost, always available)
  BASIC_ATTACK_POWER: 30,

  // Execute: the deterministic replacement for the old instant-kill roll. The
  // Hama line hits a knocked-down target this much harder, the Mudo line one
  // already below EXECUTE_HP_THRESHOLD of its maximum HP. No skill in the game
  // has a random chance to knock a Persona out.
  EXECUTE_MULT: 1.5,
  EXECUTE_HP_THRESHOLD: 0.4,

  // Status ailments
  BURN_DAMAGE: 5,
  BURN_DURATION: 3,
  SHOCK_DURATION: 1, // expires at the end of the victim's next turn
  BUFF_DURATION: 3,

  // Levelling
  LEVEL_UP_GAP: 3, // victim level >= killer level + this  ->  +2 levels instead of +1

  // --- Gallows ----------------------------------------------------------
  // Feed one Persona to another. Three tiers, keyed off how the food's level
  // compares with the eater's — see gallowsMeal() in state.js, which is the
  // only place the comparison is made:
  //
  //   FEAST  food >= eater                      -> +2 levels
  //   MEAL   food within COMEBACK_FARM_GAP below -> +1 level
  //   JUNK   food further below than that        -> no levels, 20% HP, and it
  //                                                 does NOT cost your action
  //
  // Junk disposal being free is the point of the bottom tier: clearing a dead
  // level-3 card off a level-20 board is tempo housekeeping, not a play, and
  // charging a whole turn for it meant nobody ever did it. All three tiers
  // still share the one-per-turn cap, so it cannot become an engine.
  GALLOWS_PER_TURN: 1,
  GALLOWS_FEAST_LEVELS: 2, // food at or above the eater's own level
  GALLOWS_LEVELS: 1, // food within COMEBACK_FARM_GAP below it
  GALLOWS_LAMB_BONUS: 1, // Sacrificial Lamb adds this on top of either tier
  GALLOWS_JUNK_HEAL: 0.2, // fraction of max HP recovered when the food was too weak

  // --- Draw-level scaling ------------------------------------------------
  // From DRAW_SCALE_START the minimum printed level a Persona draw aims for
  // climbs by 1 every DRAW_SCALE_RATE turns, up to DRAW_SCALE_CAP. This is a
  // re-weighting, not a filter: a deck made entirely of level 3 Personas still
  // draws normally, it just no longer feels like turn 27 is turn 3.
  DRAW_SCALE_START: 8,
  DRAW_SCALE_RATE: 2,
  DRAW_SCALE_CAP: 20,
  DRAW_SCALE_PENALTY: 0.35, // how hard each level below the floor divides the weight

  // Deck out
  FATIGUE_DAMAGE: 5, // per stack, to all of that player's Personas, each of their turns

  // --- Passives ---------------------------------------------------------
  STALWART_HP_RATIO: 0.5, // Stalwart: cannot be knocked down above this HP fraction
  COUNTER_REFLECT: 0.25, // Counter: fraction of physical damage reflected
  BLOODLUST_MULT: 1.2, // Bloodlust: damage multiplier while behind on KOs
  SOUL_BATTERY_MULT: 2, // Soul Battery: SP regen multiplier
  SACRIFICIAL_LAMB_LEVELS: 2, // Sacrificial Lamb: levels added to the fusion result
  // Momentum: a skill at or under this cost draws a card, once per turn. Tied
  // to the light-skill tier on purpose — if the tier moves, move this with it.
  MOMENTUM_SP_THRESHOLD: 6,
  MOMENTUM_DRAW: 1,

  // Alacrity: a skill with this keyword refunds a Persona change when it knocks
  // the target down. Cheap, fast skills carry it; it is what lets a Swift board
  // hit, rotate and hit again inside one turn.
  ALACRITY_REFUND: 1,

  // --- Flavour-exclusive Specials --------------------------------------
  PHANTOM_STRIKE_MULT: 1.5, // P5: the armed weakness hit
  DARK_HOUR_MULT: 1.5, // P3: all damage, both sides
  DARK_HOUR_TURNS: 2, // ...for one full round
  SHUFFLE_TIME_LOOK: 3, // P4: how deep Shuffle Time reads

  // --- Draw manipulation -------------------------------------------------
  // Whims of Fate reads only the weaknesses you have UNCOVERED, unless you are
  // this far behind on the KO tally — at which point fate stops being subtle
  // and matches against the lot, revealed or not.
  WHIMS_DEFICIT: 2,
  PROVIDENCE_LOOK: 5, // how deep Providence reads before you throw any of it away

  // --- Comeback mechanics ----------------------------------------------
  // All keyed off the KO deficit: how many more of your own Personas have been
  // knocked out than the opponent's. Zero or negative means these are inert, so
  // the player who is ahead never benefits from any of them.
  COMEBACK_MOMENTUM_FACTOR: 0.25, // draw weight = 1 + deficit x this x normalisedQuality
  COMEBACK_UNDERDOG_DEFICIT: 3, // behind by this many KOs -> Underdog Draw
  COMEBACK_UNDERDOG_DRAW: 2, // ...draw this many per turn instead of DRAW_PER_TURN
  COMEBACK_FARM_GAP: 5, // a victim this many levels BELOW the killer teaches it nothing
});

export const MAGIC_TYPES = Object.freeze(['fire', 'ice', 'elec', 'wind', 'light', 'dark', 'almighty']);

/** Which stat a skill attacks with. */
export function skillCategory(type) {
  if (type === 'phys') return 'phys';
  if (MAGIC_TYPES.includes(type)) return 'magic';
  return 'support';
}
