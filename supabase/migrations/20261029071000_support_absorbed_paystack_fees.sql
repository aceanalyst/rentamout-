create or replace function public.record_verified_full_booking_payment(
  p_booking_id uuid,
  p_renter_id uuid,
  p_payment_type text,
  p_payment_reference text,
  p_amount numeric,
  p_transaction_fee numeric,
  p_customer_paid_total numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_booking public.bookings%rowtype;
  v_existing public.booking_payments%rowtype;
begin
  if p_payment_type is distinct from 'full_payment' then
    raise exception 'Only full-payment checkout is accepted.';
  end if;

  if p_booking_id is null or p_renter_id is null
     or p_payment_reference is null or p_amount is null
     or p_transaction_fee is null or p_customer_paid_total is null
     or p_amount <= 0 or p_transaction_fee < 0
     or p_customer_paid_total <= 0 then
    raise exception 'Invalid verified payment amounts or details.';
  end if;

  if round(p_customer_paid_total, 2) <> round(p_amount, 2)
     and round(p_customer_paid_total, 2) <> round(p_amount + p_transaction_fee, 2) then
    raise exception 'Customer-paid total does not reconcile with the booking amount and Paystack fee.';
  end if;

  select b.* into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then raise exception 'Booking not found.'; end if;
  if v_booking.renter_id is distinct from p_renter_id then raise exception 'Booking renter does not match.'; end if;
  if v_booking.payment_reference is distinct from p_payment_reference then raise exception 'Payment reference does not match the booking.'; end if;

  select bp.* into v_existing from public.booking_payments bp where bp.payment_reference = p_payment_reference for update;
  if found then
    if v_existing.booking_id is distinct from p_booking_id
       or v_existing.renter_id is distinct from p_renter_id
       or v_existing.payment_type is distinct from 'full_payment'
       or round(v_existing.amount, 2) <> round(p_customer_paid_total, 2) then
      raise exception 'Payment reference conflicts with an existing payment record.';
    end if;
    if v_existing.status = 'paid' then
      if v_booking.payment_status <> 'paid'
         or v_booking.status <> 'confirmed'
         or v_booking.transaction_fee is distinct from round(p_transaction_fee, 2)
         or v_booking.customer_paid_total is distinct from round(p_customer_paid_total, 2) then
        raise exception 'Payment was recorded but booking totals need reconciliation.';
      end if;
      return jsonb_build_object('success', true, 'already_recorded', true, 'booking_id', p_booking_id, 'payment_type', 'full_payment', 'amount', v_existing.amount, 'base_amount', round(p_amount, 2), 'transaction_fee', round(p_transaction_fee, 2), 'customer_paid_total', round(p_customer_paid_total, 2));
    end if;
    raise exception 'A payment record already exists for this reference and needs review.';
  end if;

  if v_booking.base_checkout_amount is null or v_booking.base_checkout_amount <= 0 then raise exception 'The base checkout amount has not been saved.'; end if;
  if round(p_amount, 2) <> round(v_booking.base_checkout_amount, 2) then raise exception 'Verified base amount does not match the saved checkout amount.'; end if;
  if v_booking.status <> 'payment_pending' or v_booking.payment_status <> 'pending' then raise exception 'Booking is not eligible for full payment.'; end if;

  insert into public.booking_payments (booking_id, renter_id, payment_type, amount, currency, provider, payment_reference, status, verified_at)
  values (p_booking_id, p_renter_id, 'full_payment', round(p_customer_paid_total, 2), 'NGN', 'paystack', p_payment_reference, 'paid', now());

  update public.bookings
  set transaction_fee = round(p_transaction_fee, 2),
      customer_paid_total = round(p_customer_paid_total, 2),
      checkout_total = round(p_customer_paid_total, 2),
      payment_status = 'paid',
      status = 'confirmed'
  where id = p_booking_id;

  return jsonb_build_object('success', true, 'already_recorded', false, 'booking_id', p_booking_id, 'payment_type', 'full_payment', 'amount', round(p_customer_paid_total, 2), 'base_amount', round(p_amount, 2), 'transaction_fee', round(p_transaction_fee, 2), 'customer_paid_total', round(p_customer_paid_total, 2), 'status', 'confirmed', 'payment_status', 'paid');
end;
$function$;
