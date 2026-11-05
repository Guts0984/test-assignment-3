ALTER TABLE "outbox" ADD COLUMN "request_id" text;--> statement-breakpoint

-- The api sets `app.request_id` for the current transaction (set_config(..., true)) before it edits an
-- event; the trigger stores it with the outbox row. Edits made any other way simply have no request id.
CREATE OR REPLACE FUNCTION events_enqueue_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO outbox (event_id, event_version, request_id)
  VALUES (NEW.id, NEW.version, NULLIF(current_setting('app.request_id', true), ''))
  ON CONFLICT (event_id, event_version) DO NOTHING;
  RETURN NULL;
END
$$;
