-- 004: Atomic DRX-code counter allocation.
--
-- services/inventory/src/routes/items.ts calls
-- rpc('increment_code_counter', ...) on every check-in to allocate the
-- per-(item type, location) counter used in the DRX unit code. This function
-- was referenced by the code since migration 002 but never created, so
-- production has been running on the client-side fallback path.
--
-- Single-statement upsert: first allocation for a (type, location) inserts
-- the row and returns 1; subsequent calls increment atomically under row
-- locking and return the pre-increment value. Safe under any number of
-- concurrent check-ins — no two callers can receive the same counter.
--
-- Apply with a role that owns the tables (e.g. via the Supabase SQL editor).

CREATE OR REPLACE FUNCTION public.increment_code_counter(
  p_type_id uuid,
  p_location_code text
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO code_counters (item_type_id, location_code, next_value)
  VALUES (p_type_id, p_location_code, 2)
  ON CONFLICT (item_type_id, location_code)
  DO UPDATE SET next_value = code_counters.next_value + 1
  RETURNING next_value - 1;
$$;

-- PostgREST exposes functions to the service role; keep anon/authenticated out.
REVOKE ALL ON FUNCTION public.increment_code_counter(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_code_counter(uuid, text) TO service_role;
