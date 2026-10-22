
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const paystackKey = Deno.env.get("PAYSTACK_SECRET_KEY");

  if (!supabaseUrl || !anonKey || !serviceKey || !paystackKey) {
    return respond({ error: "Payment verification is not configured." }, 500);
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return respond({ error: "Authentication required." }, 401);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: authData, error: authError } =
    await userClient.auth.getUser();

  if (authError || !authData.user) {
    return respond(
      { error: "Your session is invalid. Please sign in again." },
      401
    );
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
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      bookingId
    )
  ) {
    return respond({ error: "Invalid booking ID." }, 400);
  }

  if (
    typeof reference !== "string" ||
    !/^RAM-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      reference
    )
  ) {
    return respond({ error: "Invalid payment reference." }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
    return respond(
      { error: "You cannot verify this booking's payment." },
      403
    );
  }

  if (booking.payment_reference !== reference) {
    return respond(
      { error: "Payment reference does not match this booking." },
      409
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
      }
    );
  } catch {
    return respond(
      {
        error:
          "Could not reach Paystack. Please retry verification later; do not pay again.",
      },
      502
    );
  }

  if (!paystackResponse.ok) {
    return respond(
      {
        error:
          "Paystack could not verify this transaction. Please try again later.",
      },
      502
    );
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
    return respond(
      { error: "Paystack has not confirmed a successful payment." },
      402
    );
  }

  const metadata = transaction.metadata ?? {};
  const paymentType = metadata.payment_type;

  if (
    metadata.booking_id !== booking.id ||
    metadata.renter_id !== booking.renter_id
  ) {
    return respond(
      { error: "Payment booking or renter details do not match." },
      409
    );
  }

  if (paymentType !== "deposit" && paymentType !== "balance") {
    return respond({ error: "Payment type could not be verified." }, 409);
  }

  if (
    body.payment_type !== undefined &&
    body.payment_type !== paymentType
  ) {
    return respond(
      { error: "Payment type does not match the transaction." },
      409
    );
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
    return respond(
      {
        error:
          "The verified payment amount does not match the required amount.",
      },
      409
    );
  }

  // The database function records the payment and updates booking status
  // within one transaction, with a row lock to serialize competing requests.
  const { data: result, error: recordError } = await admin.rpc(
    "record_verified_booking_payment",
    {
      p_booking_id: booking.id,
      p_renter_id: booking.renter_id,
      p_payment_type: paymentType,
      p_payment_reference: reference,
      p_amount: expectedAmountKobo / 100,
    }
  );

  if (recordError || result?.success !== true) {
    console.error("Could not safely record verified payment:", recordError);

    return respond(
      {
        error:
          "Paystack confirmed payment, but the database could not safely finish recording it. Do not pay again; contact support.",
      },
      500
    );
  }

  return respond({
    success: true,
    already_verified: result.already_verified === true,
    payment_type: paymentType,
    full_rental_paid: paymentType === "balance",
    message:
      paymentType === "deposit"
        ? "Deposit verified and recorded."
        : "Remaining balance verified and recorded.",
  });
});
