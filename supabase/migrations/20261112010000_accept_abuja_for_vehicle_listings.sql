-- Accept Abuja (the FCT) in both owner listing create and edit RPC validators.
-- Keep the existing validation rules and all other function behavior unchanged.
DO $fix$
DECLARE
  v_definition text;
BEGIN
  FOR v_definition IN
    SELECT pg_get_functiondef(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname IN (
        'create_my_vehicle_listing_with_specs',
        'update_my_vehicle_listing_with_specs'
      )
  LOOP
    v_definition := replace(v_definition, '''FCT''', '''Abuja''');
    EXECUTE v_definition;
  END LOOP;
END
$fix$;
