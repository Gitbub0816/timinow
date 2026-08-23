# Tími NOW legal launch checklist

Product copy and acceptance points are implemented in `public/index.html`. This file is an operational checklist, not legal advice. Have California counsel review the public terms and clinic agreement before live transactions.

## Implemented in the MVP

- A versioned Terms, Privacy/Notice at Collection, Veterinary Safety, Deposit/Refund, Clinic Participation, and Accessibility legal center.
- Separate, unchecked acceptance for the current terms/safety notice and transactional contact consent.
- Server-side enforcement of legal version `2026-08-22` (`LEGAL_VERSION` in `src/catalog.js`, served on `/api/config`); the acceptance version and timestamp are written into the intake event audit trail.
- A non-diagnostic boundary: Tími routes structured intake and never claims to diagnose, treat, prescribe, clinically triage, establish a VCPR, or guarantee an appointment.
- Capacity source/age disclosure and a warning that critical patients can change waits and order.
- Clinic-specific deposit policy disclosure before a request, repeated terms before payment, and a stored policy snapshot.
- Privacy disclosure for contact, pet-concern, location, device/security, payment-status, and clinic organization data.
- California privacy request contact and Global Privacy Control commitment; no sale or cross-context behavioral advertising.
- Clinic responsibilities for licensure, independent medical judgment, accurate capacity, data handling, billing, and Stripe onboarding.
- Scope-of-practice disclosure for providers staffed by a veterinary technician rather than a veterinarian. The flag is set by a platform operator at onboarding (never self-declared), stored on the location, and rendered from one server-composed string (`TECHNICIAN_NOTICE` in `src/catalog.js`) so no client can reword it. It states that a technician works under veterinarian supervision and may not diagnose, prognose, prescribe, or perform surgery, and that the label is not a verification of any individual's credential or licence status.
- Optional owner-recorded medications and allergies, with a notice that they are unverified, are not a medical record, come from no veterinarian, are shared with every clinic a request reaches, and do not replace the treating clinic's own history-taking. The intake screen names them specifically when a profile has them, rather than covering them under "your structured intake".

## Required before accepting real deposits

0. Have counsel review the two notices added in version `2026-08-22`: the veterinary-technician scope-of-practice disclosure and the owner-recorded medications/allergies notice. State practice acts differ on what a technician may do and on how a non-veterinarian provider may be advertised, so the wording and the labelling obligation are worth a specific read in every state Tími lists providers in.


1. Confirm the operating company name, address, support emails, and any registered DBA/trademark.
2. Have counsel approve the consumer Terms, Privacy Policy, deposit/refund language, limitation of liability, governing law, and clinic master services agreement.
3. Select the final Stripe Connect charge model. Use Stripe-hosted or embedded onboarding and incorporate the applicable Stripe Connected Account Agreement and Privacy Policy disclosures.
4. Configure a privacy-request workflow, identity verification, deletion exceptions, retention periods, vendor list, and incident response plan.
5. Execute data-processing/security terms with Cloudflare, Clerk, Stripe, communications providers, and analytics vendors.
6. Decide whether any marketing SMS/email will exist. Keep marketing consent separate from operational intake updates and implement STOP/unsubscribe handling before sending marketing.
7. Validate accessibility with keyboard, screen-reader, contrast, zoom, and reduced-motion testing; publish a supported contact path.
8. Verify each participating clinic and location, its licensing/ownership information, emergency capabilities, hours, insurance/billing practices, and authorized policy administrator.
9. Obtain insurance appropriate for a software platform handling veterinary intake and customer deposits; counsel and broker should assess technology E&O, cyber, general liability, and crime/funds-transfer coverage.
10. Create change-control: every legal revision receives a version and effective date, material changes trigger renewed acceptance, and policy snapshots remain immutable.

## Product guardrails

- Never label the deterministic description guard as diagnosis, triage, severity scoring, or medical advice.
- Never represent reported capacity or wait as guaranteed.
- Do not use pet-concern or precise-location data for advertising.
- Do not claim HIPAA compliance or imply animal records are HIPAA-protected health information.
- Do not let a clinic user access an intake outside its tenant or selected location.
- Do not initiate a deposit until a clinic accepts and the customer sees the exact policy snapshot.

## Primary references reviewed

- California Veterinary Medical Board, AB 1399 telehealth/VCPR FAQs: https://www.vmb.ca.gov/licensees/ab1399_faqs.shtml
- California Attorney General, CCPA overview: https://oag.ca.gov/privacy/ccpa
- California Attorney General, Global Privacy Control: https://oag.ca.gov/privacy/ccpa/gpc
- Stripe Connect service-agreement acceptance and privacy disclosures: https://docs.stripe.com/connect/updating-service-agreements
- Stripe Connect platform overview: https://docs.stripe.com/connect
