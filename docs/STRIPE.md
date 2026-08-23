# Stripe at Tími NOW

How money moves, why it moves that way, and what a person still has to do by
hand before any of it works.

Read `docs/PAYMENTS-AND-TENANT-POLICIES.md` first — it defines the commercial
baseline (deposit amounts, fees per outcome, refund windows) that this document
implements.

---

## The decision record

This architecture was chosen deliberately. The reasoning matters more than the
shape, because every one of these choices has an obvious-looking alternative
that is wrong for this business.

### Stripe Connect, marketplace model. Tími is the merchant of record.

The platform owns pricing, manages fraud, and carries loss liability. Connected
accounts are created with `controller.losses.payments = application` and
`controller.fees.payer = application` (v1), or
`defaults.responsibilities.{losses,fees}_collector = application` (v2).

That is the half of the decision that makes the deposit *Tími's* charge rather
than the clinic's, which is what makes everything below possible.

### Separate charges and transfers — not destination charges.

**The split is not knowable at charge time.**

The pet owner pays the arrival deposit when they select a clinic's offer.
Whether the clinic keeps it, whether Tími takes a completed-intake fee or a
no-show fee or a late-cancel fee, and whether the customer is refunded, are all
decided later from the intake outcome — often hours later, sometimes the next
day.

A destination charge transfers at charge time. It would move the money to the
clinic the instant the card was authorized, before any of that outcome existed,
and the only way back would be reversing a transfer that should never have been
made in the first place.

So: the charge lands on the platform account, and a `Transfer` moves the
clinic's share afterwards. `scripts/validate-native.mjs` fails the build if
`transfer_data` ever appears in `src/stripe.js` or `src/payments.js`.

### Fees are collected by transferring less, never with `application_fee_amount`.

The arithmetic is identical; the meaning is not. An application fee is a fee the
*connected account* pays out of a charge it owns — and the clinic does not own
this charge. Transferring less is the honest description of what happens: the
platform holds the money and sends on the clinic's share.

The retained fee still gets its own ledger row, because a ledger that records
the transfer and not the fee cannot be reconciled against a deposit.

### Connected accounts: recipient-only, Express dashboard, embedded onboarding.

Clinics receive transfers and nothing else. We do not request `card_payments`,
because a clinic never takes a card through Tími — it bills the customer
directly for veterinary charges.

- **v1** (default): `controller` properties plus `capabilities.transfers`.
- **v2** (`STRIPE_ACCOUNTS_API=v2`): `configuration.recipient.capabilities.stripe_balance.stripe_transfers`.

The legacy `type: 'standard' | 'express' | 'custom'` parameter is **never**
sent. It is mutually exclusive with `controller`, and passing it hands Stripe a
bundle of defaults we would then be unable to change. A build guard enforces
this.

Onboarding is **embedded** — Stripe's `account-onboarding` component rendered
inside the platform console. Never Stripe-hosted onboarding, which drops whoever
is sitting there onto a Stripe-branded page at the exact moment we are asking a
business for its bank details. Never API onboarding, which means maintaining KYC
form fields per country forever.

Before every transfer, the connected account's capability is checked:
`configuration.recipient.capabilities.stripe_balance.stripe_transfers` (v2) or
`capabilities.transfers` plus `payouts_enabled` (v1). Both halves for v1,
because `payouts_enabled` flips true before the transfers capability activates
on some accounts, and a transfer sent in that window is rejected by Stripe with
an error the clinic never hears about.

### Stripe Elements mounted inline in our own UI. Never Checkout.

Web, iOS today; Android when the Stripe Android SDK is gated the same way. The
person holding the phone is standing somewhere with a sick animal and has just
chosen a clinic; sending them to a hosted page at that moment loses the context
and often the customer.

On iOS this is `PaymentSheet.FlowController`: Stripe owns the payment-method
fields (card numbers must never touch our code — PCI scope is what that buys),
and Tími owns the screen, the amount, the copy, and the confirm button.

### Everything is driven by webhooks. The client is never believed.

A phone reporting "the sheet succeeded" is a phone that could have been killed
between confirming and reporting, could have lost its network, or could be a
script. `POST /api/stripe/webhook` is the only endpoint in the platform that
changes payment state.

`GET /api/intakes/{id}/payment-status` is read-only. It used to reach into
Stripe and write `payment_status` from whatever it found, which made a
client-triggered GET the thing that marked a deposit paid.

### US platform, US connected accounts, same country.

No cross-border transfers, no multi-currency settlement. Everything is `usd`.

### No Stripe Invoicing.

The clinic bills the customer directly for veterinary charges. Tími handles the
deposit and its own fees, and nothing else.

---

## The funds flow, end to end

