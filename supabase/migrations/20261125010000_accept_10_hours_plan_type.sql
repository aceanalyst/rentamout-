-- Accept '10_hours' in the vehicle_rental_plans table plan_type CHECK constraint.
-- The listing form now offers a 10 Hours plan (added 2026-11-25), but the
-- table-level constraint "vehicle_rental_plans_plan_type_check" still rejects
-- it, which aborts the rental-plan save on any listing that uses the plan.
-- This rebuilds the existing constraint definition with '10_hours' added right
-- after '12_hours', keeping every other allowed type and rule unchanged.
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
     AND t.relname = 'vehicle_rental_plans'
     AND c.conname = 'vehicle_rental_plans_plan_type_check';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'vehicle_rental_plans_plan_type_check constraint not found on public.vehicle_rental_plans';
  END IF;

  IF position('''10_hours''' in v_definition) > 0 THEN
    RAISE NOTICE 'vehicle_rental_plans_plan_type_check already allows 10_hours; nothing to change';
    RETURN;
  END IF;

  v_updated := replace(v_definition, '''12_hours''', '''12_hours'',''10_hours''');

  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'Could not find the plan type list to extend in vehicle_rental_plans_plan_type_check; inspect the constraint definition manually';
  END IF;

  EXECUTE 'ALTER TABLE public.vehicle_rental_plans DROP CONSTRAINT vehicle_rental_plans_plan_type_check';
  EXECUTE 'ALTER TABLE public.vehicle_rental_plans ADD CONSTRAINT vehicle_rental_plans_plan_type_check ' || v_updated;
END
$fix$;
