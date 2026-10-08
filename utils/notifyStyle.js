'use strict';

/**
 * Shared look for every Telegram notification the bot sends.
 *
 * Telegram does not let a bot pick a hex colour for an inline button (the
 * button tint comes from the user's chat theme), so the "golden" button is
 * built the only way the platform allows: a gold glyph on both sides of the
 * label. Change GOLD_ICON (or set NOTIFY_GOLD_ICON) to restyle all of them.
 *
 * Messages are sent with parse_mode HTML. Anything that came from a user or
 * the database (names, goal titles, chat text) MUST go through esc().
 */

const GOLD_ICON = process.env.NOTIFY_GOLD_ICON || '🌟';
const DIVIDER = '━━━━━━━━━━━━━━';

// Options to spread into safeSend / bot.sendMessage for a card.
const HTML = { parse_mode: 'HTML', disable_web_page_preview: true };

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** Gold-styled button that opens the mini app at `url`. */
function goldButton(label, url) {
  return { text: `${GOLD_ICON} ${label} ${GOLD_ICON}`, web_app: { url } };
}

/** Gold-styled button that fires a bot callback instead of opening the app. */
function goldCallback(label, data) {
  return { text: `${GOLD_ICON} ${label} ${GOLD_ICON}`, callback_data: data };
}

/** inline_keyboard markup with a single gold web-app button. */
function goldKeyboard(label, url) {
  return { inline_keyboard: [[goldButton(label, url)]] };
}

/**
 * Build a notification card.
 *
 *   🎯 <b>New Goal Assigned</b>
 *   ━━━━━━━━━━━━━━
 *   Pastor Sam set a new goal for you
 *
 *   <blockquote>“Read Psalm 23”</blockquote>
 *
 *   📅 <b>Due:</b> Oct 12
 *
 *   <i>You've got this 🙏</i>
 *
 * Every text argument is plain text and is escaped here, so callers never
 * pre-escape. `fields` is [[icon, label, value], ...]; empty values are
 * skipped. `body` may be a string or an array of paragraphs.
 */
function card({ icon = '', title, body = [], quote = '', fields = [], footer = '' }) {
  const out = [];
  out.push(`${icon ? `${icon} ` : ''}<b>${esc(title)}</b>`);
  out.push(DIVIDER);

  const paras = (Array.isArray(body) ? body : [body]).filter(Boolean);
  if (paras.length) out.push('', paras.map(esc).join('\n\n'));
  if (quote) out.push('', `<blockquote>${esc(quote)}</blockquote>`);

  const rows = fields
    .filter(([, , v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([i, label, v]) => `${i} <b>${esc(label)}:</b> ${esc(v)}`);
  if (rows.length) out.push('', rows.join('\n'));

  if (footer) out.push('', `<i>${esc(footer)}</i>`);
  return out.join('\n');
}

module.exports = { GOLD_ICON, DIVIDER, HTML, esc, goldButton, goldCallback, goldKeyboard, card };
