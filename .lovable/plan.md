# NEXUS Bot — Full Upgrade Plan

Goal: make `@BlacktowerNexus_bot` handle Inline Mode flawlessly, always reply with latest info, use rich Telegram formatting, expose functions via inline keyboard buttons, actually fire reminders, and remember the last 1000 messages per chat.

---

## 1. Inline Mode support
- Telegram now sends `inline_query` updates (since Inline Mode is ON in BotFather). Webhook currently ignores them → bot looks broken.
- Add `allowed_updates: ["message", "edited_message", "callback_query", "inline_query"]` and re-run `setWebhook`.
- In webhook handler, branch on update type:
  - `inline_query` → call NEXUS with the query text, return `answerInlineQuery` with 1–3 `InputTextMessageContent` results (HTML parse mode). Always include a fresh timestamp so Telegram doesn't serve stale cached answers (`cache_time: 0`, `is_personal: true`).
  - `callback_query` → handle inline-button taps (menu actions).
  - `message` / `edited_message` → existing chat flow.

## 2. Inline keyboard menu (function discovery)
- `/start`, `/help`, `/menu` now reply with an `inline_keyboard` of buttons:
  - 🧠 Memory · 🗑️ Clear Memory · ⏰ Reminders · ℹ️ About · 🔄 Refresh
- Each button uses `callback_data`; webhook routes the callback to the matching action and `answerCallbackQuery` + `editMessageText` to update in place.

## 3. Reminders that actually fire
Root cause today: agent only writes "remember X at 9pm" into `nexus_memory`, nothing schedules a send.

- New table `nexus_reminders(id, chat_id, user_id, remind_at timestamptz, message text, sent_at, created_at)` with RLS + service_role grants.
- Extend agent command grammar with `[CMD:SET_REMINDER|<ISO datetime in KL>|<message>]`. Parse → insert row. Confirm to user with formatted time.
- New public route `/api/public/hooks/nexus-reminders` (apikey-protected) that selects due rows (`remind_at <= now() AND sent_at IS NULL`), sends Telegram message via gateway, marks `sent_at`.
- Schedule via `pg_cron` every minute, calling that route with project anon key in `apikey` header.
- Add `/reminders` command + inline button to list upcoming.

## 4. Memory upgrade (1000 messages)
- History currently capped at 12. Raise rolling window to **last 1000 messages per chat** stored in `telegram_messages` (already persisting). To stay within model context:
  - Always pass the most recent 30 turns verbatim.
  - For older turns up to 1000, compute a running summary stored in `nexus_memory` under key `__chat_summary_<chat_id>` and refresh when window grows.
- Add `/recall <keyword>` and an inline "🔎 Recall" entry to search past messages via ILIKE.

## 5. Always-fresh information
- Inject current KL datetime into every system prompt (already there — keep).
- Add explicit rule: never claim cached/old data; if unsure, say so and suggest verification. For time-sensitive answers, append "as of <KL time>".
- For inline queries, force `cache_time: 0` so Telegram never serves a stale answer.
- For message replies, disable web preview only when not useful (`disable_web_page_preview: true` for normal text).

## 6. Telegram-safe rich formatting
Already enforced (HTML only, no markdown). Extend system prompt to encourage:
- `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<blockquote>`, `<a href>` (all Telegram-supported).
- Use blockquotes for memory recalls and reminder confirmations for visual hierarchy.
- Sanitize: strip any tag outside the supported set before send; auto-fallback to plain text on Telegram 400.

## 7. End-to-end verification
- Re-register webhook with new `allowed_updates`.
- Hit `/start` → expect inline keyboard.
- Send `/remind me in 1 min to test` → row inserted, cron fires within 60s, Telegram message arrives.
- Send inline query `@BlacktowerNexus_bot weather KL` from another chat → see answer card.
- Tap inline buttons → callback handled, message updates.
- Send 35 messages then ask "what did I say 30 messages ago" → summary + recall works.

---

## Technical sections

### Files to create
- `supabase/migrations/<ts>_nexus_reminders.sql` — table, grants, RLS, updated_at trigger.
- `src/routes/api/public/hooks/nexus-reminders.ts` — cron worker (apikey-auth, sends due reminders).
- `src/lib/telegram-api.server.ts` — extracted gateway client with `sendMessage`, `editMessageText`, `answerCallbackQuery`, `answerInlineQuery`, `sanitizeHtml`.

### Files to edit
- `src/routes/api/public/telegram/webhook.ts` — branch on `inline_query` / `callback_query` / `message`; build inline keyboards; route commands.
- `src/lib/nexus-agent.server.ts` — 1000-msg window with rolling summary, new `[CMD:SET_REMINDER|...]` parser, richer system prompt, `mode` arg (`chat` | `inline`).

### Cron (via supabase--insert, not migration)
```sql
select cron.schedule(
  'nexus-reminder-tick', '* * * * *',
  $$ select net.http_post(
    url:='https://project--6e4de065-781c-4d99-a774-c591afd9ef70-dev.lovable.app/api/public/hooks/nexus-reminders',
    headers:='{"Content-Type":"application/json","apikey":"<ANON>"}'::jsonb,
    body:='{}'::jsonb) $$);
```

### Webhook re-registration
Run from sandbox after deploy:
```
setWebhook { url: .../api/public/telegram/webhook,
  secret_token: <derived>,
  allowed_updates: ["message","edited_message","callback_query","inline_query"] }
```

Proceed with implementation?
