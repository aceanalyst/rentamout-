CREATE OR REPLACE FUNCTION public.record_verified_full_booking_payment(p_booking_id uuid, p_renter_id uuid, p_payment_type text, p_payment_reference text, p_amount numeric, p_transaction_fee numeric, p_customer_paid_total numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_existing public.booking_payments%ROWTYPE;
BEGIN
  IF p_payment_type IS DISTINCT FROM 'full_payment' THEN
    RAISE EXCEPTION 'Only full-payment checkout is accepted.';
  END IF;
  IF p_booking_id IS NULL OR p_renter_id IS NULL OR p_payment_reference IS NULL OR p_amount IS NULL OR p_transaction_fee IS NULL OR p_customer_paid_total IS NULL OR p_amount <= 0 OR p_transaction_fee < 0 OR p_customer_paid_total <= 0 THEN
    RAISE EXCEPTION 'Invalid verified payment amounts or details.';
  END IF;
  IF ROUND(p_customer_paid_total, 2) <> ROUND(p_amount + p_transaction_fee, 2) THEN
    RAISE EXCEPTION 'Customer-paid total does not reconcile with base amount and Paystack fee.';
  END IF;
  SELECT b.* INTO v_booking FROM public.bookings b WHERE b.id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.'; END IF;
  IF v_booking.renter_id IS DISTINCT FROM p_renter_id THEN RAISE EXCEPTION 'Booking renter does not match.'; END IF;
  IF v_booking.payment_reference IS DISTINCT FROM p_payment_reference THEN RAISE EXCEPTION 'Payment reference does not match the booking.'; END IF;
  SELECT bp.* INTO v_existing FROM public.booking_payments bp WHERE bp.payment_reference = p_payment_reference FOR UPDATE;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM p_booking_id OR v_existing.renter_id IS DISTINCT FROM p_renter_id OR v_existing.payment_type IS DISTINCT FROM 'full_payment' OR ROUND(v_existing.amount, 2) <> ROUND(p_customer_paid_total, 2) THEN
      RAISE EXCEPTION 'Payment reference conflicts with an existing payment record.';
    END IF;
    IF v_existing.status = 'paid' THEN
      IF v_booking.payment_status <> 'paid' OR v_booking.status <> 'confirmed' OR v_booking.transaction_fee IS DISTINCT FROM ROUND(p_transaction_fee, 2) OR v_booking.customer_paid_total IS DISTINCT FROM ROUND(p_customer_paid_total, 2) THEN
        RAISE EXCEPTION 'Payment was recorded but booking totals need reconciliation.';
      END IF;
      RETURN jsonb_build_object('success', true, 'already_recorded', true, 'booking_id', p_booking_id, 'payment_type', 'full_payment', 'amount', v_existing.amount, 'base_amount', ROUND(p_amount, 2), 'transaction_fee', ROUND(p_transaction_fee, 2), 'customer_paid_total', ROUND(p_customer_paid_total, 2));
    END IF;
    RAISE EXCEPTION 'A payment record already exists for this reference and needs review.';
  END IF;
  IF v_booking.base_checkout_amount IS NULL OR v_booking.base_checkout_amount <= 0 THEN RAISE EXCEPTION 'The base checkout amount has not been saved.'; END IF;
  IF ROUND(p_amount, 2) <> ROUND(v_booking.base_checkout_amount, 2) THEN RAISE EXCEPTION 'Verified base amount does not match the saved checkout amount.'; END IF;
  IF v_booking.status <> 'payment_pending' OR v_booking.payment_status <> 'pending' THEN RAISE EXCEPTION 'Booking is not eligible for full payment.'; END IF;
  INSERT INTO public.booking_payments (booking_id, renter_id, payment_type, amount, currency, provider, payment_reference, status, verified_at)
  VALUES (p_booking_id, p_renter_id, 'full_payment', ROUND(p_customer_paid_total, 2), 'NGN', 'paystack', p_payment_reference, 'paid', now());
  UPDATE public.bookings SET transaction_fee = ROUND(p_transaction_fee, 2), customer_paid_total = ROUND(p_customer_paid_total, 2), checkout_total = ROUND(p_customer_paid_total, 2), payment_status = 'paid', status = 'confirmed' WHERE id = p_booking_id;
  RETURN jsonb_build_object('success', true, 'already_recorded', false, 'booking_id', p_booking_id, 'payment_type', 'full_payment', 'amount', ROUND(p_customer_paid_total, 2), 'base_amount', ROUND(p_amount, 2), 'transaction_fee', ROUND(p_transaction_fee, 2), 'customer_paid_total', ROUND(p_customer_paid_total, 2), 'status', 'confirmed', 'payment_status', 'paid');
END;
$function$;
