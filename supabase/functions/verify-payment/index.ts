
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

  if (authError || !auth.user) {
    return respond(
      { error: "Your session is invalid. Please sign in again." },
      401,
    );
  }

  let body: { booking_id?: string; reference?: string };

  try {
    body = await req.json();
  } catch {
    return respond({ error: "Invalid request." }, 400);
  }

  const bookingId = body.booking_id;
  const reference = body.reference;

  if (
    typeof bookingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      bookingId,
    ) ||
    typeof reference !== "string" ||
    !/^RAM-[0-9a-f-]{36}$/i.test(reference)
  ) {
    return respond({ error: "Invalid booking ID or payment reference." }, 400);
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
    return respond({ error: "You cannot verify this booking." }, 403);
  }

  if (booking.payment_reference !== reference) {
    return respond(
      { error: "Payment reference does not match this booking." },
      409,
    );
  }

  const rentalFee = Number(booking.total_amount);
  const securityDeposit = Number(booking.security_deposit_amount);
  const baseAmountNaira = Number(booking.base_checkout_amount);

  if (
    !Number.isFinite(rentalFee) ||
    !Number.isFinite(securityDeposit) ||
    !Number.isFinite(baseAmountNaira) ||
    rentalFee <= 0 ||
    securityDeposit < 0 ||
    baseAmountNaira <= 0 ||
    Math.round((rentalFee + securityDeposit) * 100) !==
      Math.round(baseAmountNaira * 100)
  ) {
    return respond(
      { error: "The saved checkout amount could not be validated." },
      409,
    );
  }

  let paystackResponse: Response;

  try {
    paystackResponse = await fetch(
      "https://api.paystack.co/transaction/verify/" +
        encodeURIComponent(reference),
      {
        headers: {
          Authorization: `Bearer ${paystackKey}`,
          Accept: "application/json",
        },
      },
    );
  } catch {
    return respond(
      { error: "Could not contact Paystack. Please try again later." },
      502,
    );
  }

  let result: any;

  try {
    result = await paystackResponse.json();
  } catch {
    return respond({ error: "Could not read Paystack's response." }, 502);
  }

  if (!paystackResponse.ok || result?.status !== true || !result?.data) {
    return respond(
      { error: "Paystack could not verify this transaction yet." },
      502,
    );
  }

  const transaction = result.data;

  if (transaction.status !== "success") {
    return respond(
      {
        success: false,
        payment_status: transaction.status ?? "unknown",
        message:
          "Payment has not been confirmed. Do not retry if your bank shows a debit; contact support for assistance.",
      },
      409,
    );
  }

  if (
    transaction.reference !== reference ||
    transaction.currency !== "NGN" ||
    !Number.isSafeInteger(transaction.amount) ||
    transaction.amount <= 0
  ) {
    return respond(
      { error: "Paystack transaction details do not match this checkout." },
      409,
    );
  }

  const expectedAmountKobo = Math.round(baseAmountNaira * 100);

  if (transaction.amount !== expectedAmountKobo) {
    return respond(
      {
        error:
          "Verified payment amount does not match the booking. Contact support for reconciliation.",
      },
      409,
    );
  }

  const metadata = transaction.metadata;

  if (
    !metadata ||
    metadata.booking_id !== booking.id ||
    metadata.renter_id !== auth.user.id ||
    metadata.payment_type !== "full_payment"
  ) {
    return respond(
      { error: "Payment metadata does not match this booking." },
      409,
    );
  }

  // Paystack's verified `fees` field is in kobo.
  // Do not estimate the fee or add it to the amount sent at initialization.
  if (
    !Number.isSafeInteger(transaction.fees) ||
    transaction.fees < 0
  ) {
    return respond(
      {
        error:
          "Paystack did not return a valid transaction fee. Contact support before retrying.",
      },
      409,
    );
  }

  const verifiedAmountNaira = transaction.amount / 100;
  const transactionFeeNaira = transaction.fees / 100;
  const customerPaidTotalNaira =
    (transaction.amount + transaction.fees) / 100;

  if (
    !Number.isSafeInteger(transaction.amount + transaction.fees) ||
    !Number.isFinite(customerPaidTotalNaira)
  ) {
    return respond({ error: "Invalid verified payment totals." }, 409);
  }

  if (
    booking.status === "confirmed" &&
    booking.payment_status === "paid"
  ) {
    const { data: existingPayment, error: existingError } = await admin
      .from("booking_payments")
      .select("id,amount,status,payment_type,payment_reference")
      .eq("booking_id", booking.id)
      .eq("payment_reference", reference)
      .maybeSingle();

    if (
      existingError ||
      !existingPayment ||
      existingPayment.status !== "paid" ||
      existingPayment.payment_type !== "full_payment"
    ) {
      return respond(
        { error: "Booking payment needs reconciliation. Contact support." },
        409,
      );
    }
  }

  const { data: recorded, error: recordError } = await admin.rpc(
    "record_verified_full_booking_payment",
    {
      p_booking_id: booking.id,
      p_renter_id: auth.user.id,
      p_payment_type: "full_payment",
      p_payment_reference: reference,
      p_amount: verifiedAmountNaira,
      p_transaction_fee: transactionFeeNaira,
      p_customer_paid_total: customerPaidTotalNaira,
    },
  );

  if (recordError || !recorded?.success) {
    console.error("Could not record verified payment:", recordError?.message);

    return respond(
      {
        error:
          "Paystack reports a successful payment, but booking confirmation could not be completed. Do not pay again. Contact support for reconciliation.",
      },
      500,
    );
  }

  return respond({
    success: true,
    already_recorded: recorded.already_recorded === true,
    booking_id: booking.id,
    payment_type: "full_payment",
    payment_status: "paid",
    booking_status: "confirmed",
    rental_fee: rentalFee,
    security_deposit: securityDeposit,
    base_checkout_amount: verifiedAmountNaira,
    transaction_fee: transactionFeeNaira,
    customer_paid_total: customerPaidTotalNaira,
    currency: "NGN",
  });
});
