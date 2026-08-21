# Tími payment and tenant policy specification

## Commercial baseline

Tími collects a clinic-defined arrival deposit only after the clinic accepts an immediate intake request.

| Outcome | Customer treatment | Baseline Tími fee | Clinic allocation before processing |
| --- | --- | ---: | ---: |
| Completed visit | Full deposit credited to veterinary invoice | $20 | Deposit less $20 |
| Timely cancellation before departure | Full deposit refund | $0 | $0 |
| Clinic declines or request expires | No capture | $0 | $0 |
| Clinic cancels acceptance | Full refund | $0 | $0 |
| Late cancellation after committing to travel | Tenant policy applies | $5 | Remaining deposit less $5 |
| No-show or missed arrival window | Tenant policy applies | $5 | Remaining deposit less $5 |

The baseline deposit is **$50**, but every amount, refund deadline, and consequence is tenant-specific and versioned. Emergency hospitals may use a different deposit, including a fully non-refundable policy where lawful and clearly disclosed.

## Accounting invariants

1. A customer deposit is a credit toward the clinic’s veterinary invoice, not a customer-facing Tími booking fee.
2. The full advertised deposit credit is applied to the clinic invoice even when the clinic’s cash settlement is net of Tími and payment-processing fees.
3. Tími’s fee is business-to-business and must not be represented as treatment or an insurance-eligible charge.
4. No payment UI is rendered for a no-deposit tenant.
5. Every intake stores the exact policy snapshot accepted by the customer.
6. No deposit is collected before the clinic accepts the intake.
7. Tími earns the completed-visit fee only from a documented final outcome.

## Current policy shape

```json
{
  "policyId": "policy_hearth_v1",
  "tenantId": "tenant_hearth",
  "version": 1,
  "currency": "usd",
  "depositRequired": true,
  "depositAmountCents": 5000,
  "creditToClinicInvoiceCents": 5000,
  "depositRefundable": true,
  "freeCancelMinutes": 30,
  "completedPlatformFeeCents": 2000,
  "lateCancelPlatformFeeCents": 500,
  "noShowPlatformFeeCents": 500,
  "captureTiming": "after_clinic_acceptance"
}
```

The database supports one active version per tenant and stores its JSON snapshot on each intake. Future overrides may be resolved by location, urgency, species, new/existing client, or facility type before snapshotting.

## Intake and payment states

The operational intake state machine is documented in `MVP-ARCHITECTURE.md`. Payment state is separate:

`not_required | pending | requires_action | processing | paid | refunded | failed`

- A pending intake has no captured deposit.
- Acceptance moves a deposit-required intake into payment pending.
- Stripe Payment Element confirms the PaymentIntent.
- The Worker retrieves Stripe’s current status before recording paid.
- A decline or expiry never creates a PaymentIntent.

## Customer disclosure

Before payment, show:

- Amount due now
- Exact credit toward the clinic invoice
- Refund or non-refund rule
- Cancellation and missed-arrival consequences
- Clinic responsible for veterinary services
- Arrival-window expiration
- Accepted policy version

“Non-refundable” must appear adjacent to the amount and action. It cannot be hidden in linked terms.

## Monthly reconciliation

The clinic ledger should distinguish:

- Gross arrival deposits
- Customer credit liability
- Completed-visit Tími fees
- Late-cancellation and no-show fees
- Processing fees
- Refunds and disputes
- Subscription charges
- Net monthly payout or amount due

The MVP stores the necessary intake, policy, deposit, and outcome states. Automated monthly transfers and formal statements are the next accounting module and require legal/accounting review before live funds are enabled.

## Tenant administration requirements

- Begin with the Tími baseline or create a stricter or looser policy.
- Preview exact customer language before activation.
- Require an additional confirmation for non-refundable changes.
- Version every effective policy.
- Never apply a new policy to an accepted intake.
- Maintain an exportable audit of policy, payment, refund, outcome, actor, and timestamp.
