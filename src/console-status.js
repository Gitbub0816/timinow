/**
 * One vocabulary for what a clinic sees on a request, shared by every provider
 * surface.
 *
 * The Mac console, the Windows console and the web console are three codebases
 * in three languages that must read identically. Deriving the label in each of
 * them means three chances to diverge, and they had already diverged from the
 * truth in the same way: all three printed the raw database `status`, which is
 * the booking state machine's word and not the clinic's.
 *
 * Two things were wrong with showing it raw.
 *
 * 1. `accepted` arrives before the money does. Selecting an offer writes an
 *    intake at `accepted` immediately (src/index.js's select-offer), but the
 *    booking fee has not been charged yet, and the fifteen-minute sweep will
 *    expire that very row if it never is. The console said "Accepted" for a
 *    booking that was still provisional — and then said it a second time once
 *    payment landed, which is what a clinic reported.
 * 2. A clinic's own response to a search is an offer, not an acceptance. The
 *    customer is the one who accepts, by choosing this clinic and paying.
 *
 * So the status column stays exactly as it is — it is what the state machine,
 * the expiry sweep and the deposit gate all run on, and renaming it would be a
 * migration to make a label nicer. What the clinic reads is derived from it
 * here, once, on the server, and sent to all three surfaces as a string and a
 * tone. Their job is to render it.
 */

/** The four tones every provider surface already has a colour for. */
export const CONSOLE_TONES = ["positive", "waiting", "neutral", "negative"];

const BY_STATUS = {
  pending: { label: "New request", tone: "waiting" },
  en_route: { label: "On the way", tone: "positive" },
  arrived: { label: "Arrived", tone: "positive" },
  triaged: { label: "In triage", tone: "positive" },
  seen: { label: "Seen", tone: "neutral" },
  completed: { label: "Completed", tone: "neutral" },
  declined: { label: "Declined", tone: "neutral" },
  released: { label: "Released", tone: "neutral" },
  expired: { label: "Expired", tone: "negative" },
  cancelled: { label: "Cancelled", tone: "negative" },
  no_show: { label: "No show", tone: "negative" },
  // A search target the clinic has answered and the customer has not chosen
  // yet. Already the right word in the database; it simply never reached the
  // screen, because `selected` and the intake's `accepted` both got there
  // first and both read as the same thing.
  offered: { label: "Offered", tone: "waiting" },
  // Deduplicated away in clinicDashboard — the intake supersedes it — but
  // labelled rather than left to fall through, since a row is easier to
  // explain than a blank chip if one ever does reach a console.
  selected: { label: "Offered", tone: "waiting" }
};

/**
 * What this request should read as on a clinic console.
 *
 * `bookingPaid` is the discriminator between a booking that is really made and
 * one that is still only offered. It is not a guess: the sweep in
 * src/index.js expires an `accepted` intake with no PAID booking order, so an
 * unpaid acceptance is provisional by the system's own definition.
 */
export function consoleStatusFor(request) {
  const status = String(request?.status || "").toLowerCase();
  if (status === "accepted") {
    return request?.bookingPaid
      ? { key: "accepted", label: "Accepted", tone: "positive" }
      : { key: "offered", label: "Offered", tone: "waiting" };
  }
  const known = BY_STATUS[status];
  if (known) return { key: status, label: known.label, tone: known.tone };
  // Unknown to this version — a status added by a newer Worker reaching an
  // older console. Humanised rather than hidden, so a clinic sees something
  // true rather than an empty chip.
  return {
    key: status || "unknown",
    label: status ? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Unknown",
    tone: "neutral"
  };
}
