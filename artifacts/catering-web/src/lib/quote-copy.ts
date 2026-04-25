// Shared copy for the catering quote PDF, public quote page, and email body.
// Mirrors `artifacts/api-server/src/lib/quote-copy.ts` — keep both in sync.

export const PAYMENT_TERMS_TITLE = "Payment Terms";

export const PAYMENT_TERMS_BULLETS: readonly string[] = [
  "A 25% deposit is required to confirm your booking, due at least 2 weeks before the event date.",
  "The remaining balance is due 3 days before the event date.",
  "When you accept this quote, we'll email you a Square invoice for the deposit amount.",
];

export const PAYMENT_TERMS_PARAGRAPH =
  "Payment terms: a 25% deposit (due at least 2 weeks before the event) confirms your booking, " +
  "and the remaining balance is due 3 days before the event. When you accept this quote we'll " +
  "email you a Square invoice for the deposit amount.";

export const QUOTE_FOOTER_THANKS =
  "Thank you for considering dash Catering by Hollywood East Cafe for your event. " +
  "Reply to this quote to confirm or request changes.";

export const NOT_PROVIDED = "Not provided";
