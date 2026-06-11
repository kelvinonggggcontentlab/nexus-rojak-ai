// Telegram Bot API client via Lovable connector gateway.
const GATEWAY = "https://connector-gateway.lovable.dev/telegram";

function authHeaders(): HeadersInit {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const telegramKey = process.env.TELEGRAM_API_KEY;
  if (!lovableKey || !telegramKey) {
    throw new Error("Missing LOVABLE_API_KEY or TELEGRAM_API_KEY");
  }
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": telegramKey,
    "Content-Type": "application/json",
  };
}

export async function tgCall(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`${GATEWAY}/${method}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[Telegram] ${method} ${res.status}: ${body}`);
  }
  return res;
}

// Telegram supports only these HTML tags. Strip everything else.
// Supported: b, strong, i, em, u, ins, s, strike, del, code, pre, a, blockquote, tg-spoiler, span (with class tg-spoiler).
const ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "code", "pre", "a", "blockquote", "tg-spoiler",
]);

export function sanitizeTelegramHtml(input: string): string {
  if (!input) return "";
  // Drop markdown emphasis the model sometimes emits
  let s = input.replace(/\*\*/g, "").replace(/(?<!\w)\*(?!\w)/g, "");
  // Replace <br> with newlines
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Remove unsupported tags (keep their inner text). Allow href on <a>.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g, (full, tag: string, attrs: string = "") => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return "";
    if (t === "a") {
      const href = /href\s*=\s*"([^"]+)"/i.exec(attrs || "")?.[1];
      if (full.startsWith("</")) return "</a>";
      return href ? `<a href="${href.replace(/"/g, "&quot;")}">` : "<a>";
    }
    return full.startsWith("</") ? `</${t}>` : `<${t}>`;
  });
  return s.trim();
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  switch_inline_query_current_chat?: string;
}

export function inlineKeyboard(rows: InlineButton[][]) {
  return { inline_keyboard: rows };
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { reply_markup?: unknown; disable_web_page_preview?: boolean } = {},
) {
  const safe = sanitizeTelegramHtml(text);
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: safe,
    parse_mode: "HTML",
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
  };
  if (opts.reply_markup) payload.reply_markup = opts.reply_markup;
  const res = await tgCall("sendMessage", payload);
  if (!res.ok) {
    // Fallback: plain text
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: safe.replace(/<[^>]+>/g, ""),
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    });
  }
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  reply_markup?: unknown,
) {
  const safe = sanitizeTelegramHtml(text);
  await tgCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: safe,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {}),
  });
}

export async function sendTyping(chatId: number) {
  await tgCall("sendChatAction", { chat_id: chatId, action: "typing" });
}

export async function answerCallbackQuery(id: string, text?: string) {
  await tgCall("answerCallbackQuery", { callback_query_id: id, text: text ?? "" });
}

export async function answerInlineQuery(
  inlineQueryId: string,
  resultText: string,
  title: string,
) {
  const safe = sanitizeTelegramHtml(resultText);
  await tgCall("answerInlineQuery", {
    inline_query_id: inlineQueryId,
    cache_time: 0,
    is_personal: true,
    results: [
      {
        type: "article",
        id: `${Date.now()}`,
        title,
        description: safe.replace(/<[^>]+>/g, "").slice(0, 120),
        input_message_content: {
          message_text: safe,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        },
      },
    ],
  });
}

export function mainMenuKeyboard() {
  return inlineKeyboard([
    [
      { text: "🧠 Memory", callback_data: "menu:memory" },
      { text: "⏰ Reminders", callback_data: "menu:reminders" },
    ],
    [
      { text: "🔎 Recall", switch_inline_query_current_chat: "" },
      { text: "ℹ️ About", callback_data: "menu:about" },
    ],
    [
      { text: "🗑️ Clear Memory", callback_data: "menu:clear" },
      { text: "🔄 Refresh Menu", callback_data: "menu:refresh" },
    ],
  ]);
}
