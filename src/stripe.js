/**
 * Stripe REST client for Cloudflare Workers.
 *
 * There is no Node runtime here and therefore no `stripe` package: every call
 * is `fetch` against api.stripe.com with an `application/x-www-form-urlencoded`
 * body, exactly as `src/clerk.js` does for the Clerk Backend API. Follow that
 * file's shape — one private `stripeFetch`, one error class carrying the
 * status and Stripe's own error body — rather than inventing a second style.
 *
 * This module is transport only. It knows how to talk to Stripe and nothing
 * about deposits, fees, or outcomes; that lives in `src/payments.js`. The
 * split matters because the money logic is what needs testing, and it should
 * be testable without a network at all.
 *
 * Nothing here logs a request body, an API key, or a client secret. A
 * `client_secret` in a log line is a payment anyone who can read the log can
 * complete.
 */

const STRIPE_API = "https://api.stripe.com";

/**
 * Accounts v2 is still a preview API, so it is version-pinned here rather
 * than riding the account's default. An account whose dashboard default moves
 * would otherwise change the shape of `configuration.recipient` underneath us
 * with no deploy and no warning.
 */
const V2_PREVIEW_VERSION = "2026-06-24.preview";

/** Stripe rejects an idempotency key longer than this. */
const MAX_IDEMPOTENCY_KEY = 255;

export class StripeError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    /** Stripe's `error` object: `type`, `code`, `decline_code`, `param`. */
    this.stripeError = body?.error || null;
    this.code = body?.error?.code || null;
    this.stripeType = body?.error?.type || null;
  }
}

/** True when this Worker has been given a secret key to spend money with. */
export function stripeConfigured(env) {
  return Boolean(env?.STRIPE_SECRET_KEY);
}

function requireSecret(env) {
  const secret = env?.STRIPE_SECRET_KEY;
  if (!secret) throw new StripeError(503, "STRIPE_SECRET_KEY is not configured on this Worker.");
  return secret;
}

/**
 * Flatten a nested object into Stripe's bracket form encoding.
 *
 * `{ metadata: { intake_id: "x" } }` becomes `metadata[intake_id]=x`, and
 * `{ expand: ["latest_charge"] }` becomes `expand[0]=latest_charge`. Written
 * out rather than assembled by callers because a hand-built
 * `"metadata[intake_id]"` string is one typo away from silently dropping the
 * only field that joins a Stripe object back to an intake.
 *
 * `undefined` and `null` are skipped: Stripe treats an empty string as an
 * instruction to clear a field, which is not what an absent argument means.
 */
export function encodeForm(value, prefix = "", form = new URLSearchParams()) {
  if (value === undefined || value === null) return form;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => encodeForm(entry, `${prefix}[${index}]`, form));
    return form;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      encodeForm(entry, prefix ? `${prefix}[${key}]` : key, form);
    }
    return form;
  }
  form.append(prefix, typeof value === "boolean" ? String(value) : String(value));
  return form;
}

/**
 * A deterministic idempotency key built from our own identifiers.
 *
 * Never random. The point of the header is that a retry of the *same logical
 * operation* is recognized as such — a fresh UUID per attempt makes every
 * retry a new charge, which is precisely the failure the header exists to
 * prevent. `transfer:intake_abc:settle` retried after a timeout returns the
 * transfer that already happened.
 *
 * Stripe expires keys after 24 hours, which is longer than any retry window
 * this platform has.
 */
export function idempotencyKey(...parts) {
  const key = ["timi", ...parts].filter((part) => part !== undefined && part !== null && part !== "").join(":");
  return key.length > MAX_IDEMPOTENCY_KEY ? key.slice(0, MAX_IDEMPOTENCY_KEY) : key;
}

/**
 * One Stripe request.
 *
 * `stripeAccount` sets the `Stripe-Account` header, which is how a read is
 * scoped to a connected account (a clinic's balance, a clinic's payouts).
 * Writes in this integration are deliberately never made on a clinic's
 * behalf: the platform is the merchant of record.
 */
