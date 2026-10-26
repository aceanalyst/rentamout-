
  diagnostic("successful_transaction_received", {
    booking_id: booking.id,
    booking_status: booking.status,
    booking_payment_status: booking.payment_status,
    currency: transaction.currency ?? null,
    transaction_status: transaction.status,
    transaction_amount_raw: transaction.amount ?? null,
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
