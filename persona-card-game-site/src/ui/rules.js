/**
 * Rules summary + FAQ.
 *
 * Every number here is read from the engine config rather than typed out, so
 * retuning a constant updates the rules text instead of quietly contradicting
 * it. Rendered in Settings and from the in-match menu.
 */
import { CONFIG } from '../engine/index.js';
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
      [b(`Draw ${CONFIG.DRAW_PER_TURN}`), ' card, and every Persona you own regains ', b(`${CONFIG.SP_REGEN_PER_TURN} SP`), '.'],
      ['Play as many ', b('Persona'), ' cards as you like (field cap ', b(String(CONFIG.FIELD_CAP)), '), plus at most ', b(`${CONFIG.ITEMS_PER_TURN} Item`), ' and ', b(`${CONFIG.SPECIALS_PER_TURN} Special`), '. None of that costs your action.'],
      ['Change your active Persona ', b(`${CONFIG.PERSONA_CHANGES_PER_TURN} time`), ' (more with Baton Pass).'],
      ['Take your ', b('one action'), ': attack, use a skill, guard, fuse, or pass.'],
      ['End the turn, discarding down to ', b(`${CONFIG.HAND_LIMIT} cards`), ' if you are over.'],
    ])
  );

  wrap.appendChild(el('h3', 'rules__heading', 'Winning fights'));
  wrap.appendChild(
    bullets([
      ['Hit a ', b('weakness'), ` for ×${CONFIG.WEAK_MULT} damage. The target is knocked down and you get a `, b('One More'), ': an extra action and an extra Persona change, once per turn.'],
      [`A `, b('resist'), ` halves damage (×${CONFIG.RESIST_MULT}). `, b('Almighty'), ' can never be resisted or weak.'],
      [b('Guard'), ` halves incoming damage and prevents knockdown until your next turn.`],
      ['Buffs and debuffs shift damage by ', b(`×${CONFIG.BUFF_MULT}`), ` for ${CONFIG.BUFF_DURATION} turns. Concentrate and Charge multiply your next magic or physical skill by `, b(`×${CONFIG.CHARGE_MULT}`), '.'],
      [b('Burn'), ` deals ${CONFIG.BURN_DAMAGE} at the end of each of its owner's turns. `, b('Shock'), ' stops a Persona acting for a turn and raises the damage it takes by 50%.'],
    ])
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
          'There is no shop, no deck building and no between-match progression in the alpha: your 30-card deck plus your starting Persona is everything you get.',
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
          [b('No action left'), ' — you already attacked, guarded, fused or passed this turn.'],
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
          ' — from your field, your hand, or one of each — to summon a stronger one at its printed level. It inherits one skill of your choice from each parent, and it costs your ',
          b('action'),
          ' for the turn.',
        ])
      );
      body.appendChild(
        para([
          'Open the ',
          b('🌀 Fusion'),
          ` button any turn to see all ${FUSION_RECIPES.length} recipes. Ones you can perform are highlighted; the rest tell you exactly what they still need — the right Arcana, or a higher combined level. The button glows when at least one is ready.`,
        ])
      );
      body.appendChild(
        para(['Sacrificed Personas do ', b('not'), ' count toward your opponent\'s knockout tally, and if you sacrifice your active Persona the result takes its place.'])
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
          'Strike a weakness and you earn a ',
          b('One More'),
          ': the target is knocked down, and you immediately get one extra action plus one extra Persona change (the ',
          b('Baton Pass'),
          `). It can only happen ${CONFIG.MAX_ONE_MORE_PER_TURN} time per turn, so weakness chains cannot loop forever.`,
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
          '. There are no accounts, and no server is needed by default: the two browsers talk ',
          b('directly to each other'),
          ', and you connect by swapping a code over any chat you already use.',
        ])
      );
      body.appendChild(
        bullets([
          [b('One of you hosts'), ' — choose both decks, then send over the code you are given.'],
          [b('The other joins'), ' — enter that code.'],
          ['The match begins, and plays exactly like a local game.'],
        ])
      );
      body.appendChild(
        para([
          'By default the code ',
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
          'Keep both tabs open for the whole match: there is nowhere to save a game in progress, so closing a tab ends it. If the code is accepted but the connection never completes, one of you is probably behind a strict firewall or a mobile network — a direct browser-to-browser link cannot always get through. Fixing that needs a ',
          b('TURN relay'),
          ' that carries the traffic itself, which is a different and much heavier thing than the rendezvous server, and this project does not include one.',
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
