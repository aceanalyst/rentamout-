
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

  const { data: auth, error: authError } =
    await userClient.auth.getUser();

  if (authError || !auth.user) {
    return respond({ error: "Your session is invalid. Please sign in again." }, 401);
  }

  let body: { booking_id?: string; payment_type?: string };

  try {
    body = await req.json();
  } catch {
    return respond({ error: "Invalid request." }, 400);
  }

  const bookingId = body.booking_id;
  const paymentType = body.payment_type;

  if (
    typeof bookingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)
  ) {
    return respond({ error: "Invalid booking ID." }, 400);
  }

  if (paymentType !== "deposit" && paymentType !== "balance") {
    return respond({ error: "Choose deposit or balance payment." }, 400);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .select("id,renter_id,total_amount,status,payment_status,payment_reference")
    .eq("id", bookingId)
    .maybeSingle();

  if (bookingError || !booking) {
    return respond({ error: "Booking not found." }, 404);
  }

  if (booking.renter_id !== auth.user.id) {
    return respond({ error: "You cannot pay for this booking." }, 403);
  }

  const totalNaira = Number(booking.total_amount);

  if (!Number.isFinite(totalNaira) || totalNaira <= 0) {
    return respond({ error: "Invalid booking amount." }, 400);
  }

  const percentage = paymentType === "deposit" ? 0.30 : 0.70;
  const amountKobo = Math.round(totalNaira * percentage * 100);

  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    return respond({ error: "Invalid payment amount." }, 400);
  }

  if (paymentType === "deposit") {
    if (
      booking.status !== "payment_pending" ||
      booking.payment_status !== "pending"
    ) {
      return respond({ error: "This booking is not awaiting a deposit." }, 409);
    }

    const { data: paidDeposit, error: depositError } = await admin
      .from("booking_payments")
      .select("id")
      .eq("booking_id", booking.id)
      .eq("renter_id", booking.renter_id)
      .eq("payment_type", "deposit")
      .eq("status", "paid")
      .maybeSingle();

    if (depositError) {
      return respond({ error: "Could not check the deposit record." }, 500);
    }

    if (paidDeposit) {
      return respond({ error: "The deposit has already been paid." }, 409);
    }
  } else {
    if (
      booking.status !== "confirmed" ||
      booking.payment_status !== "pending"
    ) {
      return respond({ error: "This booking is not awaiting its balance." }, 409);
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
      return respond({ error: "A verified deposit is required first." }, 409);
    }

    const { data: paidBalance, error: balanceError } = await admin
      .from("booking_payments")
      .select("id")
      .eq("booking_id", booking.id)
      .eq("renter_id", booking.renter_id)
      .eq("payment_type", "balance")
      .eq("status", "paid")
      .maybeSingle();

    if (balanceError) {
      return respond({ error: "Could not check the balance record." }, 500);
    }

    if (paidBalance) {
      return respond({ error: "The rental balance has already been paid." }, 409);
    }
  }

  // Check whether the current reference belongs to a payment
  // already recorded as paid before considering a retry.
  if (booking.payment_reference) {
    const { data: previousPayment, error: previousError } = await admin
      .from("booking_payments")
      .select("payment_type,status")
      .eq("payment_reference", booking.payment_reference)
      .maybeSingle();

    if (previousError) {
      return respond({ error: "Could not check the previous payment." }, 500);
    }

    if (
      previousPayment?.status === "paid" &&
      previousPayment.payment_type === paymentType
    ) {
      return respond({ error: "This payment has already been recorded." }, 409);
    }

    // A recorded deposit reference is expected when starting the balance.
    const isPreviousDeposit =
      paymentType === "balance" &&
      previousPayment?.payment_type === "deposit" &&
      previousPayment.status === "paid";

    if (!isPreviousDeposit) {
      const oldVerification = await fetch(
        "https://api.paystack.co/transaction/verify/" +
          encodeURIComponent(booking.payment_reference),
        {
          headers: {
            Authorization: `Bearer ${paystackKey}`,
            Accept: "application/json",
          },
        }
      );

      if (oldVerification.ok) {
        const oldResult = await oldVerification.json();
        const oldTransaction = oldResult?.data;

        if (
          oldResult?.status === true &&
          oldTransaction?.status === "success"
        ) {
          return respond({
            error: "A previous payment succeeded or is already processing. Please refresh the booking before trying again."
          }, 409);
        }

        if (
          oldResult?.status === true &&
          oldTransaction?.status !== "failed" &&
          oldTransaction?.status !== "abandoned"
        ) {
          return respond({
            error: "The previous payment status is uncertain. Please try again later."
          }, 409);
        }

        if (
          oldResult?.status !== true ||
          !["failed", "abandoned"].includes(oldTransaction?.status)
        ) {
          return respond({
            error: "The previous payment could not be safely checked. Please try again later."
          }, 409);
        }
      } else {
        return respond({
          error: "The previous payment could not be checked. Please try again later."
        }, 409);
      }
    }
  }

  const reference = `RAM-${crypto.randomUUID()}`;

  const paystackResponse = await fetch(
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
          payment_type: paymentType,
          payment_percentage: paymentType === "deposit" ? 30 : 70,
        },
      }),
    }
  );

  let paystackResult: any;

  try {
    paystackResult = await paystackResponse.json();
  } catch {
    return respond({ error: "Could not read Paystack's response." }, 502);
  }

  if (
    !paystackResponse.ok ||
    paystackResult?.status !== true ||
    !paystackResult?.data?.authorization_url
  ) {
    return respond({
      error: paystackResult?.message || "Could not start payment. Please try again."
    }, 502);
  }

  // Save the new reference only while the booking remains eligible.
  const { data: savedBooking, error: saveError } = await admin
    .from("bookings")
    .update({ payment_reference: reference })
    .eq("id", booking.id)
    .eq("renter_id", auth.user.id)
    .eq("status", booking.status)
    .eq("payment_status", "pending")
    .select("id")
    .maybeSingle();

  if (saveError || !savedBooking) {
    return respond({
      error: "Checkout was created but could not be linked to the booking. Do not pay through that checkout. Refresh the booking and contact support if needed."
    }, 409);
  }

  return respond({
    success: true,
    authorization_url: paystackResult.data.authorization_url,
    reference,
    amount: amountKobo,
    currency: "NGN",
    payment_type: paymentType,
  });
});
