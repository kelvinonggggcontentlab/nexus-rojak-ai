import { generateText, type ModelMessage } from "ai";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

const KL_TZ = "Asia/Kuala_Lumpur";

function nowInKL(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: KL_TZ,
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());
}

async function readMemory(): Promise<Record<string, string>> {
  const { data, error } = await supabaseAdmin
    .from("nexus_memory")
    .select("key, value");
  if (error || !data) return {};
  const out: Record<string, string> = {};
  for (const row of data) out[row.key as string] = row.value as string;
  return out;
}

async function saveMemory(key: string, value: string): Promise<void> {
  await supabaseAdmin
    .from("nexus_memory")
    .upsert({ key, value }, { onConflict: "key" });
}

async function clearMemory(): Promise<void> {
  await supabaseAdmin.from("nexus_memory").delete().neq("key", "");
}

async function readHistory(chatId: number, limit = 12): Promise<ModelMessage[]> {
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

function buildSystemPrompt(memory: Record<string, string>): string {
  const memStr = Object.keys(memory).length ? JSON.stringify(memory) : "Empty";
  return `You are "𝗡𝗘𝗫𝗨𝗦 ʙʏ ʙʟᴀᴄᴋᴛᴏᴡᴇʀ", an elite Personal Assistant.
Boss: Kelvin.
Current time (Kuala Lumpur, Asia/Kuala_Lumpur): ${nowInKL()}.
All times, schedules, and reminders MUST be interpreted in Kuala Lumpur time unless Boss says otherwise.

1. TONE: Malaysian Rojak (English, Chinese, Malay slang). Chill but highly competent. Keep it short and sharp.

2. STRICT TELEGRAM HTML FORMATTING:
- Telegram ONLY supports: <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, <code>code</code>, <a href="">link</a>.
- FATAL: NEVER use <ul>, <li>, <ol>, <br>, <p>, <h1>, <h2>, <div>. Telegram will reject the message.
- For lists, use plain dashes: "- Item 1\\n- Item 2".
- Do not use markdown (** or *).
- Always escape stray < and > in code/output.

3. LONG-TERM MEMORY (persistent database):
- Current memory contents: ${memStr}
- If Boss tells you to "remember", "save", "remind me", or "note down" something, append a command at the VERY END of your reply exactly like:
  [CMD:SAVE_MEMORY|KeyName|ValueString]
  Example: "Okay boss, noted. [CMD:SAVE_MEMORY|Task_BuyMilk|Buy milk tonight]"
- If Boss asks to "clear memory" / "wipe database", append: [CMD:CLEAR_MEMORY]
- Otherwise, do NOT emit any [CMD:...] tag.

4. Be useful, be quick, no fluff. Steady la boss.`;
}

export interface NexusResult {
  reply: string;
}

export async function nexusChat(chatId: number, userText: string): Promise<NexusResult> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY not configured");

  const memory = await readMemory();
  const history = await readHistory(chatId);
  const gateway = createLovableAiGatewayProvider(key);

  const { text } = await generateText({
    model: gateway("openai/gpt-5"),
    system: buildSystemPrompt(memory),
    messages: [...history, { role: "user", content: userText }],
  });

  let reply = (text ?? "").replace(/\*\*/g, "").replace(/(?<!\w)\*(?!\w)/g, "");

  // Process memory commands
  const saveMatch = reply.match(/\[CMD:SAVE_MEMORY\|([^|\]]+)\|([^\]]+)\]/);
  if (saveMatch) {
    const k = saveMatch[1].trim();
    const v = saveMatch[2].trim();
    await saveMemory(k, v);
    reply = reply.replace(saveMatch[0], "").trim() +
      "\n\n<i>[💾 NEXUS Database updated]</i>";
  }

  if (reply.includes("[CMD:CLEAR_MEMORY]")) {
    await clearMemory();
    reply = reply.replace("[CMD:CLEAR_MEMORY]", "").trim() +
      "\n\n<i>[🗑️ NEXUS Database cleared]</i>";
  }

  return { reply: reply.trim() || "..." };
}
