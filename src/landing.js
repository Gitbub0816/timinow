/**
 * The pages a search is actually looking for.
 *
 * The customer app routes on the hash — `#emergency`, `#vets`,
 * `#paw-it-forward`. That is fine for an app and fatal for a search engine: a
 * fragment is not a URL, so every one of those screens is `https://timinow.pet/`
 * as far as any crawler is concerned. One document, one title, one
 * description, competing with itself for every query the product could answer.
 *
 * These are real URLs with real documents behind them, one per question
 * somebody actually types. They are deliberately NOT the app: no app.js, no
 * router, no hydration. A marketing page that boots a single-page application
 * in order to show a paragraph is slower, flickers on arrival, and fights its
 * own router over which screen is showing. These load as HTML and link into
 * the app where the app is the point.
 *
 * ── The rules for writing one ────────────────────────────────────────────
 *
 * Every claim here has to be true of the product as it exists, checked
 * against the code or the legal centre, not against how it would be nice to
 * describe it. This site tells people where to take a sick animal; a page
 * that oversells it is not a marketing problem, it is a safety one. In
 * particular:
 *
 *   - No coverage claim beyond "the clinics that have joined". The network is
 *     where it is, and a page implying national coverage sends somebody
 *     driving toward a search that will come back empty.
 *   - No clinical guidance that could substitute for a veterinarian. The
 *     emergency page below says what an emergency hospital says: if you are
 *     asking, go. It does not triage.
 *   - Fees are the fees in src/pricing.js and the Service Fee article. If
 *     those change, these change — scripts/seo-test.mjs asserts the numbers
 *     on the page match the pricing module.
 *
 * Answer-engine shaped, deliberately: each page carries visible questions and
 * answers that are also FAQPage JSON-LD, and each answer stands alone,
 * because it will be read without the page around it.
 */

import { escapeHtml } from "./markdown.js";
import { FALLBACK_PRICING } from "./pricing.js";
import {
  SITE,
  breadcrumbSchema,
  canonicalUrl,
  faqSchema,
  graph,
  headTags,
  organizationSchema,
  websiteSchema
} from "./seo.js";

const money = (cents) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** The numbers, from the one module that owns them. */
const OWNER_FEE = money(FALLBACK_PRICING.ownerFeeCents);
const CLINIC_FEE = money(FALLBACK_PRICING.clinicFeeCents);

/**
 * The service, as a machine-readable thing rather than a paragraph.
 *
 * `Service` and not `LocalBusiness`: Tími is not a place anybody visits, and
 * claiming to be a local business with an address people could drive to would
 * be a lie that also happens to be the kind search engines penalise.
 */
function serviceSchema() {
  return {
    "@type": "Service",
    "@id": `${SITE.customerOrigin}/#service`,
    name: "Tími NOW veterinary intake",
    serviceType: "Veterinary intake and capacity routing",
    description: SITE.description,
    provider: { "@id": `${SITE.customerOrigin}/#organization` },
    areaServed: { "@type": "State", name: "California" },
    audience: { "@type": "Audience", audienceType: "Pet owners" },
    offers: {
      "@type": "Offer",
      description: `Searching is free. ${OWNER_FEE} is charged to the pet owner only when a booking completes.`,
      price: String(FALLBACK_PRICING.ownerFeeCents / 100),
      priceCurrency: "USD"
    }
  };
}

/* ──────────────────────────────────────────────────────────── template ── */

