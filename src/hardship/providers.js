/**
 * The outside world, behind interfaces.
 *
 * Identity, OCR, payroll, and bank aggregation are all vendor relationships,
 * and vendor relationships end. Didit, Plaid, and whoever replaces them are
 * implementation details of the four interfaces described here; nothing in
 * engine.js or index.js may name one. Spec §27 is explicit about it, and the
 * practical version of that rule is simple: if swapping a vendor means
 * touching the rules engine, the abstraction failed.
 *
 * ─────────────────────────────────────────── identity is embedded, not sent ──
 *
 * The important shape in this file is `createSession`. Most identity vendors
 * document a hosted flow first: you redirect the user to the vendor's domain
 * and they come back. TímiNOW does not want that. A person trying to get a
 * sick animal seen should not be bounced to a third-party domain, asked to
 * accept somebody else's cookie banner, and returned to a booking that may
 * have expired — the drop-off is real and it lands on exactly the people this
 * program exists for.
 *
 * So `createSession` returns a *session descriptor*, not a URL:
 *
 *   { mode: "EMBEDDED", sessionId, clientToken, expiresAt, hostedUrl: null }
 *
 * The client hands `clientToken` to the vendor's in-app SDK and the capture
 * happens inside TímiNOW. `mode: "HOSTED"` exists as a documented fallback for
 * a vendor or a device that cannot support embedding, and only then is
 * `hostedUrl` populated. Callers must branch on `mode` and must never assume a
 * URL is present; an interface that returned a bare string would have quietly
 * made the redirect flow the only one implementable.
 *
 * ─────────────────────────────────────────────── transactions are optional ──
 *
 * `TransactionVerificationProvider` is corroboration and nothing more. The
 * primary determination path is documents: an itemized invoice plus a paid
 * marker decides a financial shock with no aggregator connected at all. Every
 * caller must work when `transactions.available()` is false, because for a
 * long while it will be.
 */

/** Thrown by adapters. Carries a code the lifecycle can map to a state. */
export class ProviderError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    /** Retryable errors become TECHNICAL_RETRY, never a hardship denial. */
    this.retryable = retryable;
  }
}

/**
 * @typedef {object} IdentitySession
 * @property {string} provider          Vendor id, for the audit record.
 * @property {"EMBEDDED"|"HOSTED"} mode Which flow this session is for.
 * @property {string} sessionId         Opaque vendor session id.
 * @property {string|null} clientToken  Short-lived token for the in-app SDK.
 *                                      Present for EMBEDDED, the primary path.
 * @property {string|null} hostedUrl    Populated only for HOSTED.
 * @property {string} expiresAt         ISO instant after which the token dies.
 * @property {string[]} supportedModes  What this vendor can actually do.
 */

/**
 * @typedef {object} IdentityVerificationProvider
 * @property {string} id
 * @property {string[]} supportedModes
 * @property {(input: {applicationId: string, mode?: "EMBEDDED"|"HOSTED", locale?: string, returnUrl?: string, now: string}) => Promise<IdentitySession>} createSession
 *   Opens a verification session. `mode` defaults to EMBEDDED. A provider that
 *   cannot embed must throw rather than silently return a redirect, so the
 *   product notices at integration time instead of in production.
 * @property {(sessionId: string) => Promise<{status: string, verified: boolean, uniquenessConfidence: string, identityKey: string|null, nameNormalized: string|null, checkedAt: string}>} getSessionResult
 *   Normalized identity facts. Never income, never a document image, and
 *   never a risk score the rules could accidentally consume.
 */

/**
 * @typedef {object} DocumentExtractionProvider
 * @property {string} id
 * @property {(input: {objectRef: string, declaredType?: string, now: string}) => Promise<object>} extract
 *   Takes a private-storage object reference — never file bytes through the
 *   rules layer — and returns normalized evidence: documentType, issuer,
 *   documentDate, extracted fields, line items with a normalized category and
 *   a confidence, and a tamperRisk signal. Everything it returns is a fact
 *   proposal; policy.js decides what any of it means.
 */

/**
 * @typedef {object} IncomeVerificationProvider
 * @property {string} id
 * @property {(input: {applicationId: string, now: string}) => Promise<{status: string, annualCents: number|null, sourceType: string, confidence: number, documentDate: string|null}>} verifyIncome
 *   `status` is one of VERIFIED_INCOME, NO_INCOME_DETECTED,
 *   INSUFFICIENT_INCOME_EVIDENCE, CONFLICTING_INCOME_EVIDENCE. The middle two
 *   are not zero income and the engine treats them accordingly.
 */

