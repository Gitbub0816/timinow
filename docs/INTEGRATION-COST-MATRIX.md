# Veterinary integration cost matrix

## Launch answer

Tími does **not** need a paid PIMS integration to launch. The initial integration-partner budget is **$0**.

The launch product uses a manual live-capacity bridge:

1. A clinic publishes its current intake state, stable-patient wait range, and short-lived capacity count.
2. The report expires automatically unless the clinic renews it.
3. A customer sends a specific immediate-intake request.
4. The clinic accepts or declines and, when accepted, gives the customer an arrival window.
5. Tími applies the clinic's tenant-specific deposit policy and reconciles payments monthly.

This requires no appointment calendar and no PIMS write access. It also creates the clinic relationships and real intake volume needed to qualify for later commercial partner programs.

## What the public evidence actually supports

There are no justified large vendor-fee estimates to include in the MVP budget. Where a vendor does not publish a price, the correct answer is **quote required**, not an invented contingency.

| Provider/path | Public commercial fact | Required for launch? | Known vendor fee |
| --- | --- | --- | ---: |
| Manual live-capacity bridge | No PIMS or partner dependency | Yes | **$0** |
| Digitail | Its partner FAQ says becoming a partner has no cost; integration still requires mutual technical work | No | **$0 partner fee stated publicly** |
| Provet | Promotes an open, documented API and says it has no approval gate | No | **No separate fee identified publicly** |
| Shepherd | Promotes open API access | No | **No separate fee identified publicly** |
| ezyVet commercial partner | ezyVet says it provides the technical connection at no cost and practices are not charged to enable or use commercial integrations; approval, certification, pilot sites, and possible paid consultation still apply | No | **Connection described as free; other agreement-specific costs unknown** |
| ezyVet private/custom integration | A different route for a customer-specific integration; ezyVet states setup and write-access fees apply | No | **Quote required** |
| DaySmart Vet | Public API and sandbox exist; its terms place any applicable fees in a separate agreement | No | **Quote required** |
| IDEXX Neo / Cornerstone | Partner/request process exists; no public rate card was found | No | **Quote required** |
| Covetrus Connect: AVImark, ImproMed, Pulse | Supported partner route exists; no public rate card was found | No | **Quote required** |
| Bitwerx or similar middleware | Optional integration service, not a launch dependency | No | **Quote required** |

## Bootstrapped launch budget

| Cost | Launch expectation |
| --- | ---: |
| PIMS partner/setup fees | **$0** |
| Stripe account/setup | **$0** on standard pricing |
| Stripe Payments and Connect | Usage-based when money moves; exact Connect charges depend on which party controls pricing |
| Hosting | Free or low-cost tier initially |
| Email | Free or low-cost tier initially |
| SMS | Optional; usage-based |
| Integration engineering | Internal product work only; no vendor integration is required for the pilot |

Do not book any closed-partner fee into the MVP budget until Tími has a written quote. Do not build a paid connector until pilot clinics and booking volume justify it.

## Expansion sequence

1. Launch the manual bridge with 3–10 founding clinics.
2. Measure capacity freshness, accepted intakes, response time, completed visits, staff handling time, no-shows, and revenue.
3. Use those results and clinic references to apply to the most relevant PIMS partner program.
4. Prefer a documented open API or a commercial connection with no vendor fee.
5. Add IDEXX, Covetrus, DaySmart, or middleware only when a signed clinic cohort pays for the added coverage.

Before accepting any paid integration agreement, request written answers covering setup, sandbox, certification, re-certification, per-location access, API volume, revenue share, minimum commitments, clinic enablement, security requirements, support obligations, termination, and data portability.

## Public evidence

- [Digitail partner FAQ](https://digitail.com/digitail-partners/)
- [Provet open API explanation](https://www.provet.cloud/blog/veterinary-software-open-api)
- [Shepherd open API explanation](https://www.shepherd.vet/blog/open-api-access-in-veterinary-software-what-does-it-mean-for-your-practice/)
- [ezyVet integration cost FAQ](https://www.ezyvet.com/blog/faqs-about-ezyvet-integrations)
- [ezyVet private/custom integration](https://www.ezyvet.com/build-a-custom-integration)
- [ezyVet commercial onboarding](https://developers.ezyvet.com/apply/commercial.html)
- [DaySmart Vet API documentation and terms](https://sandbox.vettersoftware.com/docs/)
- [IDEXX integration request](https://www.idexx.com/en/veterinary/software-services/idexx-practice-management-software-integration-request-form/)
- [Covetrus Connect partner program](https://covetrus.com/covetrus-platform/workflow-and-productivity-tools/technology-integration-hub/)
- [Bitwerx](https://www.bitwerx.com/)
