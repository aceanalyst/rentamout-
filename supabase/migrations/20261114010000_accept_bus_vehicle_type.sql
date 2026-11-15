-- Accept 'bus' as a valid vehicle type in the owner vehicle-type setter RPC.
-- The listing form now offers Bus, but public.set_my_vehicle_type still
-- rejects it with "Choose a valid vehicle type.", which also aborts the
-- rest of the listing save (rental type, rental plans, photos).
-- Keep the existing validation rules and all other function behavior unchanged.
DO $fix$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proname = 'set_my_vehicle_type';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'set_my_vehicle_type function not found';
  END IF;

  IF position('''bus''' in v_definition) > 0 THEN
    RAISE NOTICE 'set_my_vehicle_type already accepts bus; nothing to change';
    RETURN;
  END IF;

  v_updated := replace(v_definition, '''cargo_van''', '''cargo_van'',''bus''');

  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'Could not find the vehicle type list to extend in set_my_vehicle_type; inspect the function definition manually';
  END IF;

  EXECUTE v_updated;
END
$fix$;