/**
 * @typedef {object} TransactionVerificationProvider
 * @property {string} id
 * @property {() => boolean} available  False when nothing is connected. Callers
 *   must degrade to document-only determination, not fail.
 * @property {(input: {applicationId: string, amountCents: number, issuer: string, documentDate: string, toleranceRatio: number}) => Promise<{available: boolean, matched: boolean, matchedAmountCents: number|null, transactionRef: string|null}>} findCorroboration
 *   Corroborates that money moved. It can never establish *purpose*: a
 *   merchant line reading "AUTO REPAIR — $2,200" is compatible with a
 *   transmission and with a set of alloy wheels, which is the whole reason
 *   the line-item taxonomy exists.
 */

/* ───────────────────────────────────────────────────────────── stubs ── */

const STUB_SESSION_TTL_MINUTES = 30;

function plusMinutes(nowIso, minutes) {
  return new Date(new Date(nowIso).getTime() + minutes * 60_000).toISOString();
}

/**
 * A deterministic identity stub.
 *
 * Ids are derived from the application id rather than randomly generated, so
 * a test can assert the whole session descriptor and a replay produces the
 * same audit record. It never reaches the network.
 */
export function stubIdentityProvider({ sessions = {}, supportedModes = ["EMBEDDED", "HOSTED"] } = {}) {
  return {
    id: "stub-identity",
    supportedModes,
    async createSession({ applicationId, mode = "EMBEDDED", returnUrl = null, now }) {
      if (!applicationId) throw new ProviderError("APPLICATION_REQUIRED", "An identity session needs an application id.");
      if (!supportedModes.includes(mode)) {
        throw new ProviderError("MODE_NOT_SUPPORTED", `This identity provider cannot run a ${mode} flow.`);
      }
      const nowIso = now || new Date(0).toISOString();
      const sessionId = `idvs_stub_${applicationId}`;
      return {
        provider: "stub-identity",
        mode,
        sessionId,
        // The embedded path is the product's intent: a token the in-app SDK
        // consumes, with the capture staying inside TímiNOW.
        clientToken: mode === "EMBEDDED" ? `idvt_stub_${applicationId}` : null,
        // Only the fallback carries a URL, and it carries the return target
        // with it so the booking can be resumed rather than abandoned.
        hostedUrl: mode === "HOSTED"
          ? `https://identity.stub.invalid/session/${sessionId}${returnUrl ? `?return=${encodeURIComponent(returnUrl)}` : ""}`
          : null,
        expiresAt: plusMinutes(nowIso, STUB_SESSION_TTL_MINUTES),
        supportedModes
      };
    },
    async getSessionResult(sessionId) {
      const fixture = sessions[sessionId];
      if (!fixture) {
        return { status: "PENDING", verified: false, uniquenessConfidence: "NONE", identityKey: null, nameNormalized: null, checkedAt: null };
      }
      return { status: "COMPLETED", verified: false, uniquenessConfidence: "NONE", identityKey: null, nameNormalized: null, checkedAt: null, ...fixture };
    }
  };
}

/**
 * A deterministic extraction stub keyed by object reference.
 *
 * Fixtures are the normalized-evidence shape from spec §14, which means a
 * test writes the same JSON the real provider will eventually return, and the
 * engine cannot tell the difference. That is the point of the abstraction.
 */
export function stubDocumentExtractionProvider({ documents = {} } = {}) {
  return {
    id: "stub-extraction",
    async extract({ objectRef }) {
      const fixture = documents[objectRef];
      if (!fixture) {
        throw new ProviderError("EXTRACTION_UNAVAILABLE", `No extraction fixture for "${objectRef}".`, { retryable: true });
      }
      return { objectRef, tamperRisk: "LOW", lineItems: [], ...fixture };
    }
  };
}

export function stubIncomeVerificationProvider({ income = {} } = {}) {
  return {
    id: "stub-income",
    async verifyIncome({ applicationId }) {
      const fixture = income[applicationId];
      if (!fixture) {
        // Nothing connected is not "no income" — see engine.js. The status is
        // explicit so the rules never read this as a verified zero.
        return { status: "INSUFFICIENT_INCOME_EVIDENCE", annualCents: null, sourceType: "NONE", confidence: 0, documentDate: null };
      }
      return fixture;
    }
  };
}