```
1. Clinic accepts / customer selects an offer
      → intake_requests row, payment_status = 'pending'

2. POST /api/intakes/{id}/payment-intent
      → PaymentIntent on the PLATFORM account
         amount          = policy deposit
         transfer_group  = timi_intake_{id}      (set now; cannot be set later)
         metadata        = intake_id, tenant_id, search_id, public_code
      → ledger row: deposit_pending (in)
      → returns client_secret + publishable key

3. Customer confirms with Elements, in our UI

4. Stripe → POST /api/stripe/webhook  payment_intent.succeeded
      → signature verified, event id claimed in stripe_events
      → ledger row: deposit_captured (in), with charge id,
        balance_transaction id, Stripe's fee, and available_on
      → intake_requests.payment_status = 'paid'

5. The visit happens. The clinic console (or the expiry sweep) moves the
   intake to completed / no_show / cancelled.

6. Settlement — from the cron sweep, or immediately if the deposit clears
   after the outcome is already known:
      splitForOutcome(policy, outcome, deposit) → three integers that sum
      to exactly the deposit

      completed        clinic = deposit − completed fee
      no_show          clinic = deposit − no-show fee
      late_cancel      clinic = deposit − late-cancel fee
      free_cancel      customer refunded in full, no fee, no transfer
      clinic_cancelled customer refunded in full, no fee

      → Transfer to the connected account, with source_transaction = the
        charge that funded it (without it the transfer fails until the
        deposit settles into the available balance)
      → ledger rows: clinic_transfer (out), platform_fee (in)
      → Refund, when the outcome calls for one; its ledger row is written
        by the charge.refunded webhook, not optimistically at request time

7. Stripe pays the clinic's balance out to its bank
      → payout.paid on the connected account
      → ledger row: clinic_payout (out), attributed to the tenant
```

`depositRefundable: false` removes the free-cancel path entirely: on a
non-refundable policy a cancellation is a late cancel however early it arrives.
Emergency hospitals use this, and it is disclosed before payment.

Percentage fee components (`policy_json.platformFeeBasisPoints`) are **floored**,
never rounded. Rounding up takes a cent that belongs to the clinic, and at the
boundary transfers more than was charged. A fee larger than its own deposit is
capped at the deposit rather than becoming a negative transfer.

---

## What was built

| File | What it is |
| --- | --- |
| `migrations/0008_payments_ledger.sql` | `stripe_accounts`, `payment_ledger`, `stripe_events`, plus settlement columns on `intake_requests` |
| `src/stripe.js` | The REST client. No SDK — form-encoded `fetch`, `StripeError`, idempotency keys, and by-hand webhook verification |
| `src/payments.js` | The money. Split arithmetic, settlement, ledger writes, webhook dispatch |
| `src/index.js` | `POST /api/intakes/{id}/payment-intent`, `POST /api/stripe/webhook`, `GET /api/clinic/payouts`, the settlement sweep |
| `apps/admin-console/` | The Ledger screen, per-tenant Connect status, embedded onboarding |
| `apps/vet-desktop/` | The clinic's payouts view |
| `apps/customer-mobile/` | Elements on the tracker screen, gated behind `TIMI_STRIPE=1` |
| `scripts/stripe-test.mjs` | 17 groups, no network, wired into `npm run check` |

### The three tables

**`stripe_accounts`** — one row per tenant. Capability statuses stored as Stripe
reports them (`active` / `pending` / `inactive`) rather than flattened to a
boolean, because "pending" and "inactive" mean very different things to somebody
deciding whether to chase a clinic. `transfers_enabled` is the denormalized
answer to the only question callers ask.

**`payment_ledger`** — every Stripe object we touch, once. Built for an operator
with a Stripe payout report open in the other window, so everything they would
have to join on is a column: `transfer_group`, `balance_transaction_id`,
`available_on`, `fee_cents` / `net_cents`, and the `stripe_event_id` that
produced the row.

**`stripe_events`** — the idempotency table. Stripe redelivers, sometimes
concurrently. The claim is a bare `INSERT` on the event id rather than a
`SELECT` then `INSERT`, because a check followed by a write leaves a window in
which two deliveries both decide they are first. A partial unique index on
`(stripe_event_id, stripe_object_id, kind)` is the second line of defence.

### Webhook signature verification

There is no `stripe.webhooks.constructEvent` in a Cloudflare Worker, so
`verifyWebhookSignature` in `src/stripe.js` is the entire security boundary of
the endpoint:

- Raw request body, read before anything parses it. Re-serialized JSON does not
  hash to the signature Stripe sent, even when nothing a human would notice has
  changed.
- Signed payload is `` `${timestamp}.${rawBody}` ``, HMAC-SHA256 with the
  endpoint secret, hex.
