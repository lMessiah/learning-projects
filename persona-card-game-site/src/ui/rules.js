/**
 * Rules summary + FAQ.
 *
 * Every number here is read from the engine config rather than typed out, so
 * retuning a constant updates the rules text instead of quietly contradicting
 * it. Rendered in Settings and from the in-match menu.
 */
import { CONFIG, PASSIVE_LIST, momentumBonus } from '../engine/index.js';
import { FUSION_RECIPES } from '../data/cards.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A paragraph that can contain <strong> runs, given as an array of parts. */
function para(parts, className = 'rules__text') {
  const node = el('p', className);
  for (const part of parts) {
    if (typeof part === 'string') node.appendChild(document.createTextNode(part));
    else node.appendChild(el(part.tag || 'strong', part.className || null, part.text));
  }
  return node;
}

const b = (text) => ({ tag: 'strong', text });

function bullets(items) {
  const list = el('ul', 'rules__list');
  for (const item of items) {
    const li = el('li');
    for (const part of Array.isArray(item) ? item : [item]) {
      if (typeof part === 'string') li.appendChild(document.createTextNode(part));
      else li.appendChild(el(part.tag || 'strong', null, part.text));
    }
    list.appendChild(li);
  }
  return list;
}

/** One collapsible FAQ entry. */
function faq(question, build) {
  const entry = el('details', 'faq');
  entry.appendChild(el('summary', 'faq__q', question));
  const body = el('div', 'faq__a');
  build(body);
  entry.appendChild(body);
  return entry;
}

/* ------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------ */