/**
 * The optional one. `available()` answers false unless fixtures were supplied,
 * which keeps the document-only path honest in tests: if a test passes only
 * because a transaction provider happened to be connected, this stub makes
 * that visible instead of accidental.
 */
export function stubTransactionVerificationProvider({ transactions = null } = {}) {
  const connected = Boolean(transactions);
  return {
    id: "stub-transactions",
    available() { return connected; },
    async findCorroboration({ applicationId, amountCents, toleranceRatio = 0 }) {
      if (!connected) return { available: false, matched: false, matchedAmountCents: null, transactionRef: null };
      const candidates = transactions[applicationId] || [];
      const tolerance = Math.abs(Math.round(amountCents * toleranceRatio));
      const match = candidates.find((entry) => Math.abs(Number(entry.amountCents) - amountCents) <= tolerance);
      return {
        available: true,
        matched: Boolean(match),
        matchedAmountCents: match ? Number(match.amountCents) : null,
        transactionRef: match ? match.transactionRef || null : null
      };
    }
  };
}

/**
 * A provider whose credentials are configured but whose adapter has not been
 * written yet.
 *
 * It fails loudly and retryably rather than falling back to the stub. A stub
 * that quietly stands in for a configured production vendor is how a test
 * fixture ends up deciding a real person's application.
 */
function unimplementedProvider(id, methods) {
  const provider = { id };
  for (const method of methods) {
    provider[method] = async () => {
      throw new ProviderError(
        "PROVIDER_ADAPTER_NOT_IMPLEMENTED",
        `Credentials for "${id}" are configured but no adapter is implemented. Write it in src/hardship/providers.js.`,
        { retryable: true }
      );
    };
  }
  if (methods.includes("findCorroboration")) provider.available = () => false;
  return provider;
}

function configured(env, keys) {
  return keys.every((key) => typeof env?.[key] === "string" && env[key].trim().length > 0);
}


/* ─────────────────────────────────────────────────────────── Didit ── */

/**
 * Didit, the chosen identity vendor.
 *
 * Embedded first, deliberately. A pet owner opening this flow is standing in
 * a kitchen at 9pm with a sick animal; sending them out to a vendor's hosted
 * page and hoping they come back is how an application is abandoned. The
 * session descriptor carries a client token for the in-app widget, and the
 * hosted URL is populated only when a caller explicitly asks for it.
 *
 * Two things this deliberately does not do:
 *
 *   It does not infer income, employment, or hardship from an identity
 *   check. Didit answers one question — is this a real, unique person, and
 *   are they who the evidence names — and that answer feeds the rules as a
 *   fact like any other.
 *
 *   It does not store a document, a selfie, or a government number. What
 *   comes back is a verification status, a uniqueness signal, and a stable
 *   identity key used for the rolling per-person limit. The images stay with
 *   the vendor under their retention terms.
 *
 * The endpoint shapes below follow Didit's session API as documented at
 * integration time. They are wrong the moment Didit revises them, which is
 * exactly why they live behind this interface: a change here touches no rule
 * and no ledger entry.
 */
