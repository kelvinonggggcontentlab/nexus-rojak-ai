CREATE TABLE public.nexus_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL,
  user_id bigint,
  remind_at timestamptz NOT NULL,
  message text NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.nexus_reminders TO service_role;

ALTER TABLE public.nexus_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access nexus_reminders"
  ON public.nexus_reminders FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX idx_nexus_reminders_due ON public.nexus_reminders (remind_at) WHERE sent_at IS NULL;
CREATE INDEX idx_nexus_reminders_chat ON public.nexus_reminders (chat_id, created_at DESC);

CREATE TRIGGER trg_nexus_reminders_updated_at
  BEFORE UPDATE ON public.nexus_reminders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat_created
  ON public.telegram_messages (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_text_search
  ON public.telegram_messages USING gin (to_tsvector('simple', coalesce(text, '')));