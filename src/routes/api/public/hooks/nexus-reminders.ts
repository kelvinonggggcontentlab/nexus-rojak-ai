import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendMessage } from "@/lib/telegram-api.server";

// Called by pg_cron every minute with `apikey: <anon>` header.
export const Route = createFileRoute("/api/public/hooks/nexus-reminders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("apikey") ?? "";
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        if (!apiKey || !expected || apiKey !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { data, error } = await supabaseAdmin
          .from("nexus_reminders")
          .select("id, chat_id, message, remind_at")
          .is("sent_at", null)
          .lte("remind_at", new Date().toISOString())
          .order("remind_at", { ascending: true })
          .limit(50);
        if (error) {
          console.error("[reminders] fetch error", error);
          return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
        if (!data || data.length === 0) {
          return Response.json({ ok: true, sent: 0 });
        }

        let sent = 0;
        for (const r of data) {
          try {
            const t = new Intl.DateTimeFormat("en-GB", {
              timeZone: "Asia/Kuala_Lumpur",
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(r.remind_at as string));
            await sendMessage(
              Number(r.chat_id),
              `<b>⏰ NEXUS Reminder</b>\n<i>Scheduled for ${t}</i>\n\n<blockquote>${String(r.message)}</blockquote>`,
            );
            await supabaseAdmin
              .from("nexus_reminders")
              .update({ sent_at: new Date().toISOString() })
              .eq("id", r.id as string);
            sent++;
          } catch (err) {
            console.error("[reminders] send failed", r.id, err);
          }
        }

        return Response.json({ ok: true, sent });
      },
    },
  },
});