function renderHowToPlay() {
  const wrap = el('div', 'rules-block');

  wrap.appendChild(el('h3', 'rules__heading', 'The goal'));
  wrap.appendChild(
    para([
      'Knock out ',
      b(`${CONFIG.KO_TARGET} of your opponent's Personas`),
      '. Whoever gets there first wins. Your own Personas are the resource you spend to do it, so keep bodies on the board.',
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Your turn, step by step'));
  wrap.appendChild(
    bullets([
      [b(`Draw ${CONFIG.DRAW_PER_TURN}`), ' card. Your ', b('active'), ' Persona regains ', b(`${CONFIG.SP_REGEN_PER_TURN} SP`), ' — the bench regains nothing, so a spent Persona stays spent until you fight with it again.'],
      ['Play as many ', b('Persona'), ' cards as you like (field cap ', b(String(CONFIG.FIELD_CAP)), '), plus at most ', b(`${CONFIG.ITEMS_PER_TURN} Item`), ' and ', b(`${CONFIG.SPECIALS_PER_TURN} Special`), '. None of that costs your action.'],
      ['Change your active Persona ', b(`${CONFIG.PERSONA_CHANGES_PER_TURN} time`), ' (more with Baton Pass).'],
      ['Take your ', b('one action'), ': attack, use a skill, guard, fuse, feed a Persona to the Gallows, or pass.'],
      ['End the turn, discarding down to ', b(`${CONFIG.HAND_LIMIT} cards`), ' if you are over.'],
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Winning fights'));
  wrap.appendChild(
    bullets([
      ['Hit a ', b('weakness'), ` for ×${CONFIG.WEAK_MULT} damage. If that knocks a `, b('standing'), ' Persona down you get a ', b('One More'), ': an extra action, an extra Persona change, and that action may hit ', b('any'), ' enemy Persona.'],
      [`A `, b('resist'), ` halves damage (×${CONFIG.RESIST_MULT}). `, b('Almighty'), ' can never be resisted or weak.'],
      [b('Guard'), ` halves incoming damage and prevents knockdown until your next turn.`],
      ['Buffs and debuffs shift damage by ', b(`×${CONFIG.BUFF_MULT}`), ` for ${CONFIG.BUFF_DURATION} turns. Concentrate and Charge multiply your next magic or physical skill by `, b(`×${CONFIG.CHARGE_MULT}`), '.'],
      [b('Burn'), ` deals ${CONFIG.BURN_DAMAGE} at the end of each of its owner's turns. `, b('Shock'), ' stops a Persona acting for a turn and raises the damage it takes by 50%.'],
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Keeping a board'));
  wrap.appendChild(
    para([
      'An empty field is a legal position and you are allowed to sit in it — holding Personas back as fusion or Gallows fodder, or waiting for your level cap to reach the one you actually want, is real strategy. Nothing will ever force a card out of your hand. But it is on a clock: you get ',
      b(`${CONFIG.EMPTY_FIELD_LOSS_TURNS} full turns`),
      ' starting with an empty field, and beginning one more after that ',
      b('loses the match'),
      ' — no knockouts required. Playing any Persona, by any route, resets the clock completely.',
    ])
  );
  wrap.appendChild(
    bullets([
      [
        'While the clock runs, every card you draw is a ',
        b('Persona'),
        ' for as long as your deck still holds one. That is the clock\'s only effect — it changes what you draw, never how much. If you lose to it, it is because your deck and hand genuinely had nothing, not because the shuffle looked elsewhere.',
      ],
      [
        'Being empty is ',
        b('not'),
        ' treated as falling behind. Underdog Draw and Momentum read the knockout tally and nothing else, so an empty board never pays you a comeback bonus.',
      ],
      [
        'The mirror of the rule: end your turn with ',
        b("your opponent's"),
        ' field empty and your next draw phase deals you ',
        b('one extra card'),
        '. Leaving your board bare does not just start your own clock — it feeds them.',
      ],
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Knockdown combo'));
  wrap.appendChild(
    para([
      'Every Persona you put on its back adds ',
      b(`+${Math.round(CONFIG.COMBO_DAMAGE_STEP * 100)}%`),
      ' damage to everything else you do for the ',
      b('rest of that turn'),
      '. The stacks reset when the turn ends, and the hit that scores a knockdown never boosts itself — the bonus is for what comes ',
      b('after'),
      '. It multiplies with a Technical rather than replacing it, so a One More chain that keeps finding weaknesses ramps hard, which is exactly what ',
      b('Trickster'),
      ' is for. It costs nothing extra: SP and HP prices are untouched.',
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Technicals'));
  wrap.appendChild(
    para([
      'Hit a Persona that is already suffering an ailment with the right kind of follow-up and you land a ',
      b('Technical'),
      ` for ×${CONFIG.TECHNICAL_MULT} damage. Nothing about it is a dice roll: both halves are on the board where you can see them.`,
    ])
  );
  wrap.appendChild(
    bullets([
      [b('Burn'), ' + a ', b('physical'), ' or ', b('wind'), ' skill — you fan the flames.'],
      [
        b('Shock'),
        ' + a ',
        b('physical'),
        ' skill — the blow lands through the current, and it ',
        b('knocks the target down'),
        ' as well. A standing Persona knocked down that way pays a One More like any other knockdown.',
      ],
      [
        'A Shock Technical ',
        b('replaces'),
        ' the ordinary +50% Shock damage rather than stacking on top of it — the two are the same idea.',
      ],
    ])
  );
  wrap.appendChild(
    para([
      'Ailments come from two places. Every ',
      b('Fire'),
      ' skill can inflict Burn and every ',
      b('Electric'),
      ' skill can inflict Shock — each one prints its own percentage on the card, and that percentage is the only randomness a skill carries. ',
      b('Lesser Theurgy'),
      ' is the exception: it inflicts Burn or Shock, your choice, with no roll at all. It is the one way to decide in advance that you are having a Technical.',
    ])
  );
  wrap.appendChild(
    para([
      'Timing matters, and the two ailments differ. ',
      b('Shock'),
      ' lasts until the end of its victim\'s next turn, so a Shock Technical has to be cashed in the ',
      b('same turn'),
      ' you apply it — which Lesser Theurgy allows, because it costs no action. ',
      b('Burn'),
      ` lasts ${CONFIG.BURN_DURATION} turns, so it is still there on your next turn, ticking for ${CONFIG.BURN_DAMAGE} while you wait.`,
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Finishing them off'));
  wrap.appendChild(
    para([
      'Nothing in this game has a random chance to knock a Persona out. The ',
      b('Hama'),
      ' and ',
      b('Mudo'),
      ' lines are ordinary Light and Dark damage skills that hit ',
      b(`+${Math.round((CONFIG.EXECUTE_MULT - 1) * 100)}%`),
      ' harder against a target already in trouble: Hama against one that is ',
      b('knocked down'),
      ', Mudo against one below ',
      b(`${Math.round(CONFIG.EXECUTE_HP_THRESHOLD * 100)}% HP`),
      '. Both conditions are readable before you commit the action.',
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Rewriting what a Persona is'));
  wrap.appendChild(
    para([
      'Each deck holds one Special that ',
      b('rewrites'),
      " a Persona's weaknesses and resists: ",
      b('Turn of the Moon'),
      ' (P3, your active), ',
      b("Jester's Trickery"),
      ' (P4, any one of yours), and ',
      b('Change of Heart'),
      ' (P5, both actives at once). The new chart is drawn at random, keeps the ',
      b('same number'),
      ' of weaknesses and resists, and can never make a Persona both weak and resistant to the same thing — so it changes what something is without making it stronger or weaker.',
    ])
  );
  wrap.appendChild(
    para([
      'Everything anyone had uncovered about that Persona is ',
      b('forgotten'),
      ' — including by the ',
      b('Brutal'),
      ' bot. Brutal cheats by reading the printed card, and a rewritten Persona is no longer described by its card, so it has to find the new weaknesses the same way you do. That is what the card is for: the database is finite and memorisable, and this is the answer to both memorising it and to being read like a book.',
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Traesto — the tactical retreat'));
  wrap.appendChild(
    para([
      b('Traesto'),
      ' — one per deck, and rare — pulls one of your field Personas back into your hand. It uses your action, and it is ',
      b('never a knockout'),
      ': your opponent\'s tally does not move.',
    ])
  );
  wrap.appendChild(
    bullets([
      [
        'It comes back as the ',
        b('same Persona'),
        ': its level, every skill it learned or inherited, its passive and its ',
        b('SP'),
        ' all survive. Retreating is not a way to refill a spent Persona.',
      ],
      [
        'What it loses is the fight it was in — ',
        b('ailments, buffs and debuffs'),
        ' are gone — and its ',
        b('HP is fully restored'),
        '. Pulling a Persona out from under a killing blow is exactly what it is for.',
      ],
      [
        'Putting it back down ',
        b('ignores the play-level ceiling'),
        '. The ceiling stops you dropping a card you have not earned; this one was standing on your field a moment ago.',
      ],
      [
        'If the Persona you pull back was your ',
        b('active'),
        ', one of your bench steps up for free — your choice, and it does not spend your Persona change.',
      ],
      [
        'Retreating your ',
        b('last'),
        ' Persona is legal. You will be on the empty-field clock, and you can answer it by putting the same Persona straight back down next turn.',
      ],
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Twist of Fate'));
  wrap.appendChild(
    para([
      'A rewrite scrambles a chart and hands you a new puzzle. ',
      b('Twist of Fate'),
      ' — one per deck, any flavour — makes a single precise edit instead: you ',
      b('name an element'),
      ", and it replaces ONE of the enemy active Persona's weaknesses. That is the answer to the worst position in the game, which is holding a hand full of fire against something that is weak to nothing you own.",
    ])
  );
  wrap.appendChild(
    bullets([
      [
        'You ',
        b('cannot'),
        ' name something the target ',
        b('resists'),
        '. A resist beats a weakness, so it would be a dead card — the resist is not stripped, the choice is simply not offered.',
      ],
      [
        'Your ',
        b('opponent'),
        ' decides which weakness is given up, not you. They shed one you had already ',
        b('uncovered'),
        ' before one you had not — losing a secret is worth less to them than losing the thing you are already hitting them with.',
      ],
      ['The new weakness is ', b('revealed to both players'), ' the moment it lands, and what they gave up stops being known.'],
      [b('Whims of Fate'), ' sees the new weakness immediately, so the two cards work together.'],
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Passives'));
  wrap.appendChild(
    para([
      'Some Persona cards print a single ',
      b('passive'),
      '. Passives are always on — there is never a button for one, and they never cost your action. A fusion can pass a parent\'s passive to its result ',
      b('instead of'),
      ' a skill.',
    ])
  );
  wrap.appendChild(
    bullets(PASSIVE_LIST.map((passive) => [b(passive.name), ' — ', passive.description]))
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Growing stronger'));
  wrap.appendChild(
    para([
      'A Persona that scores a knockout gains ',
      b('+1 level'),
      ' — or ',
      b('+2'),
      ` if the Persona it beat outranked it by ${CONFIG.LEVEL_UP_GAP} or more. Levels raise stats, unlock the skills printed on the card, and raise the level of card you are allowed to play.`,
    ])
  );
  wrap.appendChild(
    para([
      'Beating something far weaker teaches nothing: a knockout is worth ',
      b('no levels at all'),
      ` when the Persona you beat was ${CONFIG.COMEBACK_FARM_GAP} or more levels below yours. Fight upward.`,
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Fusion is free; the Gallows is not'));
  wrap.appendChild(
    para([
      b('Fusion'),
      ' costs you ',
      b('your action'),
      `, and you still get only ${CONFIG.FUSIONS_PER_TURN} fusion per turn on top of that. Fusing is the turn — you cannot fuse and attack. A One More refunds the action, so a weakness hit can buy you a fusion you had otherwise spent, but the ration still holds you to one.`,
    ])
  );
  wrap.appendChild(
    para([
      'Once a turn you may send one Persona from your field or hand to the ',
      b('Gallows'),
      ' to feed another Persona on your field. What you get back depends entirely on how the food compares with the eater — the panel previews the exact outcome, down to the stat and the skill, before you confirm it.',
    ])
  );
  wrap.appendChild(
    bullets([
      [
        b('Feast'),
        ' — food at or above the eater\'s own level: ',
        b(`+${CONFIG.GALLOWS_FEAST_LEVELS} levels`),
        ', one inherited skill ',
        b('or the food\'s passive'),
        ', and a permanent ',
        b(`+${CONFIG.GALLOWS_STAT_BUMP}`),
        ' to whichever combat stat the eater grows fastest. Costs your action.',
      ],
      [
        b('Meal'),
        ' — food up to ',
        b(`${CONFIG.COMEBACK_FARM_GAP} levels`),
        ' beneath it: ',
        b(`+${CONFIG.GALLOWS_LEVELS} level`),
        ' and one inherited skill of your choice. Costs your action.',
      ],
      [
        b('Junk'),
        ' — anything further beneath it teaches nothing at all: no levels and no skill, but it restores ',
        b(`${Math.round(CONFIG.GALLOWS_JUNK_HEAL * 100)}% HP`),
        ' and ',
        b('costs no action'),
        '. Clearing a card your board has long outgrown is housekeeping, not a play.',
      ],
    ])
  );
  wrap.appendChild(
    para([
      'The ',
      b('inherited skill'),
      ' works exactly as it does in fusion: pick one skill the food can currently cast (a card still in hand offers only what its printed level has unlocked) and the eater keeps it for the rest of the match. You may also take nothing.',
    ])
  );
  wrap.appendChild(el('h3', 'rules__heading', 'Moving a passive'));
  wrap.appendChild(
    para([
      b('Any'),
      ' passive in the game can be moved onto another Persona — Trickster, Stalwart, Counter, Analyst, Soul Battery, Bloodlust, Endure, Momentum and Sacrificial Lamb alike. There is no approved list. What limits it is that there are only ',
      b('two channels'),
      ', and both are expensive:',
    ])
  );
  wrap.appendChild(
    bullets([
      [
        b('Fusion'),
        ' — from each parent you take one skill ',
        b('or'),
        ' that parent\'s passive. The result can carry at most one passive either way.',
      ],
      [
        b('The Gallows, feast tier only'),
        ' — you may take the food\'s passive instead of one of its skills, and only when the food has grown to the eater\'s own level. A meal or a junk disposal never moves one.',
      ],
      [
        'A Persona carries ',
        b('one passive at most'),
        ', so inheriting one over an existing passive ',
        b('replaces'),
        ' it. That is a real loss, and both channels make you confirm it explicitly before it happens.',
      ],
    ])
  );
  wrap.appendChild(
    para([
      'Food that prints ',
      b('Sacrificial Lamb'),
      ` is worth +${CONFIG.GALLOWS_LAMB_BONUS} level on top of whichever tier it lands in, so a Lamb is always the best version of the meal it would otherwise have been. The two nourishing tiers and the free junk tier are rationed `,
      b('separately'),
      `: ${CONFIG.GALLOWS_PER_TURN} nourishing meal and ${CONFIG.GALLOWS_JUNK_PER_TURN} junk disposal per turn, so binning a dead card never costs you the feast you were saving your action for.`,
    ])
  );
  wrap.appendChild(
    para([
      'Like fusion material, a Persona you feed is ',
      b('not'),
      " a knockout — it never touches your opponent's tally. It is how a hand full of openers becomes something worth having in the late game.",
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Drains'));
  wrap.appendChild(
    bullets([
      [
        b('Life Drain'),
        ' — takes ',
        b('20% of the target\'s current HP'),
        ' and gives the user exactly that much back. It scales with what is in front of you, so it is at its best against a big healthy wall — and because it takes a share of what is ',
        b('left'),
        ', it can never itself land a knockout.',
      ],
      [
        b('Spirit Drain'),
        ' — deals no damage at all and moves up to ',
        b('6 SP'),
        ' from the enemy active to yours, for a 1 SP cast. The SP is taken whether or not you have room for it.',
      ],
      [
        'Both are ',
        b('Almighty'),
        ', so neither has any weakness, resist or Technical interaction. They are skills, not affinities — nothing in this game drains or repels an element.',
      ],
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Falling behind'));
  wrap.appendChild(
    para([
      'The game pushes back when you are losing, and only then. The help arrives in ',
      b('stages'),
      ", one knockout apart, so no single bad exchange switches the whole lot on. Counting by how many more of your Personas have been knocked out than your opponent's:",
    ])
  );
  wrap.appendChild(
    bullets([
      [
        b(`${CONFIG.MOMENTUM_MIN_DEFICIT} behind — Momentum Draw`),
        ' — your draws are weighted toward stronger cards. The weighting is ',
        b('front-loaded'),
        `: it is already at ${Math.round((momentumBonus(CONFIG.MOMENTUM_MIN_DEFICIT) / CONFIG.MOMENTUM_CAP) * 100)}% of its maximum the moment it switches on, and falling further behind adds almost nothing. Losing on purpose to farm it does not work.`,
      ],
      [
        b(`${CONFIG.COMEBACK_UNDERDOG_DEFICIT} behind — Underdog Draw`),
        ` — you draw ${CONFIG.COMEBACK_UNDERDOG_DRAW} cards a turn instead of ${CONFIG.DRAW_PER_TURN}.`,
      ],
      [
        b(`${CONFIG.WHIMS_DEFICIT} behind — Whims of Fate widens`),
        ' — the Special stops matching only the weaknesses you have uncovered and matches every weakness, revealed or not.',
      ],
      [
        b('Bloodlust'),
        ' — at any deficit. It is a printed passive you chose to run, not a handout, so it keeps its own schedule.',
      ],
    ])
  );
  wrap.appendChild(
    para([
      'Momentum only ever weights cards you could actually ',
      b('play'),
      ': a Persona above your current level ceiling counts as junk while it is stuck in your hand, so the help cannot fill your hand with Personas your board is too small to summon.',
    ])
  );

  return wrap;
}

function renderFaq() {
  const wrap = el('div', 'rules-block');

  wrap.appendChild(
    faq('Why can\'t I summon my Persona?', (body) => {
      body.appendChild(
        para([
          'Almost always the ',
          b('power curve'),
          '. A Persona card can only be played if its printed level is at most ',
          b(`the highest level on your field + ${CONFIG.PLAY_LEVEL_GAP}`),
          '. Your current ceiling is shown on the board as the ',
          b('“Play ≤ Lv N”'),
          ' chip, and an unplayable card in hand says ',
          b('“Needs Lv N board”'),
          ' on its face.',
        ])
      );
      body.appendChild(
        para([
          'So a fresh level 4 starter can play up to level ',
          b(String(4 + CONFIG.PLAY_LEVEL_GAP)),
          '. Score a few knockouts, your Personas level up, and the stronger cards unlock. The other two reasons are a ',
          b('full field'),
          ` (cap ${CONFIG.FIELD_CAP} living Personas) and simply not being your turn.`,
        ])
      );
    })
  );

  wrap.appendChild(
    faq('How do I get more cards?', (body) => {
      body.appendChild(
        bullets([
          ['You draw ', b(`${CONFIG.DRAW_PER_TURN} card`), ' at the start of each of your turns.'],
          [b('Passing'), ` your action draws ${CONFIG.PASS_DRAW} extra card — it is never a wasted turn.`],
          ['When your deck runs out, your discard pile is shuffled back into it, so you never stop drawing.'],
        ])
      );
      body.appendChild(
        para([
          'There is no shop, no deck building and no between-match progression in Patch 3: your 30-card deck plus your starting Persona is everything you get.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('How long does a match last?', (body) => {
      body.appendChild(
        para([
          'Until someone loses ',
          b(`${CONFIG.KO_TARGET} Personas`),
          '. Measured across 40 simulated matches, the median was about ',
          b('57 turns total'),
          ' — roughly 28 each — with a spread from 18 to 91. Expect ten to twenty minutes against the bot.',
        ])
      );
      body.appendChild(
        para([
          'Matches cannot stall forever: once a deck has been reshuffled, ',
          b('Fatigue'),
          ` deals ${CONFIG.FATIGUE_DAMAGE} damage per stack to all of that player's Personas every turn, and it stacks with each reshuffle.`,
        ])
      );
    })
  );

  wrap.appendChild(
    faq('Why can\'t I attack the Persona on their bench?', (body) => {
      body.appendChild(
        para([
          'Attacks and offensive skills can only target the opponent\'s ',
          b('active'),
          ' Persona. Two Specials change that: ',
          b('Ambush'),
          ' lets you target any single enemy Persona for the rest of the turn, and ',
          b('Armageddon'),
          ' hits every enemy Persona at once.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('Why won\'t my Persona act?', (body) => {
      body.appendChild(
        bullets([
          [b('Shocked'), ' — it cannot act at all this turn. Swap it out or pass.'],
          [b('Knocked down'), ' — it stands up automatically at the start of your next turn.'],
          [b('Not enough SP'), ' (or HP, for physical skills). Physical skills can never kill their own user, so a skill costing more HP than you have is refused.'],
          [b('No action left'), ' — you already attacked, guarded, fed the Gallows or passed this turn. (Fusion is free, so it is still available.)'],
        ])
      );
    })
  );

  wrap.appendChild(
    faq('What are the “?” marks on the enemy\'s Personas?', (body) => {
      body.appendChild(
        para([
          'Their weaknesses and resistances are ',
          b('hidden'),
          ' until you strike them with that damage type. Hit a Persona with fire once and its reaction to fire is public for the rest of the match. Your own Personas are always fully visible to you — and hidden from your opponent the same way.',
        ])
      );
      body.appendChild(para(['(The Brutal bot cheats and knows your weaknesses from turn one. That is the difficulty.)']));
    })
  );

  wrap.appendChild(
    faq('How does fusion work, and why is nothing available?', (body) => {
      body.appendChild(
        para([
          'Fusion sacrifices ',
          b('two of your Personas'),
          ' — from your field, your hand, or one of each — to summon a stronger one at its printed level. It inherits one skill of your choice from each parent, and it costs you ',
          b('your action'),
          `, rationed at ${CONFIG.FUSIONS_PER_TURN} per turn as well. Fusing is what you do with the turn, instead of attacking.`,
        ])
      );
      body.appendChild(
        para([
          'Open the ',
          b('🌀 Fusion'),
          ` button any turn to see all ${FUSION_RECIPES.length} recipes. Ones you can perform are highlighted; the rest tell you exactly what they still need — the right Arcana, a higher combined level, or a bigger board. The button glows when at least one is ready.`,
        ])
      );
      body.appendChild(
        para([
          'Two things gate it beyond the materials. Fusion is ',
          b(`shut until turn ${CONFIG.FUSION_FIRST_TURN}`),
          ' — the opening turns are for putting a board down. After that a fused Persona has to clear a ',
          b('power curve'),
          ' of its own: its level may be at most ',
          b(`the highest level on your field + ${CONFIG.FUSION_LEVEL_GAP}`),
          `. That reaches further than a card played from hand (which gets +${CONFIG.PLAY_LEVEL_GAP}), because fusion has already paid two Personas for the privilege. The ceiling is measured before the sacrifice, so the big Persona you feed in is the one that lets the result land — which is how the recipes climb a rung at a time rather than a level 3 board reaching straight for a level 64.`,
        ])
      );
      body.appendChild(
        para(['Sacrificed Personas do ', b('not'), ' count toward your opponent\'s knockout tally, and if you sacrifice your active Persona the result takes its place.'])
      );
    })
  );

  wrap.appendChild(
    faq('How do I actually land a Technical?', (body) => {
      body.appendChild(
        para([
          'Two halves, and you need both. First put an ',
          b('ailment'),
          ' on them, then hit them with the follow-up type: ',
          b('Burn'),
          ' pairs with physical or wind, ',
          b('Shock'),
          ' pairs with physical.',
        ])
      );
      body.appendChild(
        bullets([
          ['Every ', b('Fire'), ' skill can inflict Burn and every ', b('Electric'), ' skill can inflict Shock. The chance is printed on each card — Agi and Zio land it 40% of the time, the heavy tier 50%, the severe tier 70%.'],
          [b('Lesser Theurgy'), ' always lands, and lets you pick which. It costs no action, so you can play it and then immediately cash it in.'],
          ['The catch is that most Personas cannot do both halves themselves. If your fire caster has no physical or wind skill, you need a ', b('Persona change'), ' between the two — or a second body that does.'],
        ])
      );
      body.appendChild(
        para([
          'A ',
          b('Shock'),
          ' Technical also knocks the target down, which pays a One More like any other knockdown. That is the strongest thing in the system, and it is why Shock is worth setting up even though it expires faster.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('Their weaknesses changed. What happened?', (body) => {
      body.appendChild(
        para([
          'Somebody played a ',
          b('rewrite'),
          ' Special — Turn of the Moon, Jester\'s Trickery or Change of Heart, one per deck. It replaces a Persona\'s weaknesses and resists with a new set of the same size, and wipes everything either player had uncovered about it.',
        ])
      );
      body.appendChild(
        para([
          'A Persona this has happened to is marked ',
          b('REWRITTEN'),
          ' on its card and with a ',
          b('↻'),
          ' on the board. Its printed card is no longer true of it, so there is nothing to look up — you have to probe it again.',
        ])
      );
      body.appendChild(
        para([
          'This is deliberately also the counter to the ',
          b('Brutal'),
          ' bot, which otherwise knows every weakness you have from turn one. Brutal reads the ',
          b('card'),
          ', and a rewritten Persona is not its card any more — so rewriting the Persona it has just built its whole plan around is a real, repeatable answer to the difficulty rather than a coin flip.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('Does fusion cost my turn?', (body) => {
      body.appendChild(
        para([
          'Yes. Fusion takes ',
          b('your one action'),
          `, so you fuse or you attack — not both — and you cannot fuse once the action is gone. It is also rationed at ${CONFIG.FUSIONS_PER_TURN} per turn, which matters because a One More hands the action back: the refund lets you fuse after a weakness hit, but never twice.`,
        ])
      );
      body.appendChild(
        para([
          'It is also available when your active Persona cannot act — shocked, knocked down, wrapped in a Moonless Gown. Fusing is something ',
          b('you'),
          ' do, not something the Persona in the slot does.',
        ])
      );
      body.appendChild(
        para([
          'The ',
          b('Gallows'),
          ' mostly does cost your action — but not always. See below.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('When does the Gallows cost me my action?', (body) => {
      body.appendChild(
        para([
          'It depends entirely on what you feed it, and the panel tells you which of the three tiers a meal falls into before you confirm it:',
        ])
      );
      body.appendChild(
        bullets([
          [
            b('Feast'),
            " — food at or above the eater's own level. ",
            b(`+${CONFIG.GALLOWS_FEAST_LEVELS} levels`),
            ', one skill of your choice, a permanent ',
            b(`+${CONFIG.GALLOWS_STAT_BUMP}`),
            ' to its best combat stat, and it costs your action.',
          ],
          [
            b('Meal'),
            ' — food up to ',
            b(`${CONFIG.COMEBACK_FARM_GAP} levels`),
            ' beneath it. ',
            b(`+${CONFIG.GALLOWS_LEVELS} level`),
            ', one skill of your choice, and it costs your action.',
          ],
          [
            b('Junk'),
            ' — anything further beneath it. No levels and no skill, ',
            b(`${Math.round(CONFIG.GALLOWS_JUNK_HEAL * 100)}% HP`),
            ', and it costs ',
            b('nothing'),
            '. You can bin a card your board has outgrown and still attack in the same turn.',
          ],
        ])
      );
      body.appendChild(
        para([
          'The two paid tiers and the free one are rationed separately — ',
          b(`${CONFIG.GALLOWS_PER_TURN} nourishing meal`),
          ' and ',
          b(`${CONFIG.GALLOWS_JUNK_PER_TURN} junk disposal`),
          ' per turn — so housekeeping never costs you the feast. Neither is an engine: the paid tiers are rationed by the action they spend, and junk needs food far beneath its eater.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('My deck cannot hit anything they are weak to. What now?', (body) => {
      body.appendChild(
        para([
          'That is what ',
          b('Twist of Fate'),
          ' is for — one per deck, in every flavour. Name an element and it replaces one of the enemy active\'s weaknesses with that element, revealed to both of you.',
        ])
      );
      body.appendChild(
        para([
          'Two rules make it a trade rather than a free win. You cannot name something they ',
          b('resist'),
          ' — that option is simply not offered. And ',
          b('they'),
          ' choose which weakness they give up for it: they will shed one you had already uncovered before one you had not, so you may well be trading a weakness you knew about for one you can actually hit.',
        ])
      );
      body.appendChild(
        para([
          'Failing that, ',
          b('Whims of Fate'),
          ' fetches a Persona that answers what you can already see, and it reads the twisted chart too.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('Why can\'t I play a second Item or Special?', (body) => {
      body.appendChild(
        para([
          `You may play at most `,
          b(`${CONFIG.ITEMS_PER_TURN} Item`),
          ' and ',
          b(`${CONFIG.SPECIALS_PER_TURN} Special`),
          ' per turn. They are counted separately, so one of each in the same turn is fine. The remaining allowance is shown on the board as the ',
          b('Item'),
          ' and ',
          b('Special'),
          ' chips.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('What is One More, and what is Baton Pass?', (body) => {
      body.appendChild(
        para([
          'Knock a ',
          b('standing'),
          ' enemy Persona down by striking its weakness and you earn a ',
          b('One More'),
          ': one extra action, one extra Persona change (the ',
          b('Baton Pass'),
          '), and the right to aim that action at ',
          b('any'),
          ' enemy Persona — bench included. It is the one exception to active-only targeting.',
        ])
      );
      body.appendChild(
        bullets([
          ['Hitting a Persona that is ', b('already down'), ' grants nothing. Neither does a guarded hit.'],
          [
            'A ',
            b('killing blow'),
            ' does grant one. The target was standing, you found its weakness, and it went down — that it also died is a separate matter, and you get the level-up as well.',
          ],
          [
            `Baseline is ${CONFIG.MAX_ONE_MORE_PER_TURN} per turn. `,
            'The ',
            b('Trickster'),
            ' passive lifts that cap, so knockdowns scored during a One More keep the chain alive.',
          ],
          ['Downed Personas — bench ones too — stand back up at the start of their owner\'s turn.'],
        ])
      );
    })
  );

  wrap.appendChild(
    faq('How do I play against someone online?', (body) => {
      body.appendChild(
        para([
          'Main menu → ',
          b('🌐 Online Match'),
          '. There are no accounts. How you connect depends on whether a ',
          b('relay server'),
          ' is running: with one you send a link, without one the two browsers talk ',
          b('directly to each other'),
          ' and you swap a code over any chat you already use.',
        ])
      );
      body.appendChild(
        bullets([
          [b('One of you hosts'), ' — choose both decks, then send over the link or code you are given.'],
          [b('The other joins'), ' — open that link, or enter the code.'],
          ['The match begins, and plays exactly like a local game.'],
        ])
      );
      body.appendChild(
        para([
          'A ',
          b('match link'),
          ' looks like yoursite/#/join/ABC234 and is the whole handshake: opening it drops your opponent straight into the match, with nothing to paste back. It needs the bundled relay to be running (',
          { tag: 'code', text: 'npm run relay' },
          '), which forwards messages between the two of you and stores no game data. When no relay can be reached the game falls back to the direct handshake below, so online play never depends on one.',
        ])
      );
      body.appendChild(
        para([
          'In that fallback the code ',
          b('is'),
          ' the connection details, which is why it is a long block of text — a WebRTC handshake carries a security fingerprint and network addresses, and roughly 90 characters of it are irreducible. For a ',
          b('six-character code'),
          ' like ABC234 instead, point Settings → Online match codes at a rendezvous server; the bundled one runs with ',
          { tag: 'code', text: 'node server/rendezvous.js' },
          '. It holds the connection details under that code for ten minutes and nothing else — no game data goes through it, and the two browsers still talk directly.',
        ])
      );
      body.appendChild(
        para([
          'The host\'s machine runs the rules, and each side is only ever sent what it is allowed to know — ',
          b('you cannot read your opponent\'s hand'),
          ', their deck order, or the shuffle. Because the host is also a player, treat this as protection for a friendly game rather than tournament security.',
        ])
      );
      body.appendChild(
        para([
          'Keep both tabs open for the whole match: there is nowhere to save a game in progress, so closing a tab ends it. If a direct connection is accepted but never completes, one of you is probably behind a strict firewall or a mobile network — a browser-to-browser link cannot always get through. Fixing that for the peer-to-peer path needs a ',
          b('TURN relay'),
          ' that carries the traffic itself, which is a different and much heavier thing than the rendezvous server, and this project does not include one. The match-link relay above sidesteps the problem entirely, since every message already goes through it.',
        ])
      );
    })
  );

  wrap.appendChild(
    faq('What happens if we both hit zero at the same moment?', (body) => {
      body.appendChild(
        para([
          `If both players reach ${CONFIG.KO_TARGET} knockouts simultaneously, the win goes to whoever has more total HP left across their surviving Personas. If that is tied too, it is `,
          b('sudden death'),
          ': the next knockout decides it.',
        ])
      );
    })
  );

  return wrap;
}

/**
 * The whole rules document. Used by the Settings section and the in-match
 * modal, so both always say the same thing.
 */
export function renderRulesContent() {
  const wrap = el('div', 'rules');
  wrap.appendChild(renderHowToPlay());
  wrap.appendChild(el('h3', 'rules__heading rules__heading--faq', 'Frequently asked'));
  wrap.appendChild(renderFaq());
  return wrap;
}
