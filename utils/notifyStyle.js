'use strict';

/**
 * Shared look for every Telegram notification the bot sends.
 *
 * Buttons are coloured with Telegram's native InlineKeyboardButton `style`
 * field: 'success' (green), 'primary' (blue) or 'danger' (red). The exact
 * shade comes from the user's Telegram client/theme. Set NOTIFY_BUTTON_STYLE
 * to 'primary' to make every notification button blue instead of green.
 *
 * Messages are sent with parse_mode HTML. Anything that came from a user or
 * the database (names, goal titles, chat text) MUST go through esc().
 */

const BUTTON_STYLE = ['success', 'primary', 'danger'].includes(process.env.NOTIFY_BUTTON_STYLE)
  ? process.env.NOTIFY_BUTTON_STYLE
  : 'success';

// Options to spread into safeSend / bot.sendMessage for a card.
const HTML = { parse_mode: 'HTML', disable_web_page_preview: true };

// Notifications are emoji-free. Static copy (titles, bodies, footers, labels)
// is stripped of emoji here, so no call site can bring one back. Text that a
// member wrote (quotes, field values) is left exactly as written.
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f\u20e3]/gu;
const plain = (s) => String(s ?? '').replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').trim();

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** Coloured button that opens the mini app at `url`. */
function goldButton(label, url) {
  return { text: label, web_app: { url }, style: BUTTON_STYLE };
}

/** Coloured button that fires a bot callback instead of opening the app. */
function goldCallback(label, data) {
  return { text: label, callback_data: data, style: BUTTON_STYLE };
}

/** inline_keyboard markup with a single coloured web-app button. */
function goldKeyboard(label, url) {
  return { inline_keyboard: [[goldButton(label, url)]] };
}

/**
 * Build a notification card.
 *
 *   <b>New Goal Assigned</b>
 *   Pastor Sam set a new goal for you
 *
 *   <blockquote>“Read Psalm 23”</blockquote>
 *
 *   <b>Due:</b> Oct 12
 *
 * Every text argument is plain text and is escaped here, so callers never
 * pre-escape. `fields` is [[icon, label, value], ...]; empty values are
 * skipped. `body` may be a string or an array of paragraphs.
 */
function card({ title, body = [], quote = '', fields = [], footer = '' }) {
  const out = [];
  out.push(`<b>${esc(plain(title))}</b>`);

  const paras = (Array.isArray(body) ? body : [body]).map(plain).filter(Boolean);
  if (paras.length) out.push('', paras.map(esc).join('\n\n'));
  if (quote) out.push('', `<blockquote>${esc(quote)}</blockquote>`);

  const rows = fields
    .filter(([, , v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([, label, v]) => `<b>${esc(plain(label))}:</b> ${esc(v)}`);
  if (rows.length) out.push('', rows.join('\n'));

  // `footer` is accepted for compatibility but intentionally not rendered:
  // cards have no divider line and no closing tagline.
  return out.join('\n');
}

module.exports = { plain, BUTTON_STYLE, HTML, esc, goldButton, goldCallback, goldKeyboard, card };
