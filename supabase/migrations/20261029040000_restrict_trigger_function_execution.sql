-- Restrict trigger-only functions from being called as public RPCs.
REVOKE EXECUTE ON FUNCTION public.confirm_booking_after_deposit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- This helper is used by authenticated RLS policies, but does not need anonymous access.
REVOKE EXECUTE ON FUNCTION public.owns_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owns_vehicle(uuid) TO authenticated;

-- Keep trigger reference generation independent of caller-controlled search_path.
ALTER FUNCTION public.generate_booking_reference() SET search_path TO '';