- Only the `v1` scheme. Stripe also sends a fake `v0` on test events, and
  accepting any other scheme is the downgrade attack its own docs warn about.
- A ±300 second tolerance. A captured valid request stays cryptographically
  valid forever; only the clock makes it stale. Future timestamps are rejected
  too — that is either a badly wrong clock or somebody buying a replay window.
- Constant-time comparison, and every candidate signature is compared even
  after a match, so the work does not depend on which secret was right.

A rejected event gets a **400**, not a 401: Stripe retries a 401 indefinitely
and treats a 400 as a rejected delivery. The reason is logged, never returned.

---

## Environment variables

| Name | Kind | Workers | Notes |
| --- | --- | --- | --- |
| `STRIPE_PUBLISHABLE_KEY` | var | `timinow`, `timinow-admin` | `pk_…`. Public by design — served by `/api/config` and returned with each PaymentIntent so the iOS app never compiles its own copy |
| `STRIPE_ACCOUNTS_API` | var | `timinow-admin` | `v1` (default) or `v2`. Affects only clinics onboarded from now on |
| `STRIPE_SECRET_KEY` | secret | `timinow`, `timinow-admin` | `sk_…`. Can move money. Never on the veterinary Worker — its payouts view reads D1 and never calls Stripe |
| `STRIPE_WEBHOOK_SECRET` | secret | `timinow` | `whsec_…`, per endpoint. Only the Worker that serves the webhook |

There is deliberately **no `STRIPE_CONNECT_CLIENT_ID`**. That is for Connect
OAuth, where a clinic brings an existing Stripe account it already controls.
Tími creates the connected accounts itself, so the platform secret key is the
only credential involved.

`scripts/bootstrap.sh` pushes all four (step 1 for vars, step 5 for secrets) and
checks them in step 4c before deploying anything:

- the secret key is accepted by Stripe (`GET /v1/balance` — a read, nothing
  billable, key passed on stdin so it never reaches `ps` or shell history);
- the secret and publishable keys are the same mode. A live secret with a test
  publishable key looks fine on both dashboards and fails only when a real
  customer presses pay, with "No such payment_intent";
- neither key is the other one, and neither is the webhook secret.

Without `STRIPE_SECRET_KEY` the platform runs the demo deposit path unchanged.
The whole test suite and every local development run go through it.

---

## What you must do in the Stripe Dashboard

None of this can be done from code. Do it in this order.

### 1. Enable Connect

<https://dashboard.stripe.com/connect/overview> → **Get started**.

Then <https://dashboard.stripe.com/settings/connect/platform-profile>: fill in
the platform profile and **review and accept responsibility for negative
balances and fraud**. Connected accounts are created with
`controller.losses.payments = application`, and Stripe rejects that until this
is acknowledged. The error is a generic 400 that does not mention the profile,
so it is worth doing first.

### 2. Branding for the Express dashboard and embedded onboarding

<https://dashboard.stripe.com/settings/connect/branding>

Set the business name, icon, logo, and brand colour. This is what a clinic sees
during onboarding and every time it opens its Express dashboard. Unset, it says
"Tími NOW" against Stripe's defaults, which reads as an unfinished integration
to the business you are asking for bank details.

### 3. Payment methods

<https://dashboard.stripe.com/settings/payment_methods>

Cards are on by default. The PaymentIntent uses
`automatic_payment_methods: { enabled: true, allow_redirects: "never" }`, so
whatever is enabled here appears inline and redirect-based methods are excluded
— a redirect would send somebody with a sick animal out to a bank page
mid-flow.

Leave delayed-notification methods (ACH, and similar) off unless you have
decided what "the deposit will clear in three days" means for an arrival that
is happening in twenty minutes.

### 4. The webhook endpoint

<https://dashboard.stripe.com/workbench/webhooks> → **Add endpoint**

- URL: `https://timinow.pet/api/stripe/webhook`
- Listen to: **events on your account** *and* **events on connected accounts**.
  Both. Payout events arrive on the connected account, and without that box the
  clinic payout rows never appear in the ledger.

Subscribe to exactly these:

| Event | What it does |
| --- | --- |
| `payment_intent.succeeded` | Marks the deposit paid; writes the capture row. **The one that matters most** |
| `payment_intent.processing` | Deposit pending on a delayed method |
| `payment_intent.payment_failed` | Marks the deposit failed; records the decline code |
| `payment_intent.canceled` | Records an abandoned deposit |
| `charge.refunded` | Writes the refund row; marks the intake refunded |
| `transfer.created` | Records a clinic transfer |
| `transfer.reversed` | Records a reversal |
| `payout.paid` | Clinic payout reached its bank |
| `payout.failed` | Clinic payout failed |
| `charge.dispute.created` | Records a dispute against a deposit |
| `account.updated` | Refreshes a clinic's capability status (v1 accounts) |