async function stripeFetch(env, path, { method = "GET", body, query, idempotencyKey: key, stripeAccount, apiVersion } = {}) {
  const url = new URL(`${STRIPE_API}${path}`);
  for (const [name, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((entry, index) => url.searchParams.set(`${name}[${index}]`, String(entry)));
    else url.searchParams.set(name, String(value));
  }

  // v2 speaks JSON; v1 speaks form encoding. Both live on the same host and
  // the same key, so the only thing that distinguishes them is the path.
  const isV2 = path.startsWith("/v2/");
  const headers = {
    authorization: `Bearer ${requireSecret(env)}`,
    accept: "application/json"
  };
  if (key && method !== "GET") headers["idempotency-key"] = key;
  if (stripeAccount) headers["stripe-account"] = stripeAccount;
  if (apiVersion || isV2) headers["stripe-version"] = apiVersion || V2_PREVIEW_VERSION;

  let payload;
  if (body !== undefined && method !== "GET") {
    if (isV2) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = encodeForm(body).toString();
    }
  }

  const response = await fetch(url, { method, headers, body: payload });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Stripe returning something that is not JSON means an edge or a proxy
    // answered, not Stripe. Say so instead of throwing a parse error that
    // names neither the endpoint nor the status.
    throw new StripeError(response.status, `Stripe returned a non-JSON response (${response.status}) from ${path}`, null);
  }
  if (!response.ok) {
    const message = parsed?.error?.message || `Stripe request failed (${response.status})`;
    throw new StripeError(response.status, message, parsed);
  }
  return parsed;
}

/* ─────────────────────────────────────────────── connected accounts ───── */

/**
 * Create the clinic's connected account.
 *
 * Two shapes, one meaning. `accountsApi: "v2"` uses the Accounts v2
 * `configuration.recipient` hash; anything else uses v1 controller
 * properties. In both cases the account:
 *
 *   - can receive transfers into a Stripe balance and nothing else. We do not
 *     request `card_payments`, because a clinic never takes a card through
 *     Tími — it bills the customer directly for veterinary charges.
 *   - gets the Express dashboard, so the clinic can see its own payouts and
 *     manage its bank details without us building that.
 *   - leaves loss liability and fee collection with the platform, which is
 *     the marketplace posture this integration was designed around.
 *
 * The legacy `type: "express" | "custom" | "standard"` parameter is never
 * sent. It is mutually exclusive with `controller`, and passing it hands
 * Stripe a bundle of defaults we would then be unable to change.
 */
export function createConnectedAccount(env, { tenantId, email, businessName, country = "US", accountsApi = "v1", supportUrl } = {}) {
  const key = idempotencyKey("account", tenantId);
  if (accountsApi === "v2") {
    return stripeFetch(env, "/v2/core/accounts", {
      method: "POST",
      idempotencyKey: key,
      body: {
        dashboard: "express",
        contact_email: email || undefined,
        display_name: businessName || undefined,
        defaults: {
          responsibilities: {
            // The platform manages fraud and eats negative balances. This is
            // the half of the decision that makes Tími the merchant of
            // record rather than a passthrough.
            fees_collector: "application",
            losses_collector: "application"
          }
        },
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: {
                stripe_transfers: { requested: true }
              }
            }
          }
        },
        identity: { country },
        metadata: { tenant_id: tenantId || "" },
        // Without `include`, v2 answers null for every one of these
        // regardless of their real values — the capability check would read
        // "inactive" for a perfectly good account.
        include: ["configuration.recipient", "identity", "requirements", "defaults"]
      }
    });
  }
  return stripeFetch(env, "/v1/accounts", {
    method: "POST",
    idempotencyKey: key,
    body: {
      country,
      email: email || undefined,
      business_profile: {
        name: businessName || undefined,
        url: supportUrl || undefined,
        // Veterinary services. Stripe asks for this during onboarding
        // anyway; prefilling it removes a screen from the clinic's flow.
        mcc: "0742"
      },
      controller: {
        losses: { payments: "application" },
        fees: { payer: "application" },
        // Stripe collects and chases the clinic's requirements. Combined
        // with the Express dashboard this is what lets us use embedded
        // onboarding instead of building a KYC form.
        requirement_collection: "stripe",
        stripe_dashboard: { type: "express" }
      },
      capabilities: {
        transfers: { requested: true }
      },
      metadata: { tenant_id: tenantId || "" }
    }
  });
}

