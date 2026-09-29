/**
 * Telling the shop that an order has arrived, over Telegram.
 *
 * Telegram was chosen over Messenger for one reason: a Page may only message
 * somebody who wrote to it in the last 24 hours, and the message tags that
 * used to carry order updates past that window were withdrawn in April 2026.
 * An order can arrive at any hour, so Messenger cannot be relied on for this.
 * A Telegram bot can write to anyone who has ever pressed Start, for as long
 * as they leave it alone.
 *
 * Everything here is best-effort. A shop that cannot reach Telegram still
 * takes orders; the caller swallows what this throws.
 */

const API = 'https://api.telegram.org';

/** Telegram replies 200 with ok:false for its own errors, so both are checked. */
async function call(token, method, payload) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram said ${res.status}`);
  }
  return body.result;
}

const money = (n, currency) => `${currency} ${Number(n).toFixed(2)}`;

/**
 * What the shop reads on their phone. Kept to what someone glancing at a
 * notification needs: who, how much, how it is coming, and what to make.
 */
function orderMessage(order, sellerName) {
  const lines = [
    `🧺 *New order ${order.order_number}*`,
    sellerName ? `_${sellerName}_` : null,
    '',
    `*${money(order.total, order.currency)}* · ${order.fulfillment_type === 'delivery' ? 'Delivery' : 'Pickup'}`,
    `${order.contact_name} · ${order.contact_phone}`,
    '',
  ].filter((l) => l !== null);

  for (const item of order.items ?? []) {
    lines.push(`• ${item.quantity}× ${item.product_name}`);
    const opts = (item.options ?? []).map((o) => o.option_name).join(', ');
    if (opts) lines.push(`   _${opts}_`);
    if (item.notes) lines.push(`   ✏️ ${item.notes}`);
  }

  if (order.notes) lines.push('', `✏️ ${order.notes}`);
  if (order.delivery_address) lines.push('', `📍 ${order.delivery_address}`);

  return lines.join('\n');
}

export function createTelegram() {
  return {
    /** One message to one chat. Used by the test button. */
    send: (token, chatId, text) =>
      call(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }),

    /**
     * Everyone who should hear about an order, one message each.
     *
     * Sent in sequence rather than all at once: Telegram allows about one
     * message per second to a chat, and a shop has few enough staff that
     * waiting costs nothing.
     */
    async newOrder({ token, chatIds, order, sellerName }) {
      const text = orderMessage(order, sellerName);
      for (const chatId of chatIds) {
        try {
          await call(token, 'sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          });
        } catch {
          // One unreachable person must not stop the others being told.
        }
      }
    },

    /**
     * Who has written to the bot lately.
     *
     * getUpdates hands each update over once and then forgets it, so this is
     * deliberately read-only about state: it reports who it saw, and linking
     * them to an account is the caller's business.
     */
    async recentChats(token) {
      const updates = await call(token, 'getUpdates', { limit: 100, timeout: 0 });
      const seen = new Map();
      for (const u of updates ?? []) {
        const chat = u.message?.chat ?? u.edited_message?.chat;
        if (!chat) continue;
        seen.set(String(chat.id), {
          id: String(chat.id),
          name: [chat.first_name, chat.last_name].filter(Boolean).join(' ')
            || chat.title || chat.username || String(chat.id),
          username: chat.username ?? null,
        });
      }
      // Newest first: the person who just pressed Start is the one being linked.
      return [...seen.values()].reverse();
    },
  };
}
