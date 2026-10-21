
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
    return respond({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");

  if (!PAYSTACK_SECRET_KEY) {
    return respond({ error: "Payment service is not configured." }, 500);
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

  let body: { booking_id?: string };

  try {
    body = await req.json();
  } catch {
    return respond({ error: "Invalid request body." }, 400);
  }

  const bookingId = body.booking_id;

  if (
    typeof bookingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)
  ) {
    return respond({ error: "Invalid booking ID." }, 400);
  }

  const admin = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .select("id,renter_id,total_amount,status,payment_status,payment_reference")
    .eq("id", bookingId)
    .maybeSingle();

  if (bookingError || !booking) {
    return respond({ error: "Booking not found." }, 404);
  }

  if (booking.renter_id !== authData.user.id) {
    return respond({ error: "You cannot pay for this booking." }, 403);
  }

  if (
    booking.status !== "payment_pending" ||
    booking.payment_status !== "pending"
  ) {
    return respond({
      error: "This booking is not currently eligible for a deposit payment."
    }, 409);
  }

  if (booking.payment_reference) {
    const previousResponse = await fetch(
      "https://api.paystack.co/transaction/verify/" +
        encodeURIComponent(booking.payment_reference),
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          Accept: "application/json",
        },
      }
    );

    if (!previousResponse.ok) {
      return respond({
        error: "We couldn't safely check your previous payment attempt. Please contact support before trying again."
      }, 409);
    }

    const previousResult = await previousResponse.json();
    const previousStatus = previousResult?.data?.status;

    if (
      previousResult?.status === true &&
      previousStatus === "success"
    ) {
      return respond({
        error: "Your previous transaction may already have succeeded. Return to your reservation page so the payment can be verified. Do not pay again."
      }, 409);
    }

    if (!["failed", "abandoned"].includes(previousStatus)) {
      return respond({
        error: "Your previous payment attempt is not confirmed as failed. Please wait or contact support before retrying."
      }, 409);
    }
  }

  const totalNaira = Number(booking.total_amount);

  if (!Number.isFinite(totalNaira) || totalNaira <= 0) {
    return respond({ error: "Invalid booking amount." }, 400);
  }

  const amountKobo = Math.round(totalNaira * 0.30 * 100);

  if (!Number.isSafeInteger(amountKobo) || amountKobo < 1) {
    return respond({ error: "Invalid deposit amount." }, 400);
  }

  const email = authData.user.email;

  if (!email) {
    return respond({
      error: "Your account has no email address. Add an email before paying."
    }, 400);
  }

  const reference = `RAM-${crypto.randomUUID()}`;

  const paystackResponse = await fetch(
    "https://api.paystack.co/transaction/initialize",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email,
        amount: amountKobo,
        currency: "NGN",
        reference,
        callback_url:
          "https://rentamout.vercel.app/rentamout_reservation_payment.html",
        metadata: {
          booking_id: booking.id,
          renter_id: booking.renter_id,
          payment_type: "deposit",
          deposit_percentage: 30,
        },
      }),
    }
  );

  const paystackResult = await paystackResponse.json();

  if (
    !paystackResponse.ok ||
    paystackResult?.status !== true ||
    !paystackResult?.data?.authorization_url
  ) {
    console.error("Paystack initialization failed:", paystackResult);
    return respond({
      error: "Paystack could not start checkout. Please try again later."
    }, 502);
  }

  let updateQuery = admin
    .from("bookings")
    .update({ payment_reference: reference })
    .eq("id", booking.id)
    .eq("renter_id", booking.renter_id)
    .eq("status", "payment_pending")
    .eq("payment_status", "pending");

  if (booking.payment_reference) {
    updateQuery = updateQuery.eq(
      "payment_reference",
      booking.payment_reference
    );
  } else {
    updateQuery = updateQuery.is("payment_reference", null);
  }

  const { data: updatedBooking, error: updateError } =
    await updateQuery.select("id").maybeSingle();

  if (updateError || !updatedBooking) {
    console.error("Could not save payment reference:", updateError);
    return respond({
      error: "Checkout was initialized, but the booking could not be safely updated. Do not pay through this checkout. Contact support."
    }, 500);
  }

  return respond({
    success: true,
    authorization_url: paystackResult.data.authorization_url,
    reference,
    amount: amountKobo,
    currency: "NGN",
  });
});
