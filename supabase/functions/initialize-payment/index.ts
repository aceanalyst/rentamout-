
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

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const paystackKey = Deno.env.get("PAYSTACK_SECRET_KEY");

  if (!url || !anonKey || !serviceKey || !paystackKey) {
    return respond({ error: "Payment service is not configured." }, 500);
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return respond({ error: "Please sign in first." }, 401);
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: auth, error: authError } = await userClient.auth.getUser();

  if (authError || !auth.user || !auth.user.email) {
    return respond(
      { error: "Your session is invalid. Please sign in again." },
      401,
    );
  }

  let body: { booking_id?: string };

  try {
    body = await req.json();
  } catch {
    return respond({ error: "Invalid request." }, 400);
  }

  const bookingId = body.booking_id;

  if (
    typeof bookingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      bookingId,
    )
  ) {
    return respond({ error: "Invalid booking ID." }, 400);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .select(
      "id,renter_id,total_amount,security_deposit_amount,status,payment_status,payment_reference,base_checkout_amount",
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (bookingError || !booking) {
    return respond({ error: "Booking not found." }, 404);
  }

  if (booking.renter_id !== auth.user.id) {
    return respond({ error: "You cannot pay for this booking." }, 403);
  }

  if (
    booking.status !== "payment_pending" ||
    booking.payment_status !== "pending"
  ) {
    return respond(
      { error: "This booking is not awaiting full payment." },
      409,
    );
  }

  const rentalFee = Number(booking.total_amount);
  const securityDeposit = Number(booking.security_deposit_amount);

  if (
    !Number.isFinite(rentalFee) ||
    !Number.isFinite(securityDeposit) ||
    rentalFee <= 0 ||
    securityDeposit < 0
  ) {
    return respond({ error: "Invalid booking amount." }, 400);
  }

  const baseAmountNaira = Math.round((rentalFee + securityDeposit) * 100) / 100;
  const amountKobo = Math.round(baseAmountNaira * 100);

  if (
    !Number.isSafeInteger(amountKobo) ||
    amountKobo <= 0 ||
    Math.abs(amountKobo / 100 - baseAmountNaira) > 0.001
  ) {
    return respond({ error: "Invalid checkout amount." }, 400);
  }

  // A previously claimed reference must be reconciled before retrying.
  if (booking.payment_reference) {
    const { data: previousPayment, error: previousError } = await admin
      .from("booking_payments")
      .select("payment_type,status,amount")
      .eq("payment_reference", booking.payment_reference)
      .maybeSingle();

    if (previousError) {
      return respond(
        { error: "Could not check the previous payment." },
        500,
      );
    }

    if (previousPayment?.status === "paid") {
      return respond(
        {
          error:
            "A payment has already been recorded. Refresh your reservation.",
        },
        409,
      );
    }

    // Do not silently reuse a reference that might belong to a prior attempt.
    let oldResponse: Response;

    try {
      oldResponse = await fetch(
        "https://api.paystack.co/transaction/verify/" +
          encodeURIComponent(booking.payment_reference),
        {
          headers: {
            Authorization: `Bearer ${paystackKey}`,
            Accept: "application/json",
          },
        },
      );
    } catch {
      return respond(
        {
          error:
            "The previous payment status could not be checked. Please try again later.",
        },
        409,
      );
    }

    if (!oldResponse.ok) {
      return respond(
        {
          error:
            "The previous payment status could not be checked. Please try again later.",
        },
        409,
      );
    }

    let oldResult: any;

    try {
      oldResult = await oldResponse.json();
    } catch {
      return respond(
        { error: "Could not read the previous payment status." },
        409,
      );
    }

    const oldTransaction = oldResult?.data;

    if (
      oldResult?.status === true &&
      oldTransaction?.status === "success"
    ) {
      return respond(
        {
          error:
            "A previous payment may have succeeded. Do not pay again; contact support for reconciliation.",
        },
        409,
      );
    }

    if (
      oldResult?.status !== true ||
      !["failed", "abandoned"].includes(oldTransaction?.status)
    ) {
      return respond(
        {
          error:
            "The previous payment status is uncertain. Please try again later.",
        },
        409,
      );
    }

    return respond(
      {
        error:
          "The previous attempt has ended. Contact support before starting another payment so the booking can be safely reset.",
      },
      409,
    );
  }

  const reference = `RAM-${crypto.randomUUID()}`;

  // Claim the booking before calling Paystack.
  // This conditional update prevents competing requests from claiming
  // the same booking from the same initial state.
  const { data: claimedBooking, error: claimError } = await admin
    .from("bookings")
    .update({
      payment_reference: reference,
      base_checkout_amount: baseAmountNaira,
    })
    .eq("id", booking.id)
    .eq("renter_id", auth.user.id)
    .eq("status", "payment_pending")
    .eq("payment_status", "pending")
    .is("payment_reference", null)
    .select("id")
    .maybeSingle();

  if (claimError) {
    return respond(
      { error: "Could not reserve a payment attempt. Please refresh." },
      500,
    );
  }

  if (!claimedBooking) {
    return respond(
      {
        error:
          "Another payment attempt may already be starting. Refresh the reservation before trying again.",
      },
      409,
    );
  }

  let paystackResponse: Response;

  try {
    paystackResponse = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          email: auth.user.email,
          amount: amountKobo,
          currency: "NGN",
          reference,
          callback_url:
            "https://rentamout.vercel.app/rentamout_reservation_payment.html",
          metadata: {
            booking_id: booking.id,
            renter_id: auth.user.id,
            payment_type: "full_payment",
            rental_fee: rentalFee,
            security_deposit: securityDeposit,
          },
        }),
      },
    );
  } catch {
    // Keep the reference when the result is uncertain.
    return respond(
      {
        error:
          "Checkout creation could not be confirmed. Do not pay again; contact support before retrying.",
      },
      502,
    );
  }

  let paystackResult: any;

  try {
    paystackResult = await paystackResponse.json();
  } catch {
    return respond(
      {
        error:
          "Checkout creation could not be confirmed. Do not pay again; contact support before retrying.",
      },
      502,
    );
  }

  if (
    !paystackResponse.ok ||
    paystackResult?.status !== true ||
    !paystackResult?.data?.authorization_url
  ) {
    // Restore only when Paystack explicitly rejected initialization.
    if (paystackResponse.ok && paystackResult?.status === false) {
      const { error: restoreError } = await admin
        .from("bookings")
        .update({
          payment_reference: null,
          base_checkout_amount: null,
        })
        .eq("id", booking.id)
        .eq("renter_id", auth.user.id)
        .eq("payment_reference", reference)
        .eq("status", "payment_pending")
        .eq("payment_status", "pending");

      if (restoreError) {
        return respond(
          {
            error:
              "Paystack rejected checkout, but the booking could not be reset. Contact support before retrying.",
          },
          502,
        );
      }
    }

    return respond(
      {
        error:
          paystackResult?.message ||
          "Could not confirm checkout creation. Do not pay again until the booking has been checked.",
      },
      502,
    );
  }

  return respond({
    success: true,
    authorization_url: paystackResult.data.authorization_url,
    reference,
    amount: amountKobo,
    currency: "NGN",
    payment_type: "full_payment",
    rental_fee: rentalFee,
    security_deposit: securityDeposit,
    base_checkout_amount: baseAmountNaira,
  });
});
