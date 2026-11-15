-- Accept 'bus' in the vehicles table vehicle_type CHECK constraint.
-- The set_my_vehicle_type RPC already accepts 'bus' (see
-- 20261114010000_accept_bus_vehicle_type.sql), but the table-level
-- constraint "vehicles_vehicle_type_check" still rejects it, which also
-- aborts the rest of the listing save (rental type, rental plans, photos).
-- This rebuilds the existing constraint definition with 'bus' added right
-- after 'cargo_van', keeping every other allowed type and rule unchanged.
DO $fix$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'vehicles'
     AND c.conname = 'vehicles_vehicle_type_check';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'vehicles_vehicle_type_check constraint not found on public.vehicles';
  END IF;

  IF position('''bus''' in v_definition) > 0 THEN
    RAISE NOTICE 'vehicles_vehicle_type_check already allows bus; nothing to change';
    RETURN;
  END IF;

  v_updated := replace(v_definition, '''cargo_van''', '''cargo_van'',''bus''');

  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'Could not find the vehicle type list to extend in vehicles_vehicle_type_check; inspect the constraint definition manually';
  END IF;

  EXECUTE 'ALTER TABLE public.vehicles DROP CONSTRAINT vehicles_vehicle_type_check';
  EXECUTE 'ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_vehicle_type_check ' || v_updated;
END
$fix$;