If `STRIPE_ACCOUNTS_API=v2`, also subscribe to
`v2.core.account[configuration.recipient].updated` — the Worker matches any
`v2.core.account*` type by prefix, because the bracketed part moves during the
preview.

Then **Reveal** the signing secret (`whsec_…`) and put it in
`STRIPE_WEBHOOK_SECRET`. Until you do, the Worker refuses every event. That is
the correct failure: an endpoint that accepts unsigned events is a public URL
that marks deposits paid.

### 5. Onboard the clinics

Platform console → a workspace → **Stripe Connect** → **Start embedded
onboarding**. The clinic completes Stripe's form inside the console. The panel
then shows whether it can receive transfers, and what Stripe is still waiting
for if it cannot.

Until a clinic finishes, deposits are still collected — Tími is the merchant of
record — and that clinic's share accumulates in the platform balance while the
settlement sweep retries. Nothing is lost, but nothing is paid either, and the
Connect panel is the only place that says so.

### 6. Payout schedule (optional)

<https://dashboard.stripe.com/settings/connect/payouts>

Connected accounts pay out daily by default. Consider a delay if you want a
window in which to reverse a transfer made against a disputed visit.

---

## Testing

```bash
npm run check          # includes scripts/stripe-test.mjs — no network, no keys
node scripts/stripe-test.mjs
```

The tests stub `globalThis.fetch`, so the assertions are about what we *sent* —
the idempotency key, the transfer amount, the absence of an application fee —
not only about what we did with a reply.

### End to end against Stripe test mode

1. Put test keys (`sk_test_…`, `pk_test_…`) in `.env`, run `scripts/bootstrap.sh`.
2. Forward webhooks to a local Worker:
   ```bash
   stripe listen --forward-to http://127.0.0.1:8787/api/stripe/webhook
   ```
   Use the `whsec_…` that command prints, **not** the dashboard endpoint's — they
   are different secrets and verification fails with the wrong one.
3. Create a test connected account from the platform console and complete
   onboarding with Stripe's test values (SSN `000-00-0000`, DOB `01/01/1901`,
   routing `110000000`, account `000123456789`).

### Test cards

| Number | What happens |
| --- | --- |
| `4242 4242 4242 4242` | Succeeds. The ordinary path |
| `4000 0025 0000 3155` | Requires 3D Secure authentication |
| `4000 0000 0000 9995` | Declined — insufficient funds |
| `4000 0000 0000 0002` | Declined — generic |
| `4000 0000 0000 0259` | Succeeds, then a dispute is created |

Any future expiry, any CVC, any postcode.

### Test-mode payouts

Connected-account balances in test mode do not pay out on their own. Trigger one
with `stripe payouts create --amount=3000 --currency=usd --stripe-account
acct_…`, or `stripe trigger payout.paid`, to see the clinic-payout rows appear
in the ledger and in the clinic console.

---

## Where things fail, and what it looks like

| Symptom | Cause |
| --- | --- |
| Every webhook 400s, deposits charged but never marked paid | `STRIPE_WEBHOOK_SECRET` is the wrong endpoint's secret, or the CLI's when a dashboard endpoint is sending |
| "No such payment_intent" when the customer presses pay | Secret and publishable keys are different modes. Step 4c of bootstrap catches this |
| Clinic never paid; intakes stay unsettled | Connected account cannot receive transfers. Platform console → the workspace → Stripe Connect |
| Connected-account creation 400s with nothing useful | Negative-balance responsibility not accepted on the platform profile (dashboard step 1) |
| Payout rows never appear in the ledger | The webhook endpoint is not listening to events on connected accounts (dashboard step 4) |
| Transfer fails with "insufficient available funds" | `source_transaction` is missing. A build guard checks for it |

---

## Deliberately not built

- **Automatic reconciliation.** `payment_ledger.reconciled` is set by an
  operator pressing a button, with their user id recorded beside it. Matching
  against Stripe's payout reports on a schedule is real work, and a flag that
  claims rows were checked when nobody checked them is a lie the ledger would
  then be built on.
- **Stripe on Android.** The Worker side is surface-agnostic and complete;
  `apps/customer-mobile/Sources/TimiNowUI/DepositView.swift` carries a
  `TODO(android-stripe)` naming exactly what remains.
- **Disputes beyond recording them.** `charge.dispute.created` writes a ledger
  row. Responding to a dispute is done in the Stripe dashboard.
- **Transfer reversals.** Recorded when they happen, never initiated by Tími.
  The transfer amount is sized from the outcome, so there is nothing to claw
  back that should not have gone out.
