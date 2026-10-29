-- Harden booking and payment write permissions.
-- Reservation creation remains available through the validated RPC, which runs
-- as its owner and uses a fully qualified search path.
ALTER FUNCTION public.create_rental_booking(uuid, date, date) SECURITY DEFINER;
ALTER FUNCTION public.create_rental_booking(uuid, date, date) SET search_path TO '';

REVOKE INSERT ON TABLE public.bookings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.booking_payments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.booking_refunds FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_rental_booking(uuid, date, date) TO authenticated;
