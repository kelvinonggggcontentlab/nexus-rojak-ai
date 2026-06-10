import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { nexusChat } from "@/lib/nexus-agent.server";

const TELEGRAM_GATEWAY = "https://connector-gateway.lovable.dev/telegram";

function deriveWebhookSecret(telegramApiKey: string): string {
  return createHash("sha256")
    .update(`telegram-webhook:${telegramApiKey}`)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function sendTelegram(method: string, payload: Record<string, unknown>) {
  const lovableKey = process.env.LOVABLE_API_KEY!;
  const telegramKey = process.env.TELEGRAM_API_KEY!;
  const res = await fetch(`${TELEGRAM_GATEWAY}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": telegramKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Telegram ${method} failed [${res.status}]: ${body}`);
  }
  return res;
}

async function sendMessage(chatId: number, text: string, parseMode: "HTML" | null = "HTML") {
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  const res = await sendTelegram("sendMessage", payload);
  if (!res.ok && parseMode === "HTML") {
    // fallback: send plain text if HTML failed
    await sendTelegram("sendMessage", { chat_id: chatId, text });
  }
}

async function sendTyping(chatId: number) {
  await sendTelegram("sendChatAction", { chat_id: chatId, action: "typing" });
}

interface TgUser {
  id: number;
}
interface TgChat {
  id: number;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const telegramKey = process.env.TELEGRAM_API_KEY;
        if (!telegramKey) {
          return new Response("Server misconfigured", { status: 500 });
        }

        const expected = deriveWebhookSecret(telegramKey);
        const actual = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(actual, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let update: TgUpdate;
        try {
          update = (await request.json()) as TgUpdate;
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }

        const message = update.message ?? update.edited_message;
        if (!message?.chat?.id || typeof update.update_id !== "number") {
          return Response.json({ ok: true, ignored: true });
        }

        const chatId = message.chat.id;
        const fromId = message.from?.id;
        const text = message.text ?? "";

        // Idempotency: skip if already processed
        const { data: existing } = await supabaseAdmin
          .from("telegram_messages")
          .select("update_id")
          .eq("update_id", update.update_id)
          .maybeSingle();
        if (existing) return Response.json({ ok: true, duplicate: true });

        // Access control
        const bossId = process.env.BOSS_TELEGRAM_ID;
        if (bossId && String(fromId) !== String(bossId)) {
          await sendMessage(chatId, "<b>Access Denied.</b>");
          return Response.json({ ok: true, denied: true });
        }

        // Commands
        if (text === "/start" || text === "/help" || text === "/menu") {
          await sendMessage(
            chatId,
            `<b>𝗡𝗘𝗫𝗨𝗦 ʙʏ ʙʟᴀᴄᴋᴛᴏᴡᴇʀ Online</b>\n\nSteady boss! Just type anything and I will handle it.\n\n<i>Commands:</i>\n- /memory — show saved memory\n- /clear — wipe memory\n- /start — this menu`
          );
          await supabaseAdmin.from("telegram_messages").insert({
            update_id: update.update_id,
            chat_id: chatId,
            user_id: fromId ?? null,
            text,
            raw_update: update as unknown as Record<string, unknown>,
          });
          return Response.json({ ok: true });
        }

        let userPrompt = text;
        if (text === "/memory") {
          userPrompt = "System: List every saved item from your memory database in a clean dash list for Boss.";
        } else if (text === "/clear") {
          userPrompt = "System: Boss wants to clear the memory database. Confirm and emit the clear command.";
        }

        if (!userPrompt) {
          return Response.json({ ok: true, ignored: true });
        }

        await sendTyping(chatId);

        let replyText = "<b>NEXUS:</b> Brain short-circuit lah, try again.";
        try {
          const result = await nexusChat(chatId, userPrompt);
          replyText = result.reply;
        } catch (err) {
          console.error("nexusChat error:", err);
          const msg = err instanceof Error ? err.message : String(err);
          replyText = `<b>NEXUS Warning:</b> ${msg.slice(0, 300)}`;
        }

        await sendMessage(chatId, replyText);

        // Persist (store reply inside raw_update for history)
        await supabaseAdmin.from("telegram_messages").insert({
          update_id: update.update_id,
          chat_id: chatId,
          user_id: fromId ?? null,
          text,
          raw_update: { ...update, _nexus_reply: replyText } as unknown as Record<string, unknown>,
        });

        return Response.json({ ok: true });
      },
    },
  },
});
