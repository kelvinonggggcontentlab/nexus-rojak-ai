import { generateText, type ModelMessage } from "ai";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

const KL_TZ = "Asia/Kuala_Lumpur";
const RECENT_TURNS = 30;       // verbatim window passed to model
const SUMMARY_WINDOW = 1000;   // total messages tracked per chat

function nowInKL(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: KL_TZ,
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());
}

function summaryKey(chatId: number) {
  return `__chat_summary_${chatId}`;
}

async function readMemory(): Promise<Record<string, string>> {
  const { data } = await supabaseAdmin
    .from("nexus_memory")
    .select("key, value");
  if (!data) return {};
  const out: Record<string, string> = {};
  for (const row of data) {
    const k = row.key as string;
    if (k.startsWith("__")) continue; // hide internal keys from prompt
    out[k] = row.value as string;
  }
  return out;
}

async function getRawMemory(key: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("nexus_memory")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (data?.value as string | undefined) ?? null;
}

async function saveMemory(key: string, value: string): Promise<void> {
  await supabaseAdmin.from("nexus_memory").upsert({ key, value }, { onConflict: "key" });
}

async function clearMemory(): Promise<void> {
  // Wipe user-visible keys; preserve internal summaries unless explicitly asked
  await supabaseAdmin.from("nexus_memory").delete().not("key", "like", "__%");
}