export function diditIdentityProvider(env) {
  const apiKey = env.DIDIT_API_KEY || env.IDENTITY_PROVIDER_API_KEY;
  const baseUrl = (env.DIDIT_BASE_URL || "https://verification.didit.me").replace(/\/$/, "");
  const workflowId = env.DIDIT_WORKFLOW_ID || null;
  const supportedModes = ["EMBEDDED", "HOSTED"];

  async function call(path, { method = "POST", body } = {}) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": apiKey
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      // A network failure is temporary and must not read as a decision. The
      // engine's TECHNICAL_RETRY exists for exactly this.
      throw new ProviderError("IDENTITY_PROVIDER_UNREACHABLE", `Could not reach the identity provider: ${error.message}`, { retryable: true });
    }

    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      throw new ProviderError(
        retryable ? "IDENTITY_PROVIDER_UNAVAILABLE" : "IDENTITY_PROVIDER_REJECTED",
        payload?.message || `Identity provider returned ${response.status}.`,
        { retryable, status: response.status }
      );
    }
    return payload;
  }

  return {
    id: "didit",
    supportedModes,

    async createSession({ applicationId, mode = "EMBEDDED", locale = "en", returnUrl = null, now }) {
      if (!applicationId) throw new ProviderError("APPLICATION_REQUIRED", "An identity session needs an application id.");
      if (!supportedModes.includes(mode)) {
        throw new ProviderError("MODE_NOT_SUPPORTED", `This identity provider cannot run a ${mode} flow.`);
      }

      const payload = await call("/v2/session/", {
        body: {
          workflow_id: workflowId,
          // Our own id, so a webhook or a support question can be traced back
          // to an application without the vendor holding anything else.
          vendor_data: applicationId,
          language: locale,
          ...(mode === "HOSTED" && returnUrl ? { callback: returnUrl } : {})
        }
      });

      const sessionId = payload.session_id || payload.id || null;
      if (!sessionId) {
        throw new ProviderError("IDENTITY_SESSION_MALFORMED", "The identity provider returned no session id.", { retryable: true });
      }

      const clientToken = payload.client_secret || payload.session_token || payload.token || null;
      if (mode === "EMBEDDED" && !clientToken) {
        // Falling back to the hosted page unasked would silently change the
        // product: the applicant leaves the app and most do not return.
        throw new ProviderError("EMBEDDED_SESSION_UNAVAILABLE", "The identity provider did not return a token for the embedded flow.", { retryable: true });
      }

      return {
        provider: "didit",
        mode,
        sessionId,
        clientToken: mode === "EMBEDDED" ? clientToken : null,
        hostedUrl: mode === "HOSTED" ? (payload.url || payload.verification_url || null) : null,
        expiresAt: payload.expires_at || plusMinutes(now || new Date().toISOString(), 30),
        supportedModes
      };
    },

    async getSessionResult(sessionId) {
      if (!sessionId) throw new ProviderError("SESSION_REQUIRED", "A session id is required.");
      const payload = await call(`/v2/session/${encodeURIComponent(sessionId)}/decision/`, { method: "GET" });

      const status = String(payload.status || "").toUpperCase();
      const approved = status === "APPROVED";
      const terminal = ["APPROVED", "DECLINED", "EXPIRED", "ABANDONED", "KYC_EXPIRED"].includes(status);

      /**
       * The stable per-person handle for the rolling sponsorship limit.
       *
       * Never a government number, and never the raw document: those belong
       * with the vendor. Didit's own decision id for the verified person is
       * enough to recognise a repeat applicant, which is all the limit needs.
       */
      const identityKey = approved
        ? (payload.decision?.identity_id || payload.identity_id || `didit:${sessionId}`)
        : null;

      const name = payload.decision?.kyc?.full_name
        || [payload.decision?.kyc?.first_name, payload.decision?.kyc?.last_name].filter(Boolean).join(" ")
        || null;

      return {
        status: terminal ? "COMPLETED" : "PENDING",
        verified: approved,
        // Didit's own duplicate-face and duplicate-document checks, when the
        // configured workflow runs them. Absent means absent, not passed.
        uniquenessConfidence: approved
          ? (payload.decision?.aml?.status === "clear" || payload.decision?.duplicate_check?.status === "clear" ? "HIGH" : "MEDIUM")
          : "NONE",
        identityKey,
        nameNormalized: name ? name.trim().toLowerCase().replace(/\s+/g, " ") : null,
        checkedAt: payload.updated_at || payload.created_at || null
      };
    }
  };
}

/**
 * The provider set for this environment.
 *
 * Stubs unless real credentials are present, and a stub never calls anything.
 * `fixtures` is how a test drives the stubs; production passes none, gets the
 * empty fixtures, and every extraction fails retryably — which is correct,
 * because production without credentials has no extraction.
 */
export function providers(env = {}, fixtures = {}) {
  const identityConfigured = configured(env, ["IDENTITY_PROVIDER_API_KEY"]) || configured(env, ["DIDIT_API_KEY"]);
  const extractionConfigured = configured(env, ["DOCUMENT_EXTRACTION_API_KEY"]);
  const incomeConfigured = configured(env, ["INCOME_PROVIDER_API_KEY"]);
  const transactionsConfigured = configured(env, ["PLAID_CLIENT_ID", "PLAID_SECRET"]);

  return {
    mode: identityConfigured || extractionConfigured || incomeConfigured || transactionsConfigured ? "LIVE" : "STUB",
    identity: identityConfigured
      ? diditIdentityProvider(env)
      : stubIdentityProvider(fixtures),
    documents: extractionConfigured
      ? unimplementedProvider("extraction", ["extract"])
      : stubDocumentExtractionProvider(fixtures),
    income: incomeConfigured
      ? unimplementedProvider("income", ["verifyIncome"])
      : stubIncomeVerificationProvider(fixtures),
    transactions: transactionsConfigured
      ? unimplementedProvider("transactions", ["findCorroboration"])
      : stubTransactionVerificationProvider(fixtures)
  };
}