const NAV = [
  { href: "/emergency-vet", label: "Emergency care" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/help-with-vet-bills", label: "Help with bills" },
  { href: "/for-veterinarians", label: "For clinics" }
];

/**
 * One standalone document.
 *
 * Shares `/styles.css` with the app so these cannot drift into looking like a
 * different company, and carries the app's header and footer markup rather
 * than the app itself.
 */
function document_({ path, title, description, h1, lede, sections, faq = [], crumbs = [], extraSchema = [] }) {
  const canonical = canonicalUrl(SITE.customerOrigin, path);
  const head = headTags({ title, description, canonical, type: "website" }) + "\n  " + graph([
    organizationSchema(),
    websiteSchema(),
    serviceSchema(),
    faq.length ? faqSchema(faq) : null,
    crumbs.length ? breadcrumbSchema(crumbs) : null,
    {
      "@type": "WebPage",
      "@id": `${canonical}#page`,
      url: canonical,
      name: title,
      description,
      isPartOf: { "@id": `${SITE.customerOrigin}/#website` },
      about: { "@id": `${SITE.customerOrigin}/#service` },
      inLanguage: "en-US"
    }
  ]);

  const faqMarkup = faq.length
    ? [
        `<section class="landing-faq" aria-labelledby="faq-title">`,
        `<h2 id="faq-title">Questions people ask</h2>`,
        ...faq.map((entry) => [
          `<details>`,
          `<summary><h3>${escapeHtml(entry.question)}</h3></summary>`,
          `<p>${escapeHtml(entry.answer)}</p>`,
          `</details>`
        ].join("")),
        `</section>`
      ].join("\n")
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#2357d9">
  <link rel="icon" href="/assets/icons/icon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png" sizes="180x180">
  <link rel="stylesheet" href="/styles.css">
  ${head}
</head>
<body class="landing-body">
  <a class="skip-link" href="#main">Skip to content</a>

  <header class="site-header">
    <a class="brand" href="/" aria-label="Tími NOW home"><img src="/assets/brand/timinow-wordmark.png" alt="Tími NOW" width="214" height="74"></a>
    <nav aria-label="Primary navigation">
      ${NAV.map((item) => `<a href="${item.href}">${escapeHtml(item.label)}</a>`).join("\n      ")}
    </nav>
    <div class="header-actions">
      <a class="button button-small button-dark" href="/#find">Find care now <span aria-hidden="true">→</span></a>
    </div>
  </header>

  <main id="main" class="landing-main">
    <article>
      <h1>${escapeHtml(h1)}</h1>
      <p class="hero-lede">${escapeHtml(lede)}</p>
      <p><a class="button button-primary" href="/#find">See who can take your pet now <span aria-hidden="true">→</span></a></p>
      ${sections}
      ${faqMarkup}
    </article>
  </main>

  <footer class="site-footer">
    <p>© ${new Date().getUTCFullYear()} ClearKey Solutions, LLC · Tími NOW · Hayward, California</p>
    <nav aria-label="More">
      <a href="/">Home</a>
      ${NAV.map((item) => `<a href="${item.href}">${escapeHtml(item.label)}</a>`).join("\n      ")}
      <a href="https://blog.timinow.pet/">Notes</a>
      <a href="https://blog.timinow.pet/forum">Community</a>
      <a href="/#legal">Legal centre</a>
    </nav>
  </footer>
</body>
</html>
`;
}

/* ───────────────────────────────────────────────────────────── the pages ── */

const HOME_CRUMB = { name: "Tími NOW", url: `${SITE.customerOrigin}/` };

/**
 * The page for the query this product exists to answer, typed at midnight by
 * somebody who is frightened.
 *
 * It opens by telling them to stop reading and go if it is bad, because that
 * is the honest ordering and because a page that buries it under a product
 * pitch deserves whatever happens next.
 */
function emergencyVet() {
  const faq = [
    {
      question: "How do I find an emergency vet that is open right now?",
      answer: "Search Tími NOW from wherever you are. Clinics on Tími report whether they can take another patient, and every result shows the time that clinic last reported it, so you can tell a live answer from a stale one. Searching is free and needs no account."
    },
    {
      question: "Is my pet's problem an emergency?",
      answer: "If you are asking the question, treat it as one and call a veterinarian. Trouble breathing, collapse, seizures, a distended or painful abdomen, bleeding that does not stop, straining to urinate without producing urine, suspected poisoning, bloat in a deep-chested dog, or a hit by a car are all reasons to go now rather than wait for morning. Tími NOW is not a veterinarian and does not triage; it tells you who can see your pet."
    },
    {
      question: "Does Tími NOW guarantee my pet will be seen at a particular time?",
      answer: "No. An availability report is a clinic saying it can take another patient at that moment, not an appointment and not a place in a queue. Emergency hospitals triage every arrival independently and will always see the most critical patient first, including ahead of someone who arrived earlier."
    },
    {
      question: "What does it cost to use Tími NOW in an emergency?",
      answer: `Searching and comparing clinics is free. Tími charges the pet owner ${OWNER_FEE} only when a booking completes, and that is a platform fee rather than a veterinary charge — it is never billed to insurance. Any deposit and all veterinary charges are set by the clinic and disclosed before you pay.`
    },
    {
      question: "Can I just call the clinic myself?",
      answer: "Yes, and you should if you prefer. What Tími adds is knowing which clinics can take a patient before you start dialling, and telling the clinic you are coming so the front desk is not hearing it for the first time when you walk in."
    }
  ];

  const sections = `
    <section>
      <h2>If it looks bad, go now</h2>
      <p>Trouble breathing, collapse, a seizure that does not stop, a swollen hard belly, bleeding that will not clot, straining to urinate with nothing coming out, a suspected toxin, or anything after a car — those are reasons to be in a car, not reading a website. Call the nearest emergency hospital on the way so they know what is arriving.</p>
      <p>Tími NOW is not a veterinarian, does not diagnose, and does not decide how urgent your pet is. It answers a narrower question, which is the one that wastes the most time at 1am: <strong>who near me can actually take a patient right now?</strong></p>
    </section>

    <section>
      <h2>What "available" means here</h2>
      <p>Most listings tell you a clinic's opening hours. Opening hours do not tell you whether a hospital is three hours deep in a backlog with every table full. Clinics on Tími report their intake capacity directly — whether they can take another patient, roughly how long a stable patient is waiting, and whether they are taking critical cases — and every result carries the timestamp of that report.</p>
      <p>That timestamp is the part worth trusting. A report from four minutes ago is worth something. One from yesterday is worth nothing, and Tími shows you which you are looking at rather than averaging them into a number that hides it.</p>
    </section>

    <section>
      <h2>What happens after you pick one</h2>
      <ol>
        <li>You describe what is going on with your pet, in your own words.</li>
        <li>Your request goes out to matching clinics nearby that are taking patients.</li>
        <li>Clinics that can see your pet respond, and you compare up to five real offers side by side.</li>
        <li>You choose one. Only that clinic gets your details; every other offer is released automatically.</li>
        <li>The clinic knows you are coming, and what for, before you arrive.</li>
      </ol>
      <p>If a clinic requires an arrival deposit, the amount, the cancellation window and the refund rule are shown before you authorise anything, and the deposit is credited against that clinic's own invoice.</p>
    </section>

    <section>
      <h2>Where Tími NOW works</h2>
      <p>Tími is only useful where clinics have joined it, and it will tell you plainly when a search finds nobody nearby rather than padding the list with hospitals that never answered. The network is growing out of California, where ClearKey Solutions is based. If your local emergency hospital is not on it yet, <a href="/for-veterinarians">that page is for them</a>.</p>
    </section>
  `;

  return document_({
    path: "/emergency-vet",
    title: "Emergency vet near you, open and taking patients now | Tími NOW",
    description: "See which emergency veterinary hospitals near you have said they can take another patient right now, with the time each clinic reported it. Free to search.",
    h1: "Find an emergency vet that can actually take your pet",
    lede: "Opening hours do not tell you whether a hospital is full. Clinics on Tími NOW report whether they can take another patient, and every result shows when they said it.",
    sections,
    faq,
    crumbs: [HOME_CRUMB, { name: "Emergency care", url: `${SITE.customerOrigin}/emergency-vet` }]
  });
}

function howItWorks() {
  const faq = [
    {
      question: "How does Tími NOW work?",
      answer: "You describe your pet's problem once. Tími sends that structured request to matching clinics nearby that have reported they can take a patient, collects up to five real offers, and lets you pick one. The clinic you choose receives your details and knows you are coming; the others are released automatically."
    },
    {
      question: "Do I need an account to search?",
      answer: "No. Searching and comparing clinics needs no account. An account is only involved when you confirm a booking, so the clinic has someone to expect and you have a record of it."
    },
    {
      question: "How current is the availability Tími shows?",
      answer: "Every clinic's report carries the time it was made, and Tími displays that time rather than hiding it. Reports expire: a clinic that has not updated its status stops being shown as available rather than being presented as though it had."
    },
    {
      question: "Is Tími NOW a veterinary practice?",
      answer: "No. Tími NOW is operated by ClearKey Solutions, LLC and is not a clinic, a veterinarian, an insurer or an emergency medical service. Every participating clinic is an independent practice responsible for its own licensing, triage, treatment and billing."
    },
    {
      question: "What does Tími NOW cost a pet owner?",
      answer: `Searching is free. ${OWNER_FEE} is charged to the pet owner when a booking completes, disclosed and itemised before payment. It is a platform fee for routing the intake, not a veterinary charge, and it is never billed to insurance. A request that is declined, that expires, or that you cancel costs nothing.`
    }
  ];

  const sections = `
    <section>
      <h2>One description, sent to the clinics that can act on it</h2>
      <p>The usual version of this evening is a phone tree: call, hold, describe the problem, be told they are full, call the next one, describe it again. Tími takes the description once and puts it in front of the clinics nearby that have said they are taking patients.</p>
      <p>What a clinic receives is structured rather than a paragraph: species, the concern in your words, whether it is an emergency, any medications and allergies you chose to record, and how far away you are. That is what lets a front desk answer in seconds instead of asking you to start over.</p>
    </section>

    <section>
      <h2>Up to five offers, side by side, all of them live</h2>
      <p>Offers arrive from clinics that can take the patient. Each one holds for a displayed period, and you compare them on the things that matter at that moment — distance, current wait for a stable patient, whether they take critical cases, and any deposit the clinic requires.</p>
      <p>Choosing one releases all the others in the same action, so a clinic you did not choose is not holding space for a patient who is not coming. That single detail is why clinics are willing to answer honestly rather than defensively.</p>
    </section>

    <section>
      <h2>Then you drive, and they know</h2>
      <p>The clinic you selected receives the intake and your contact details. Turn-by-turn directions are available in the app, and a live arrival estimate is sent to the clinic's console while you are on the way, so the front desk knows whether you are five minutes out or twenty-five.</p>
      <p>Nothing about this is a promise of examination time. Emergency hospitals triage, and a critical patient arriving after you will be seen before you. Tími says so on the offer screen rather than in a footnote.</p>
    </section>

    <section>
      <h2>What Tími never does</h2>
      <ul>
        <li>It does not diagnose, triage, or tell you whether your pet is fine.</li>
        <li>It does not sell or share personal information for advertising, and it uses no third-party analytics — see the <a href="/#legal">privacy policy</a>.</li>
        <li>It does not bill insurance, and its fee is never part of a veterinary invoice.</li>
        <li>It does not show a clinic as available on the strength of a report too old to mean anything.</li>
      </ul>
    </section>
  `;

  return document_({
    path: "/how-it-works",
    title: "How Tími NOW works — describe it once, compare real offers | Tími NOW",
    description: "Describe your pet's problem once. Clinics nearby that can take a patient respond, you compare up to five live offers, and the one you pick knows you are coming.",
    h1: "How Tími NOW works",
    lede: "Describe the problem once. Clinics that can actually take your pet answer, you pick one, and every other offer is released in the same moment.",
    sections,
    faq,
    crumbs: [HOME_CRUMB, { name: "How it works", url: `${SITE.customerOrigin}/how-it-works` }]
  });
}

/**
 * The page for "I cannot afford the vet", which is one of the most-searched
 * and worst-served questions in this whole subject area.
 *
 * Written under the constraint the legal centre sets: the Fund is a
 * discretionary corporate assistance programme that covers Tími's own access
 * fee, it is not a charity, contributions are not deductible, and it does not
 * pay for treatment. Saying any of that loosely would be both a lie and, per
 * California's charitable-solicitation law, a considerably more expensive
 * kind of mistake. So the page says what the Fund does and is explicit about
 * the much larger thing it does not do.
 */
function helpWithVetBills() {
  const faq = [
    {
      question: "Does Paw It Forward pay my vet bill?",
      answer: "No, and it is important not to misread that. The Paw It Forward Fund covers Tími NOW's own access fee for people whose financial hardship has been verified. It does not pay for veterinary treatment, medication, or a clinic's deposit — those remain between you and the clinic."
    },
    {
      question: "What can I do if I cannot afford emergency veterinary care?",
      answer: "Tell the clinic before treatment starts. Many practices have payment plans, will treat in stages, or can prioritise stabilising care while costs are discussed, and they can only offer that if they know. Ask about CareCredit and similar medical-credit options, ask whether a nearby teaching hospital or humane society clinic has a reduced-cost service, and ask the clinic directly what the least-cost path to a diagnosis looks like. A clinic told about a budget early behaves very differently from one told at checkout."
    },
    {
      question: "Is a contribution to Paw It Forward tax-deductible?",
      answer: "No. Tími NOW is operated by ClearKey Solutions, LLC, a for-profit company that claims no tax-exempt status and is not a registered charity. A contribution is voluntary, is pooled rather than directed to any named recipient, and produces an ordinary payment receipt rather than a charitable-gift receipt."
    },
    {
      question: "How is eligibility for Paw It Forward decided?",
      answer: "By applying published, versioned rules to evidence an applicant submits, not by anyone's judgement of the applicant. A clinic is never told an applicant's income, benefit type, stated reason, or documentation — only that a booking is sponsored and that its own referral fee for that booking is zero."
    },
    {
      question: "Does contributing get my own pet seen faster?",
      answer: "No. A contribution is never a condition of booking or of being matched, buys no priority, and cannot be directed to a particular pet, person or clinic."
    }
  ];

  const sections = `
    <section>
      <h2>First, the honest part</h2>
      <p>If your pet needs care and the money is not there, the most useful thing on this page is not our fund. It is this: <strong>tell the clinic before treatment starts.</strong> Practices have options they can only offer if they know — staged treatment, payment plans, medical credit, a cheaper route to the same diagnosis — and almost none of them are available once the invoice exists.</p>
      <p>Ask, in these words: what is the least expensive way to find out what is wrong? A veterinary team asked that question at the start will usually answer it properly.</p>
    </section>

    <section>
      <h2>What the Paw It Forward Fund actually covers</h2>
      <p>Paw It Forward covers <em>Tími NOW's own access fee</em> — the ${OWNER_FEE} a pet owner would otherwise pay on a completed booking — for people whose financial hardship has been verified under published rules. On a sponsored booking the owner pays Tími nothing and the clinic's referral fee is zero.</p>
      <p>It does not pay for veterinary treatment, medication, or a clinic's deposit, and we will not imply otherwise. Removing our fee is a small thing next to a hospital bill. It is the thing we control, so it is the thing we give away.</p>
      <p>The fund is a discretionary corporate assistance programme run by ClearKey Solutions, LLC. It is not a charity, contributions to it are not tax-deductible, and they are pooled rather than directed at anyone in particular. The full terms are in the <a href="/#legal">Paw It Forward Program Terms</a>.</p>
    </section>

    <section>
      <h2>Contributing</h2>
      <p>A contribution is optional, never added by default, itemised separately before you authorise a payment, and never a condition of anything. Only completed, reconciled bookings are counted as visits funded — money reserved for a booking that was cancelled goes back into the fund rather than into a statistic.</p>
    </section>
  `;

  return document_({
    path: "/help-with-vet-bills",
    title: "Help with vet bills: what to ask, and what Paw It Forward covers | Tími NOW",
    description: "What to say to a clinic when you cannot afford treatment, and exactly what the Paw It Forward Fund does and does not cover. It covers Tími's access fee, not veterinary bills.",
    h1: "When you cannot afford the vet",
    lede: "Tell the clinic before treatment starts — that is the sentence that changes the most. Here is what else is available, including what our own fund does and, more importantly, does not cover.",
    sections,
    faq,
    crumbs: [HOME_CRUMB, { name: "Help with vet bills", url: `${SITE.customerOrigin}/help-with-vet-bills` }]
  });
}

function forVeterinarians() {
  const faq = [
    {
      question: "What does Tími NOW cost a veterinary practice?",
      answer: `${CLINIC_FEE} per completed connection, invoiced monthly. No subscription, no listing fee, and nothing at all for a request the practice declines or lets expire. Founding clinics pay nothing while they remain participating and in good standing.`
    },
    {
      question: "Does joining Tími commit a clinic to accepting patients?",
      answer: "No. A clinic reports capacity when it has capacity and declines or ignores anything else. An availability response is a temporary operational offer valid for the hold period shown, not a booking obligation, and it reserves no priority in that clinic's own triage."
    },
    {
      question: "How does a clinic report availability?",
      answer: "From a console on the web, macOS or Windows, or from a shared front-desk workstation session that needs no individual login. Reporting status is two taps: whether you can take another patient, and roughly what a stable patient is waiting. Reports expire on their own, so a forgotten status quietly stops showing rather than sending you patients you cannot see."
    },
    {
      question: "Who owns the client relationship and the payment?",
      answer: "The clinic. Deposits and every veterinary charge are the clinic's own, billed by the clinic under its own policy, which Tími discloses to the owner before they pay. Tími's fee is a separate platform charge that forms no part of a veterinary invoice and is never submitted to an insurer."
    },
    {
      question: "Can a clinic staffed by a veterinary technician participate?",
      answer: "Yes, with disclosure. A practice staffed by a registered, licensed or certified veterinary technician rather than a veterinarian must say so at onboarding and keep that current, and remains responsible for operating within the scope of practice its state's veterinary practice act permits. Tími surfaces that disclosure to pet owners rather than obscuring it."
    }
  ];

  const sections = `
    <section>
      <h2>The problem this solves for a front desk</h2>
      <p>Two versions of a bad evening. In the first, the phone rings continuously with cases you cannot take, and each call costs ninety seconds you do not have. In the second, you turned patients away at eight and had two empty tables at ten, because nobody knew the backlog had cleared.</p>
      <p>Tími is a capacity signal in both directions. You say what you can take, for as long as that stays true, and the requests that reach you are the ones you said yes to being asked about.</p>
    </section>

    <section>
      <h2>What a request looks like when it arrives</h2>
      <p>Structured, not a voicemail: species, the owner's description of the concern, emergency flag, any medications and allergies the owner recorded, distance and travel time. Your team accepts, declines, or offers — and an accepted request shows as <em>Offered</em> until the owner confirms and pays, then as <em>Accepted</em>, so nobody on the floor has to guess whether a patient is actually coming.</p>
      <p>Once they are on the road, the console shows a live arrival estimate that updates as they travel, including when they miss a turn.</p>
    </section>

    <section>
      <h2>Pricing</h2>
      <p>${CLINIC_FEE} per completed connection, invoiced monthly. Nothing for a request you decline. Nothing for one that expires. No subscription and no listing fee. Founding clinics pay nothing while they remain participating and in good standing under the clinic agreement, and a booking sponsored by the Paw It Forward Fund carries a zero referral fee.</p>
      <p>Your deposits and your veterinary charges are untouched by any of it. Payments run through Stripe Connect under your own connected account.</p>
    </section>

    <section>
      <h2>What you keep control of</h2>
      <ul>
        <li>Whether you are taking patients at all, at any moment, and for how long that stands.</li>
        <li>Whether you take critical cases, and what a stable patient is currently waiting.</li>
        <li>Your deposit policy, your refund rule and your cancellation window, disclosed to the owner in your words before they pay.</li>
        <li>Your triage. An accepted request reserves nothing in the order you examine patients, and Tími tells owners so on the screen where they choose.</li>
      </ul>
      <p>You can also put your live status on your own website with an embeddable widget, so the people already looking at your site see the same answer.</p>
    </section>
  `;

  return document_({
    path: "/for-veterinarians",
    title: `Tími NOW for veterinary clinics — ${CLINIC_FEE} per completed connection`,
    description: `Report intake capacity when you have it, receive structured requests instead of phone calls, and pay ${CLINIC_FEE} only on a completed connection. No subscription, no listing fee.`,
    h1: "For veterinary practices",
    lede: "Say what you can take, when you can take it. Requests arrive structured and answerable, and you pay only when a connection actually completes.",
    sections,
    faq,
    crumbs: [HOME_CRUMB, { name: "For veterinary clinics", url: `${SITE.customerOrigin}/for-veterinarians` }]
  });
}

function pricing() {
  const faq = [
    {
      question: "Is Tími NOW free to use?",
      answer: "Searching, comparing clinics and reading everything on the site is free and needs no account. A fee applies only when a booking completes."
    },
    {
      question: "How much does Tími NOW charge a pet owner?",
      answer: `${OWNER_FEE}, charged when a booking completes and itemised on the confirmation screen before payment is authorised. It is a platform fee for intake routing, not a veterinary charge, and it is never billed to insurance. A declined, expired or cancelled request carries no fee.`
    },
    {
      question: "Is the clinic's deposit part of Tími's fee?",
      answer: "No. A deposit, where a clinic requires one, is that clinic's own charge, disclosed with its amount, cancellation window and refund rule before you pay, and credited against that clinic's invoice for care. Tími's fee is separate and itemised separately."
    },
    {
      question: "What does a clinic pay?",
      answer: `${CLINIC_FEE} per completed connection, invoiced monthly, with nothing charged for declined or expired requests and no subscription or listing fee. Founding clinics pay nothing while participating and in good standing.`
    },
    {
      question: "Can Tími's fee be claimed on pet insurance?",
      answer: "No. Neither the owner's fee nor the clinic's fee is a veterinary charge, neither forms part of a clinic's invoice for care, and neither may be submitted to an insurer."
    }
  ];

  const sections = `
    <section>
      <h2>What you pay, and when</h2>
      <table>
        <thead><tr><th scope="col">Who</th><th scope="col">Amount</th><th scope="col">When</th></tr></thead>
        <tbody>
          <tr><td>Anyone searching</td><td>Free</td><td>Always. No account needed.</td></tr>
          <tr><td>Pet owner</td><td>${OWNER_FEE}</td><td>Only when a booking completes.</td></tr>
          <tr><td>Veterinary clinic</td><td>${CLINIC_FEE}</td><td>Only on a completed connection, invoiced monthly.</td></tr>
          <tr><td>Founding clinics</td><td>$0</td><td>While participating and in good standing.</td></tr>
          <tr><td>Sponsored bookings</td><td>$0 both sides</td><td>Where the Paw It Forward Fund covers it.</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>What the fee is not</h2>
      <p>It is not a veterinary charge. It does not appear on a clinic's invoice for care, it is not part of any deposit, and it cannot be submitted to a pet insurer. It pays for routing an intake request and settling the payment, which is the whole of what Tími does.</p>
      <p>Deposits are a separate matter entirely and belong to the clinic. Where one is required, its amount, its free-cancellation window and its refund rule are shown to you, in that clinic's terms, before you authorise anything — and it is credited against that clinic's own bill for treatment.</p>
    </section>

    <section>
      <h2>Contributions</h2>
      <p>You may add an optional contribution to the <a href="/help-with-vet-bills">Paw It Forward Fund</a> when you pay. It is never added by default, is itemised separately, and forms no part of either fee.</p>
    </section>
  `;

  return document_({
    path: "/pricing",
    title: `Tími NOW pricing — free to search, ${OWNER_FEE} on a completed booking`,
    description: `Searching Tími NOW is free. Pet owners pay ${OWNER_FEE} only when a booking completes; clinics pay ${CLINIC_FEE} per completed connection. Neither is a veterinary charge.`,
    h1: "Pricing",
    lede: `Searching is free and needs no account. ${OWNER_FEE} is charged to a pet owner only when a booking actually completes — never for a request that is declined, expires, or is cancelled.`,
    sections,
    faq,
    crumbs: [HOME_CRUMB, { name: "Pricing", url: `${SITE.customerOrigin}/pricing` }]
  });
}

/**
 * A real 404.
 *
 * `not_found_handling: "single-page-application"` used to answer every
 * unknown path with the app shell and a 200. That is a soft 404, and on this
 * site it was unlimited: the customer app routes entirely on the hash, so
 * there are no client-side paths for that fallback to be protecting. Every
 * typo, every stale link, every path a scanner invents was a 200 with the
 * homepage behind it, teaching crawlers that this origin says 200 for URLs
 * that mean nothing — which it then applies to the ones that do.
 */
export function renderNotFoundPage(path = "/") {
  return document_({
    path,
    title: "Page not found — Tími NOW",
    description: "There is nothing at this address.",
    h1: "There is nothing at this address",
    lede: "The link may be old, or mistyped. Everything on this site is one of the pages below.",
    sections: `
      <section>
        <h2>Where to go instead</h2>
        <ul>
          <li><a href="/#find">Find a clinic that can see your pet now</a></li>
          <li><a href="/emergency-vet">Emergency care</a></li>
          <li><a href="/how-it-works">How Tími NOW works</a></li>
          <li><a href="/pricing">Pricing</a></li>
          <li><a href="/help-with-vet-bills">Help with vet bills</a></li>
          <li><a href="/for-veterinarians">For veterinary clinics</a></li>
        </ul>
      </section>
    `
  }).replace('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">',
             '<meta name="robots" content="noindex, follow">');
}

/**
 * Every landing page, by path.
 *
 * Exported as a map so the Worker's router, the sitemap and the test all read
 * from the same list — a page that exists but is in no sitemap, or is in the
 * sitemap and 404s, are both states this shape makes impossible.
 */
export const LANDING_PAGES = {
  "/emergency-vet": { render: emergencyVet, changefreq: "weekly", priority: 0.9 },
  "/how-it-works": { render: howItWorks, changefreq: "monthly", priority: 0.8 },
  "/help-with-vet-bills": { render: helpWithVetBills, changefreq: "monthly", priority: 0.8 },
  "/for-veterinarians": { render: forVeterinarians, changefreq: "monthly", priority: 0.8 },
  "/pricing": { render: pricing, changefreq: "monthly", priority: 0.7 }
};

export function renderLandingPage(path) {
  const page = LANDING_PAGES[path];
  return page ? page.render() : null;
}