async function readHistory(chatId: number, limit = RECENT_TURNS): Promise<ModelMessage[]> {
  const { data } = await supabaseAdmin
    .from("telegram_messages")
    .select("text, raw_update, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!data) return [];

  const msgs: ModelMessage[] = [];
  for (const row of [...data].reverse()) {
    const raw = row.raw_update as { _nexus_reply?: string } | null;
    if (row.text) msgs.push({ role: "user", content: row.text as string });
    if (raw?._nexus_reply) msgs.push({ role: "assistant", content: raw._nexus_reply });
  }
  return msgs;
}

async function maybeRefreshSummary(chatId: number, gateway: ReturnType<typeof createLovableAiGatewayProvider>) {
  // Pull total message count
  const { count } = await supabaseAdmin
    .from("telegram_messages")
    .select("update_id", { count: "exact", head: true })
    .eq("chat_id", chatId);
  if (!count || count < RECENT_TURNS + 5) return;

  // Pull older messages beyond the recent window, up to SUMMARY_WINDOW total
  const { data } = await supabaseAdmin
    .from("telegram_messages")
    .select("text, raw_update, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .range(RECENT_TURNS, SUMMARY_WINDOW - 1);
  if (!data || data.length === 0) return;

  // Only re-summarize occasionally (every 10 new messages) to save credits
  if (count % 10 !== 0) return;

  const lines: string[] = [];
  for (const row of [...data].reverse()) {
    const raw = row.raw_update as { _nexus_reply?: string } | null;
    if (row.text) lines.push(`User: ${row.text}`);
    if (raw?._nexus_reply) lines.push(`Nexus: ${String(raw._nexus_reply).replace(/<[^>]+>/g, "").slice(0, 280)}`);
  }

  try {
    const { text } = await generateText({
      model: gateway("google/gemini-2.5-flash"),
      system: "Summarize this Telegram chat history into terse bullet points capturing facts, preferences, tasks, names, dates. Keep under 1500 chars. Plain text only.",
      messages: [{ role: "user", content: lines.join("\n").slice(0, 60000) }],
    });
    if (text) await saveMemory(summaryKey(chatId), text.slice(0, 4000));
  } catch (err) {
    console.error("summary refresh failed:", err);
  }
}

function buildSystemPrompt(memory: Record<string, string>, summary: string | null, mode: "chat" | "inline"): string {
  const memStr = Object.keys(memory).length ? JSON.stringify(memory) : "Empty";
  const sum = summary ? `\nLONG-TERM CHAT SUMMARY (older context, up to 1000 prior messages):\n${summary}\n` : "";
  const inlineNote = mode === "inline"
    ? "\n\nINLINE MODE: Your reply will be sent as an inline-query result. Keep it under 4000 chars, self-contained, no follow-up questions."
    : "";

  return `You are "𝗡𝗘𝗫𝗨𝗦 ʙʏ ʙʟᴀᴄᴋᴛᴏᴡᴇʀ", an elite Personal Assistant on Telegram.
Boss: Kelvin.
Current time (Kuala Lumpur, Asia/Kuala_Lumpur): ${nowInKL()}.
All times, schedules, and reminders MUST be interpreted in Kuala Lumpur time (UTC+8) unless Boss explicitly says otherwise.

1. FRESHNESS RULES (CRITICAL):
- Never serve stale or cached info. If a fact may have changed (news, prices, weather, scores), explicitly say "as of ${nowInKL()}" and recommend verifying.
- If you genuinely do not know something current, say so plainly. Do NOT fabricate.

2. TONE: Malaysian Rojak (English + Manglish + a sprinkle of Chinese/Malay slang). Chill, sharp, useful. No fluff.

3. TELEGRAM HTML FORMATTING (STRICTLY follow):
- Allowed tags ONLY: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <blockquote>, <tg-spoiler>.
- FATAL — never use: <ul>, <li>, <ol>, <br>, <p>, <h1>-<h6>, <div>, <span>, markdown (** or *).
- Lists = plain dashes on new lines: "- item\\n- item".
- Use <b> for titles, <i> for emphasis, <code> for IDs/values, <blockquote> for quoted recall, <a href> for links.
- Escape stray < and > in code blocks.

4. LONG-TERM MEMORY (persistent database):
- Saved memory: ${memStr}${sum}
- To remember something, append at the END of your reply EXACTLY: [CMD:SAVE_MEMORY|KeyName|ValueString]
- To wipe user memory: [CMD:CLEAR_MEMORY]
- To set a real reminder (will actually notify Boss at that time): [CMD:SET_REMINDER|YYYY-MM-DDTHH:mm|Message text]
  * Time MUST be in Asia/Kuala_Lumpur local time, ISO format (e.g. 2026-06-12T21:30).
  * Resolve natural language ("in 10 mins", "tomorrow 9am", "next Monday") into that exact ISO timestamp using the current KL time above.
  * Always confirm to Boss in the reply (e.g., "Set lor boss, I ping you at 9:30pm tonight.").
- Only emit CMDs when relevant. Never expose CMD syntax to Boss in prose.${inlineNote}

5. Be useful, be quick, no fluff. Steady la boss.`;
}

export interface NexusResult {
  reply: string;
}

export async function nexusChat(
  chatId: number,
  userText: string,
  fromUserId: number | null,
  mode: "chat" | "inline" = "chat",
): Promise<NexusResult> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY not configured");

  const gateway = createLovableAiGatewayProvider(key);
  const [memory, summary, history] = await Promise.all([
    readMemory(),
    getRawMemory(summaryKey(chatId)),
    readHistory(chatId, RECENT_TURNS),
  ]);

  const { text } = await generateText({
    model: gateway("google/gemini-2.5-pro"),
    system: buildSystemPrompt(memory, summary, mode),
    messages: [...history, { role: "user", content: userText }],
  });

  let reply = (text ?? "").trim();

  // SAVE_MEMORY
  const saveMatch = reply.match(/\[CMD:SAVE_MEMORY\|([^|\]]+)\|([^\]]+)\]/);
  if (saveMatch) {
    const k = saveMatch[1].trim();
    const v = saveMatch[2].trim();
    await saveMemory(k, v);
    reply = reply.replace(saveMatch[0], "").trim() + "\n\n<i>💾 Saved to NEXUS memory.</i>";
  }

  // CLEAR_MEMORY
  if (reply.includes("[CMD:CLEAR_MEMORY]")) {
    await clearMemory();
    reply = reply.replace("[CMD:CLEAR_MEMORY]", "").trim() + "\n\n<i>🗑️ NEXUS memory cleared.</i>";
  }

  // SET_REMINDER
  const remindMatch = reply.match(/\[CMD:SET_REMINDER\|([^|\]]+)\|([^\]]+)\]/);
  if (remindMatch) {
    const isoLocal = remindMatch[1].trim();
    const msg = remindMatch[2].trim();
    const parsed = parseKLLocalToUTC(isoLocal);
    if (parsed && parsed.getTime() > Date.now() - 30_000) {
      await supabaseAdmin.from("nexus_reminders").insert({
        chat_id: chatId,
        user_id: fromUserId,
        remind_at: parsed.toISOString(),
        message: msg,
      });
      reply = reply.replace(remindMatch[0], "").trim() +
        `\n\n<blockquote>⏰ Reminder locked in for <b>${formatKL(parsed)}</b>:\n${msg}</blockquote>`;
    } else {
      reply = reply.replace(remindMatch[0], "").trim() +
        "\n\n<i>⚠️ Reminder time invalid, cuba again with a real future time.</i>";
    }
  }

  // Fire-and-forget summary maintenance
  maybeRefreshSummary(chatId, gateway).catch(() => {});

  return { reply: reply.trim() || "..." };
}

function parseKLLocalToUTC(isoLocal: string): Date | null {
  // Accept "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD HH:mm" (treated as Asia/Kuala_Lumpur = UTC+8)
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(isoLocal.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // KL is UTC+8 with no DST
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +(s ?? "0"));
  const date = new Date(utcMs);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatKL(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: KL_TZ,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}
