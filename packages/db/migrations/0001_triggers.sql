-- Database-level rules. App code never writes events.booked_seats or events.version.
--
-- Custom SQLSTATE used below: BK001 = invalid booking status transition.

-- 1. events: bump version and updated_at when content changes (not when booked_seats changes).
CREATE FUNCTION events_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.title, NEW.description, NEW.city, NEW.venue, NEW.starts_at, NEW.capacity)
     IS DISTINCT FROM
     (OLD.title, OLD.description, OLD.city, OLD.venue, OLD.starts_at, OLD.capacity) THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER events_bump_version
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION events_bump_version();--> statement-breakpoint

-- 2. events: every new version is recorded for the worker, whatever way it was changed (api, raw SQL).
CREATE FUNCTION events_enqueue_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO outbox (event_id, event_version)
  VALUES (NEW.id, NEW.version)
  ON CONFLICT (event_id, event_version) DO NOTHING;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE TRIGGER events_enqueue_outbox
  AFTER UPDATE ON events
  FOR EACH ROW
  WHEN (OLD.version IS DISTINCT FROM NEW.version)
  EXECUTE FUNCTION events_enqueue_outbox();--> statement-breakpoint

-- 3. bookings: only legal status moves; owner and event never change.
CREATE FUNCTION bookings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id <> OLD.event_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'booking event and owner cannot change' USING ERRCODE = 'BK001';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'held' AND NEW.status IN ('confirmed', 'cancelled', 'expired'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'invalid booking status change: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'BK001';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER bookings_guard
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_guard();--> statement-breakpoint

-- 4. bookings -> events.booked_seats. Seats are taken while a booking is held or confirmed.
-- The UPDATE takes a lock on this one event row only, so bookings for other events never wait.
-- If it would exceed capacity, the CHECK on events fails (23514) and the whole statement rolls back.
CREATE FUNCTION bookings_sync_seats() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_seats integer := 0;
  new_seats integer := 0;
  target_event integer;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status IN ('held', 'confirmed') THEN
    old_seats := OLD.quantity;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status IN ('held', 'confirmed') THEN
    new_seats := NEW.quantity;
  END IF;

  IF new_seats <> old_seats THEN
    IF TG_OP = 'DELETE' THEN
      target_event := OLD.event_id;
    ELSE
      target_event := NEW.event_id;
    END IF;
    UPDATE events SET booked_seats = booked_seats + (new_seats - old_seats) WHERE id = target_event;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE TRIGGER bookings_sync_seats
  AFTER INSERT OR UPDATE OR DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_sync_seats();
