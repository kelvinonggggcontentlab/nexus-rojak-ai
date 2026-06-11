import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { nexusChat } from "@/lib/nexus-agent.server";
import {
  answerCallbackQuery,
  answerInlineQuery,
  editMessageText,
  mainMenuKeyboard,
  sendMessage,
  sendTyping,
} from "@/lib/telegram-api.server";

function deriveWebhookSecret(telegramApiKey: string): string {
  return createHash("sha256").update(`telegram-webhook:${telegramApiKey}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface TgUser { id: number }
interface TgChat { id: number }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgInlineQuery {
  id: string;
  from: TgUser;
  query: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  inline_query?: TgInlineQuery;
}

function isAllowedUser(fromId: number | undefined): boolean {
  const bossId = process.env.BOSS_TELEGRAM_ID;
  if (!bossId || fromId == null) return false;
  return bossId.split(",").map((s) => s.trim()).filter(Boolean).includes(String(fromId));
}

const WELCOME_HTML = `<b>𝗡𝗘𝗫𝗨𝗦 ʙʏ ʙʟᴀᴄᴋᴛᴏᴡᴇʀ</b> — Online ✅

Boss, just type anything — I handle it.

<b>Quick Commands</b>
- <code>/menu</code> — show this menu
- <code>/memory</code> — list saved memory
- <code>/reminders</code> — upcoming reminders
- <code>/recall &lt;keyword&gt;</code> — search past chat
- <code>/clear</code> — wipe memory

<b>Inline Mode</b>
Type <code>@BlacktowerNexus_bot &lt;your question&gt;</code> in any chat to summon me.

<i>Tap a button below to begin.</i>`;

async function handleCommand(chatId: number, fromId: number | null, cmd: string, arg: string): Promise<string | null> {
  if (cmd === "/start" || cmd === "/help" || cmd === "/menu") {
    await sendMessage(chatId, WELCOME_HTML, { reply_markup: mainMenuKeyboard() });
    return null;
  }
  if (cmd === "/reminders") {
    const { data } = await supabaseAdmin
      .from("nexus_reminders")
      .select("remind_at, message")
      .eq("chat_id", chatId)
      .is("sent_at", null)
      .order("remind_at", { ascending: true })
      .limit(20);
    if (!data || data.length === 0) {
      await sendMessage(chatId, "<i>No active reminders boss. Steady kosong.</i>");
    } else {
      const lines = data.map((r) => {
        const t = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kuala_Lumpur",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(r.remind_at as string));
        return `- <b>${t}</b> — ${String(r.message).slice(0, 200)}`;
      }).join("\n");
      await sendMessage(chatId, `<b>⏰ Upcoming Reminders</b>\n${lines}`);
    }
    return null;
  }
  if (cmd === "/recall") {
    const q = arg.trim();
    if (!q) {
      await sendMessage(chatId, "<i>Usage:</i> <code>/recall &lt;keyword&gt;</code>");
      return null;
    }
    const { data } = await supabaseAdmin
      .from("telegram_messages")
      .select("text, created_at")
      .eq("chat_id", chatId)
      .ilike("text", `%${q.replace(/[%_]/g, "")}%`)
      .order("created_at", { ascending: false })
      .limit(10);
    if (!data || data.length === 0) {
      await sendMessage(chatId, `<i>No past message matching</i> <code>${q}</code>.`);
    } else {
      const lines = data.map((r) => {
        const t = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kuala_Lumpur",
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(r.created_at as string));
        const text = String(r.text ?? "").slice(0, 200).replace(/[<>&]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]!));
        return `<blockquote>[${t}] ${text}</blockquote>`;
      }).join("\n");
      await sendMessage(chatId, `<b>🔎 Recall: ${q}</b>\n${lines}`);
    }
    return null;
  }
  if (cmd === "/memory") {
    return "System: List every saved item from your memory database in a clean dash list. Nothing else.";
  }
  if (cmd === "/clear") {
    return "System: Boss wants to clear the memory database. Confirm chill and emit the [CMD:CLEAR_MEMORY] tag.";
  }
  return null;
}

async function processChatMessage(chatId: number, fromId: number | null, text: string, updateId: number, raw: TgUpdate) {
  // Commands
  if (text.startsWith("/")) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.split("@")[0].toLowerCase();
    const arg = rest.join(" ");
    const synthetic = await handleCommand(chatId, fromId, cmd, arg);

    if (synthetic === null) {
      // Direct response was already sent — just persist + bail
      await supabaseAdmin.from("telegram_messages").insert({
        update_id: updateId,
        chat_id: chatId,
        user_id: fromId,
        text,
        raw_update: raw as unknown as never,
      });
      return;
    }
    // Otherwise treat synthetic prompt as user input below
    text = synthetic;
  }

  if (!text) return;

  await sendTyping(chatId);
  let replyText = "<b>NEXUS:</b> Brain short-circuit lah, try again.";
  try {
    const result = await nexusChat(chatId, text, fromId, "chat");
    replyText = result.reply;
  } catch (err) {
    console.error("nexusChat error:", err);
  }
  await sendMessage(chatId, replyText);

  await supabaseAdmin.from("telegram_messages").insert({
    update_id: updateId,
    chat_id: chatId,
    user_id: fromId,
    text,
    raw_update: { ...raw, _nexus_reply: replyText } as unknown as never,
  });
}

async function handleCallback(cb: TgCallbackQuery) {
  if (!cb.message?.chat?.id || !cb.data) {
    await answerCallbackQuery(cb.id);
    return;
  }
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;

  if (!isAllowedUser(cb.from.id)) {
    await answerCallbackQuery(cb.id, "Access denied.");
    return;
  }

  await answerCallbackQuery(cb.id);

  switch (cb.data) {
    case "menu:refresh":
      await editMessageText(chatId, msgId, WELCOME_HTML, mainMenuKeyboard());
      return;
    case "menu:about":
      await editMessageText(
        chatId,
        msgId,
        `<b>About NEXUS</b>\n<i>Built by Blacktower for Boss Kelvin.</i>\n- Powered by Lovable AI\n- Memory + Reminders + Inline Mode\n- Time zone: <code>Asia/Kuala_Lumpur</code>`,
        mainMenuKeyboard(),
      );
      return;
    case "menu:memory": {
      const { data } = await supabaseAdmin
        .from("nexus_memory")
        .select("key, value")
        .not("key", "like", "__%")
        .order("updated_at", { ascending: false })
        .limit(50);
      const body = !data || data.length === 0
        ? "<i>Memory kosong boss.</i>"
        : data.map((r) => `- <b>${r.key}</b>: ${String(r.value).slice(0, 200)}`).join("\n");
      await editMessageText(chatId, msgId, `<b>🧠 NEXUS Memory</b>\n${body}`, mainMenuKeyboard());
      return;
    }
    case "menu:reminders": {
      const { data } = await supabaseAdmin
        .from("nexus_reminders")
        .select("remind_at, message")
        .eq("chat_id", chatId)
        .is("sent_at", null)
        .order("remind_at", { ascending: true })
        .limit(20);
      const body = !data || data.length === 0
        ? "<i>No active reminders.</i>"
        : data.map((r) => {
            const t = new Intl.DateTimeFormat("en-GB", {
              timeZone: "Asia/Kuala_Lumpur",
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(r.remind_at as string));
            return `- <b>${t}</b> — ${String(r.message).slice(0, 200)}`;
          }).join("\n");
      await editMessageText(chatId, msgId, `<b>⏰ Upcoming Reminders</b>\n${body}`, mainMenuKeyboard());
      return;
    }
    case "menu:clear":
      await supabaseAdmin.from("nexus_memory").delete().not("key", "like", "__%");
      await editMessageText(chatId, msgId, "<b>🗑️ Memory cleared.</b>", mainMenuKeyboard());
      return;
  }
}

async function handleInlineQuery(iq: TgInlineQuery) {
  if (!isAllowedUser(iq.from.id)) {
    await answerInlineQuery(iq.id, "<b>Access Denied.</b>", "Access Denied");
    return;
  }
  const q = (iq.query ?? "").trim();
  if (!q) {
    await answerInlineQuery(
      iq.id,
      `<b>NEXUS Inline</b>\nType your question after @BlacktowerNexus_bot to get an answer right here.`,
      "Ask NEXUS anything…",
    );
    return;
  }
  try {
    const result = await nexusChat(iq.from.id, q, iq.from.id, "inline");
    await answerInlineQuery(iq.id, result.reply, q.slice(0, 60));
  } catch (err) {
    console.error("inline nexusChat error:", err);
    await answerInlineQuery(iq.id, "<i>NEXUS brain short-circuit, try again.</i>", "Error");
  }
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const telegramKey = process.env.TELEGRAM_API_KEY;
        if (!telegramKey) return new Response("Server misconfigured", { status: 500 });

        const expected = deriveWebhookSecret(telegramKey);
        const actual = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(actual, expected)) return new Response("Unauthorized", { status: 401 });

        let update: TgUpdate;
        try {
          update = (await request.json()) as TgUpdate;
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }

        // Inline query
        if (update.inline_query) {
          await handleInlineQuery(update.inline_query);
          return Response.json({ ok: true });
        }

        // Callback (inline keyboard tap)
        if (update.callback_query) {
          await handleCallback(update.callback_query);
          return Response.json({ ok: true });
        }

        const message = update.message ?? update.edited_message;
        if (!message?.chat?.id || typeof update.update_id !== "number") {
          return Response.json({ ok: true, ignored: true });
        }

        // Idempotency
        const { data: existing } = await supabaseAdmin
          .from("telegram_messages")
          .select("update_id")
          .eq("update_id", update.update_id)
          .maybeSingle();
        if (existing) return Response.json({ ok: true, duplicate: true });

        const fromId = message.from?.id ?? null;
        if (!isAllowedUser(fromId ?? undefined)) {
          await sendMessage(message.chat.id, "<b>Access Denied.</b>");
          return Response.json({ ok: true, denied: true });
        }

        await processChatMessage(
          message.chat.id,
          fromId,
          message.text ?? "",
          update.update_id,
          update,
        );

        return Response.json({ ok: true });
      },
    },
  },
});
