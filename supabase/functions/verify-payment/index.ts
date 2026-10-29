
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

function diagnostic(event: string, details: Record<string, unknown>) {
  // Never log secrets, authorization headers, or customer email addresses.
  console.info(
    JSON.stringify({
      diagnostic: "verify-payment",
      event,
      ...details,
    }),
  );
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
    diagnostic("reference_mismatch", {
      booking_id: booking.id,
    });
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
    Math.round((rentalFee + securityDeposit + 2000) * 100) !==
      Math.round(baseAmountNaira * 100)
  ) {
    diagnostic("saved_checkout_amount_invalid", {
      booking_id: booking.id,
      booking_status: booking.status,
      payment_status: booking.payment_status,
    });
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
    diagnostic("paystack_network_error", {
      booking_id: booking.id,
    });
    return respond(
      { error: "Could not contact Paystack. Please try again later." },
      502,
    );
  }

  let result: any;

  try {
    result = await paystackResponse.json();
  } catch {
    diagnostic("paystack_invalid_response", {
      booking_id: booking.id,
      http_status: paystackResponse.status,
    });
    return respond({ error: "Could not read Paystack's response." }, 502);
  }

  if (!paystackResponse.ok || result?.status !== true || !result?.data) {
    diagnostic("paystack_verification_failed", {
      booking_id: booking.id,
      http_status: paystackResponse.status,
    });
    return respond(
      { error: "Paystack could not verify this transaction yet." },
      502,
    );
  }

  const transaction = result.data;

  if (transaction.status !== "success") {
    diagnostic("transaction_not_successful", {
      booking_id: booking.id,
      transaction_status: transaction.status ?? "unknown",
    });
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

  const expectedAmountKobo = Math.round(baseAmountNaira * 100);

  // The requested amount includes the fixed ₦2,000 processing fee. Paystack deducts its actual processing fee from Rentamout settlement.
  diagnostic("successful_transaction_received", {
    booking_id: booking.id,
    booking_status: booking.status,
    booking_payment_status: booking.payment_status,
    currency: transaction.currency ?? null,
    transaction_status: transaction.status,
    transaction_amount_raw: transaction.amount ?? null,
    transaction_requested_amount_raw: transaction.requested_amount ?? null,
    transaction_fees_raw: transaction.fees ?? null,
    expected_amount_kobo: expectedAmountKobo,
    reference_matches: transaction.reference === reference,
    metadata_booking_matches:
      transaction.metadata?.booking_id === booking.id,
    metadata_renter_matches:
      transaction.metadata?.renter_id === auth.user.id,
    metadata_payment_type:
      transaction.metadata?.payment_type ?? null,
  });

  if (
    transaction.reference !== reference ||
    transaction.currency !== "NGN" ||
    !Number.isSafeInteger(transaction.amount) ||
    transaction.amount <= 0 ||
    !Number.isSafeInteger(transaction.requested_amount) ||
    transaction.requested_amount <= 0 ||
    !Number.isSafeInteger(transaction.fees) ||
    transaction.fees < 0
  ) {
    diagnostic("transaction_identity_or_currency_invalid", {
      booking_id: booking.id,
      reference_matches: transaction.reference === reference,
      currency: transaction.currency ?? null,
      amount_is_positive_integer:
        Number.isSafeInteger(transaction.amount) &&
        transaction.amount > 0,
      requested_amount_is_positive_integer:
        Number.isSafeInteger(transaction.requested_amount) &&
        transaction.requested_amount > 0,
      fees_is_nonnegative_integer:
        Number.isSafeInteger(transaction.fees) &&
        transaction.fees >= 0,
    });
    return respond(
      { error: "Paystack transaction details do not match this checkout." },
      409,
    );
  }

  // Require the customer to pay exactly the saved checkout amount, including the ₦2,000 processing fee.
  const customerPaidExpectedAmount =
    transaction.amount === transaction.requested_amount;

  if (
    transaction.requested_amount !== expectedAmountKobo ||
    !customerPaidExpectedAmount
  ) {
    diagnostic("amount_mismatch", {
      expected_requested_amount_kobo: expectedAmountKobo,
      actual_requested_amount_kobo: transaction.requested_amount,
      actual_customer_paid_amount_kobo: transaction.amount,
      reported_fee_kobo: transaction.fees,
      booking_id: booking.id,
    });

    return respond(
      {
        error:
          "Paystack reports a successful payment, but the booking amount, customer-paid total, and reported fee do not reconcile. No payment record was created. Contact support for reconciliation.",
        diagnostic: {
          expected_requested_amount_kobo: expectedAmountKobo,
          actual_requested_amount_kobo: transaction.requested_amount,
          actual_customer_paid_amount_kobo: transaction.amount,
          reported_fee_kobo: transaction.fees,
          booking_id: booking.id,
        },
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
    diagnostic("metadata_mismatch", {
      booking_id: booking.id,
      metadata_present: Boolean(metadata),
      metadata_booking_matches: metadata?.booking_id === booking.id,
      metadata_renter_matches: metadata?.renter_id === auth.user.id,
      metadata_payment_type: metadata?.payment_type ?? null,
    });

    return respond(
      { error: "Payment metadata does not match this booking." },
      409,
    );
  }

  if (
    !Number.isSafeInteger(transaction.fees) ||
    transaction.fees < 0
  ) {
    diagnostic("invalid_transaction_fees", {
      booking_id: booking.id,
      fees_raw: transaction.fees ?? null,
    });

    return respond(
      {
        error:
          "Paystack did not return a valid transaction fee. No payment record was created.",
      },
      409,
    );
  }

  const verifiedAmountNaira = baseAmountNaira;
  const transactionFeeNaira = transaction.fees / 100;
  const customerPaidTotalNaira = transaction.amount / 100;

  if (
    !Number.isSafeInteger(transaction.amount) ||
    !Number.isSafeInteger(transaction.requested_amount + transaction.fees) ||
    !customerPaidExpectedAmount ||
    !Number.isFinite(customerPaidTotalNaira) ||
    Math.round(customerPaidTotalNaira * 100) !==
      Math.round(transaction.amount)
  ) {
    diagnostic("invalid_payment_totals", {
      booking_id: booking.id,
    });
    return respond({ error: "Invalid verified payment totals." }, 409);
  }

  // Do not automatically reopen a cancelled booking, even when payment
  // succeeded. Reconciliation must separately validate availability.
  if (
    booking.status !== "payment_pending" ||
    booking.payment_status !== "pending"
  ) {
    diagnostic("booking_not_eligible", {
      booking_id: booking.id,
      booking_status: booking.status,
      booking_payment_status: booking.payment_status,
    });

    return respond(
      {
        error:
          "Paystack reports a successful payment, but the booking is no longer eligible for automatic confirmation. No new payment record was created. Reconciliation is required.",
        diagnostic: {
          booking_id: booking.id,
          booking_status: booking.status,
          payment_status: booking.payment_status,
        },
      },
      409,
    );
  }

  const { data: existingPayment, error: existingError } = await admin
    .from("booking_payments")
    .select("id,amount,status,payment_type,payment_reference")
    .eq("payment_reference", reference)
    .maybeSingle();

  if (existingError) {
    diagnostic("existing_payment_lookup_failed", {
      booking_id: booking.id,
    });
    return respond(
      { error: "Could not check existing payment records. Try again later." },
      500,
    );
  }

  if (existingPayment) {
    diagnostic("existing_payment_requires_review", {
      booking_id: booking.id,
      existing_payment_status: existingPayment.status,
      existing_payment_type: existingPayment.payment_type,
    });
    return respond(
      {
        error:
          "A payment record already exists for this reference. No duplicate payment was created; reconciliation is required.",
      },
      409,
    );
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
    diagnostic("database_recording_failed", {
      booking_id: booking.id,
      database_error_code: recordError?.code ?? null,
      database_error_message: recordError?.message ?? null,
    });

    return respond(
      {
        error:
          "Paystack reports a successful payment, but booking confirmation could not be completed. Do not pay again. Contact support for reconciliation.",
      },
      500,
    );
  }

  diagnostic("payment_recorded", {
    booking_id: booking.id,
    payment_status: "paid",
    booking_status: "confirmed",
  });

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