export function retrieveConnectedAccount(env, accountId, { accountsApi = "v1" } = {}) {
  if (accountsApi === "v2") {
    return stripeFetch(env, `/v2/core/accounts/${encodeURIComponent(accountId)}`, {
      query: { include: ["configuration.recipient", "identity", "requirements", "defaults"] }
    });
  }
  return stripeFetch(env, `/v1/accounts/${encodeURIComponent(accountId)}`);
}

/**
 * Normalize the two account shapes into the four answers the platform needs.
 *
 * Callers must never reach into a raw account object: v1 says
 * `capabilities.transfers`, v2 says
 * `configuration.recipient.capabilities.stripe_balance.stripe_transfers`, and
 * a caller that knows both is a caller that will get one of them wrong.
 *
 * The payouts status is read from two possible v2 paths because Stripe has
 * shipped it under both `payouts` and `stripe_transfers.payouts` during the
 * preview; reading whichever is present is cheaper than being wrong.
 */
export function accountCapabilities(account, { accountsApi = "v1" } = {}) {
  if (!account) {
    return { transfersStatus: "inactive", chargesStatus: "inactive", payoutsStatus: "inactive", transfersEnabled: false, payoutsEnabled: false, detailsSubmitted: false, requirements: {}, disabledReason: null };
  }
  if (accountsApi === "v2") {
    const recipient = account.configuration?.recipient || {};
    const balance = recipient.capabilities?.stripe_balance || {};
    const transfersStatus = balance.stripe_transfers?.status || "inactive";
    const payoutsStatus = balance.payouts?.status || recipient.capabilities?.payouts?.status || "inactive";
    const requirements = account.requirements || {};
    return {
      transfersStatus,
      // v2 recipient-only accounts do not take charges at all. Reporting
      // "inactive" is the truth, not a missing value.
      chargesStatus: account.configuration?.merchant?.capabilities?.card_payments?.status || "inactive",
      payoutsStatus,
      transfersEnabled: transfersStatus === "active",
      payoutsEnabled: payoutsStatus === "active",
      detailsSubmitted: !Object.keys(requirements.entries || requirements.currently_due || {}).length,
      requirements,
      disabledReason: requirements.disabled_reason || null
    };
  }
  const capabilities = account.capabilities || {};
  const transfersStatus = capabilities.transfers || "inactive";
  return {
    transfersStatus,
    chargesStatus: capabilities.card_payments || "inactive",
    payoutsStatus: account.payouts_enabled ? "active" : "inactive",
    // Both halves, deliberately. `payouts_enabled` alone goes true before the
    // transfers capability activates on some accounts, and a transfer to an
    // account whose capability is still pending is rejected with an error the
    // clinic then has to hear about.
    transfersEnabled: transfersStatus === "active" && Boolean(account.payouts_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    requirements: account.requirements || {},
    disabledReason: account.requirements?.disabled_reason || null
  };
}

/**
 * An embedded-onboarding session: a client secret the clinic console hands to
 * Stripe's ConnectJS `account-onboarding` component, which renders inside our
 * page.
 *
 * Deliberately not an Account Link. A link redirects the clinic to a
 * Stripe-hosted page and back, which loses our framing at the exact moment we
 * are asking a business for its bank details. Deliberately not API onboarding
 * either — that means building and maintaining a KYC form per country.
 *
 * Not idempotency-keyed: a session is short-lived and single-use, and
 * replaying an expired one would hand the clinic a dead form.
 */
export function createOnboardingSession(env, accountId) {
  return stripeFetch(env, "/v1/account_sessions", {
    method: "POST",
    body: {
      account: accountId,
      components: {
        account_onboarding: { enabled: true }
      }
    }
  });
}

/**
 * The Stripe-hosted fallback. Kept for one case only: a clinic whose staff
 * cannot run ConnectJS (an old browser, a locked-down desktop) still needs a
 * way through. Nothing calls it by default.
 */
export function createAccountLink(env, accountId, { returnUrl, refreshUrl }) {
  return stripeFetch(env, "/v1/account_links", {
    method: "POST",
    body: {
      account: accountId,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: "account_onboarding"
    }
  });
}

/* ────────────────────────────────────────────────── payment intents ───── */

/**
 * The deposit charge. Created on the *platform* account, with no
 * `transfer_data` and no `application_fee_amount` — see the funds-flow note
 * in src/payments.js for why the destination is not known yet.
 *
 * `transfer_group` is set at creation because it cannot be set afterwards,
 * and it is the only string that will later tie this charge to the transfer
 * that pays the clinic.
 */
export function createPaymentIntent(env, { amountCents, currency = "usd", transferGroup, description, metadata, idempotencyKey: key, statementDescriptorSuffix }) {
  return stripeFetch(env, "/v1/payment_intents", {
    method: "POST",
    idempotencyKey: key,
    body: {
      amount: amountCents,
      currency,
      // Elements, mounted in our own UI. `automatic_payment_methods` lets the
      // dashboard decide which methods appear without a redeploy;
      // `allow_redirects: never` keeps every method inline, because a
      // redirect method would send somebody with a sick animal out to a bank
      // page mid-flow.
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      transfer_group: transferGroup,
      description,
      statement_descriptor_suffix: statementDescriptorSuffix,
      metadata
    }
  });
}

export function retrievePaymentIntent(env, paymentIntentId) {
  return stripeFetch(env, `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    // The charge id is what the ledger and every later transfer need, and it
    // only exists on the expanded object.
    query: { expand: ["latest_charge"] }
  });
}

export function cancelPaymentIntent(env, paymentIntentId, { reason = "abandoned", idempotencyKey: key } = {}) {
  return stripeFetch(env, `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`, {
    method: "POST",
    idempotencyKey: key || idempotencyKey("pi-cancel", paymentIntentId),
    body: { cancellation_reason: reason }
  });
}

/* ─────────────────────────────────────────────────────── transfers ───── */

/**
 * Move the clinic's share out of the platform balance.
 *
 * `source_transaction` is the charge that funded it. Without it, a transfer
 * fails outright whenever the platform's available balance has not yet caught
 * up with the charge — which, for a deposit taken minutes ago, is always.
 * With it, Stripe accepts the transfer and executes it when the funds settle.
 */
export function createTransfer(env, { amountCents, currency = "usd", destination, transferGroup, sourceTransaction, description, metadata, idempotencyKey: key }) {
  return stripeFetch(env, "/v1/transfers", {
    method: "POST",
    idempotencyKey: key,
    body: {
      amount: amountCents,
      currency,
      destination,
      transfer_group: transferGroup,
      source_transaction: sourceTransaction,
      description,
      metadata
    }
  });
}

export function retrieveTransfer(env, transferId) {
  return stripeFetch(env, `/v1/transfers/${encodeURIComponent(transferId)}`);
}

/* ───────────────────────────────────────────────────────── refunds ───── */

/**
 * Refund the customer.
 *
 * `reverse_transfer` is never set. By the time anything is refunded the
 * transfer either has not happened (the outcome is still unsettled) or was
 * deliberately sized to leave the refund behind. Letting Stripe claw back a
 * proportional slice of a transfer we sized ourselves would silently
 * contradict the policy the customer was shown.
 */
export function createRefund(env, { paymentIntentId, amountCents, reason, metadata, idempotencyKey: key }) {
  return stripeFetch(env, "/v1/refunds", {
    method: "POST",
    idempotencyKey: key,
    body: {
      payment_intent: paymentIntentId,
      amount: amountCents,
      reason,
      metadata
    }
  });
}

/* ─────────────────────────────────────────────── balance and payouts ───── */

/**
 * A connected account's payouts. Read with `Stripe-Account`, so this is the
 * clinic's own list — what Stripe has sent, or is sending, to its bank.
 */
export function listPayouts(env, { stripeAccount, limit = 25, status, createdGte } = {}) {
  return stripeFetch(env, "/v1/payouts", {
    stripeAccount,
    query: {
      limit: Math.min(100, Math.max(1, limit)),
      status,
      ...(createdGte ? { "created[gte]": createdGte } : {})
    }
  });
}

/** A connected account's balance, or the platform's when no account is given. */
export function retrieveBalance(env, { stripeAccount } = {}) {
  return stripeFetch(env, "/v1/balance", { stripeAccount });
}

/**
 * Balance transactions, the join between our ledger rows and a payout report.
 * `payout` filters to the lines that made up one payout.
 */
export function listBalanceTransactions(env, { stripeAccount, payout, limit = 100 } = {}) {
  return stripeFetch(env, "/v1/balance_transactions", {
    stripeAccount,
    query: { payout, limit: Math.min(100, Math.max(1, limit)) }
  });
}

/* ──────────────────────────────────────────── webhook verification ───── */

/** Compare two equal-length strings without leaking where they differ. */
function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Length is not secret — it is fixed by the hash — so an early return here
  // reveals nothing. Comparing unequal lengths byte-by-byte would be the
  // actual bug, since the loop would end at the shorter one.
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Parse `t=…,v1=…,v1=…,v0=…` into a timestamp and the v1 signatures. */
export function parseStripeSignatureHeader(header) {
  const result = { timestamp: null, signatures: [] };
  if (typeof header !== "string" || !header) return result;
  for (const element of header.split(",")) {
    const separator = element.indexOf("=");
    if (separator < 0) continue;
    const prefix = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (prefix === "t") result.timestamp = value;
    // Only v1. Stripe also sends a fake `v0` on test events, and accepting
    // any scheme that is not v1 is how a downgrade attack gets in.
    else if (prefix === "v1") result.signatures.push(value);
  }
  return result;
}

/**
 * Verify a Stripe webhook by hand.
 *
 * There is no `stripe.webhooks.constructEvent` in a Worker, so this is the
 * whole security boundary of the endpoint. An endpoint that skips it is a
 * public URL where anyone who can guess an intake id can post a
 * `payment_intent.succeeded` and have Tími mark a deposit paid, transfer real
 * money to a clinic, and tell a customer their care is confirmed.
 *
 * The scheme, per Stripe's "verify manually" instructions:
 *   signed payload = `${timestamp}.${rawBody}`
 *   expected       = HMAC-SHA256(signed payload, endpoint secret), hex
 *   accept if any v1 signature in the header matches, in constant time
 *   and if the timestamp is within tolerance
 *
 * The raw body must be the exact bytes Stripe sent. Anything that reparses
 * and re-serializes the JSON — even reordering keys — changes the hash.
 *
 * The tolerance is what stops a replay: a valid, captured request stays
 * cryptographically valid forever, and only the clock makes it stale.
 */
export async function verifyWebhookSignature(rawBody, signatureHeader, secret, { toleranceSeconds = 300, nowSeconds } = {}) {
  if (!secret) return { ok: false, reason: "STRIPE_WEBHOOK_SECRET is not configured on this Worker." };
  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);
  if (!timestamp || !signatures.length) return { ok: false, reason: "The Stripe-Signature header is missing its timestamp or v1 signature." };

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: "The Stripe-Signature timestamp is not a number." };
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  // Absolute difference, so a request stamped in the future is rejected too.
  // A future timestamp is either a badly wrong clock or somebody buying
  // themselves a replay window.
  if (Math.abs(now - sent) > toleranceSeconds) {
    return { ok: false, reason: `The Stripe-Signature timestamp is outside the ${toleranceSeconds}s tolerance.` };
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)));

  // Every candidate is compared even after a match, so the number of
  // comparisons does not depend on which secret was right. Stripe sends one
  // signature per active secret while an endpoint secret is being rolled.
  let matched = false;
  for (const candidate of signatures) {
    if (constantTimeEquals(expected, candidate)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "No signature in the Stripe-Signature header matches the payload." };
}
