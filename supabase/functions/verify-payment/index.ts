
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond({ error: "Method not allowed." }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !PAYSTACK_SECRET_KEY
  ) {
    return respond({ error: "Payment verification is not configured." }, 500);
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return respond({ error: "Authentication required." }, 401);
  }

  const userClient = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: authData, error: authError } =
    await userClient.auth.getUser();

  if (authError || !authData.user) {
    return respond({ error: "Your session is invalid. Please sign in again." }, 401);
  }

  let body: {
    booking_id?: string;
    reference?: string;
    payment_type?: string;
  };

  try {
    body = await req.json();
  } catch {
    return respond({ error: "Invalid request body." }, 400);
  }

  const bookingId = body.booking_id;
  const reference = body.reference;

  if (
    typeof bookingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)
  ) {
    return respond({ error: "Invalid booking ID." }, 400);
  }

  if (
    typeof reference !== "string" ||
    !/^RAM-[0-9a-f-]{36}$/i.test(reference)
  ) {
    return respond({ error: "Invalid payment reference." }, 400);
  }

  const admin = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .select(
      "id,renter_id,total_amount,status,payment_status,payment_reference"
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (bookingError || !booking) {
    return respond({ error: "Booking not found." }, 404);
  }

  if (booking.renter_id !== authData.user.id) {
    return respond({ error: "You cannot verify this booking's payment." }, 403);
  }

  if (booking.payment_reference !== reference) {
    return respond({ error: "Payment reference does not match this booking." }, 409);
  }

  const paystackResponse = await fetch(
    "https://api.paystack.co/transaction/verify/" +
      encodeURIComponent(reference),
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        Accept: "application/json",
      },
    }
  );

  if (!paystackResponse.ok) {
    return respond({
      error: "Paystack could not verify this transaction. Please try again later."
    }, 502);
  }

  let paystackResult: any;

  try {
    paystackResult = await paystackResponse.json();
  } catch {
    return respond({ error: "Invalid response from Paystack." }, 502);
  }

  const transaction = paystackResult?.data;

  if (
    paystackResult?.status !== true ||
    transaction?.status !== "success" ||
    transaction?.reference !== reference ||
    transaction?.currency !== "NGN"
  ) {
    return respond({
      error: "Paystack has not confirmed a successful payment."
    }, 402);
  }

  const metadata = transaction.metadata ?? {};
  const metadataBookingId = metadata.booking_id;
  const metadataPaymentType = metadata.payment_type;

  if (metadataBookingId !== booking.id) {
    return respond({ error: "Payment booking details do not match." }, 409);
  }

  const paymentType =
    metadataPaymentType === "deposit" || metadataPaymentType === "balance"
      ? metadataPaymentType
      : null;

  if (!paymentType) {
    return respond({ error: "Payment type could not be verified." }, 409);
  }

  if (
    body.payment_type !== undefined &&
    body.payment_type !== paymentType
  ) {
    return respond({ error: "Payment type does not match the transaction." }, 409);
  }

  const totalNaira = Number(booking.total_amount);

  if (!Number.isFinite(totalNaira) || totalNaira <= 0) {
    return respond({ error: "Invalid booking amount." }, 400);
  }

  const expectedAmountKobo = Math.round(
    totalNaira * (paymentType === "deposit" ? 0.30 : 0.70) * 100
  );

  if (
    !Number.isSafeInteger(expectedAmountKobo) ||
    transaction.amount !== expectedAmountKobo
  ) {
    return respond({
      error: "The verified payment amount does not match the required amount."
    }, 409);
  }

  const { data: existingPayment, error: existingError } = await admin
    .from("booking_payments")
    .select("id,status,payment_type")
    .eq("payment_reference", reference)
    .maybeSingle();

  if (existingError) {
    return respond({ error: "Could not check the payment record." }, 500);
  }

  if (existingPayment?.status === "paid") {
    if (existingPayment.payment_type !== paymentType) {
      return respond({ error: "Existing payment type does not match." }, 409);
    }

    if (paymentType === "balance") {
      const { error: paidUpdateError } = await admin
        .from("bookings")
        .update({ payment_status: "paid" })
        .eq("id", booking.id)
        .eq("renter_id", booking.renter_id)
        .eq("status", "confirmed");

      if (paidUpdateError) {
        return respond({
          error: "Payment is recorded, but booking status needs support review."
        }, 500);
      }
    }

    return respond({
      success: true,
      already_verified: true,
      payment_type: paymentType,
      full_rental_paid: paymentType === "balance",
      message: "This payment has already been verified."
    });
  }

  if (existingPayment) {
    return respond({
      error: "A payment record already exists but is not marked paid. Please contact support."
    }, 409);
  }

  if (paymentType === "deposit") {
    if (
      booking.status !== "payment_pending" ||
      booking.payment_status !== "pending"
    ) {
      return respond({ error: "Booking is not eligible for deposit verification." }, 409);
    }
  } else {
    if (
      booking.status !== "confirmed" ||
      booking.payment_status !== "pending"
    ) {
      return respond({ error: "Booking is not eligible for balance verification." }, 409);
    }

    const { data: deposit, error: depositError } = await admin
      .from("booking_payments")
      .select("id")
      .eq("booking_id", booking.id)
      .eq("renter_id", booking.renter_id)
      .eq("payment_type", "deposit")
      .eq("status", "paid")
      .maybeSingle();

    if (depositError || !deposit) {
      return respond({
        error: "A verified deposit is required before paying the balance."
      }, 409);
    }
  }

  const { error: insertError } = await admin
    .from("booking_payments")
    .insert({
      booking_id: booking.id,
      renter_id: booking.renter_id,
      payment_type: paymentType,
      amount: expectedAmountKobo / 100,
      currency: "NGN",
      provider: "paystack",
      payment_reference: reference,
      status: "paid",
      verified_at: new Date().toISOString(),
    });

  if (insertError) {
    console.error("Could not record verified payment:", insertError);

    return respond({
      error: "Paystack confirmed payment, but recording it failed. Do not pay again; contact support."
    }, 500);
  }

  if (paymentType === "balance") {
    const { data: updatedBooking, error: updateError } = await admin
      .from("bookings")
      .update({ payment_status: "paid" })
      .eq("id", booking.id)
      .eq("renter_id", booking.renter_id)
      .eq("status", "confirmed")
      .eq("payment_status", "pending")
      .select("id")
      .maybeSingle();

    if (updateError || !updatedBooking) {
      console.error("Could not update fully paid booking:", updateError);

      return respond({
        error: "Payment was recorded, but booking status needs support review."
      }, 500);
    }
  }

  return respond({
    success: true,
    already_verified: false,
    payment_type: paymentType,
    full_rental_paid: paymentType === "balance",
    message: paymentType === "deposit"
      ? "Deposit verified and recorded."
      : "Remaining balance verified and recorded."
  });
});
