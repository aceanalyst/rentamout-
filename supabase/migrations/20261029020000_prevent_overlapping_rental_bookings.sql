-- Prevent overlapping reservations and serialize booking attempts per vehicle.
CREATE OR REPLACE FUNCTION public.create_rental_booking(p_vehicle_id uuid, p_pickup_date date, p_return_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid;
  v_daily_price numeric;
  v_security_deposit numeric;
  v_total numeric;
  v_owner_share numeric;
  v_platform_share numeric;
  v_booking_id uuid;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must sign in to reserve a car.';
  END IF;

  IF p_vehicle_id IS NULL
     OR p_pickup_date IS NULL
     OR p_return_date IS NULL
     OR p_pickup_date < current_date
     OR p_return_date <= p_pickup_date THEN
    RAISE EXCEPTION 'Please provide valid rental dates.';
  END IF;

  -- Lock the vehicle row so concurrent booking attempts for this vehicle
  -- serialize. A waiting request will see the prior request's committed booking.
  SELECT v.daily_price, v.security_deposit
  INTO v_daily_price, v_security_deposit
  FROM public.vehicles v
  WHERE v.id = p_vehicle_id
    AND v.status = 'published'
    AND v.verified = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This vehicle is not available for reservation.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.vehicle_availability a
    WHERE a.vehicle_id = p_vehicle_id
      AND a.start_date < p_return_date
      AND a.end_date > p_pickup_date
      AND a.status IN ('blocked', 'booked')
  ) THEN
    RAISE EXCEPTION 'These dates are blocked for this vehicle.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.vehicle_id = p_vehicle_id
      AND b.pickup_date < p_return_date
      AND b.return_date > p_pickup_date
      AND b.status IN ('payment_pending', 'confirmed')
  ) THEN
    RAISE EXCEPTION 'These dates have already been reserved. Please choose different dates.';
  END IF;

  v_total := ROUND(
    v_daily_price * (p_return_date - p_pickup_date),
    2
  );

  v_owner_share := ROUND(v_total * 0.85, 2);
  v_platform_share := v_total - v_owner_share;

  INSERT INTO public.bookings (
    vehicle_id,
    renter_id,
    pickup_date,
    return_date,
    daily_price,
    total_amount,
    security_deposit_amount,
    owner_share,
    platform_share,
    status,
    payment_status
  )
  VALUES (
    p_vehicle_id,
    v_user_id,
    p_pickup_date,
    p_return_date,
    v_daily_price,
    v_total,
    v_security_deposit,
    v_owner_share,
    v_platform_share,
    'payment_pending',
    'pending'
  )
  RETURNING id INTO v_booking_id;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'daily_price', v_daily_price,
    'total_amount', v_total,
    'security_deposit', v_security_deposit,
    'owner_share', v_owner_share,
    'platform_share', v_platform_share,
    'transaction_fee', NULL,
    'checkout_total', NULL,
    'status', 'payment_pending'
  );

EXCEPTION
  WHEN exclusion_violation THEN
    RAISE EXCEPTION
      'These dates have just been reserved by someone else. Please choose different dates.';
END;
$function$;
