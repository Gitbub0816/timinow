/**
 * The public configuration document every surface fetches on boot.
 *
 * Shared by all three Workers so a new key cannot reach one console and not the
 * others. Nothing secret belongs in here: this response is readable by anyone.
 */

import { LEGAL_VERSION, TIMI_CUSTOMER_FEE_CENTS, TIMI_TOTAL_SERVICE_FEE_CENTS } from "./catalog.js";
import { hasDatabase } from "./db.js";
import { signInRequired } from "./auth.js";

/** The one production map style. Overridable per Worker, identical in practice. */
export const DEFAULT_MAP_STYLE = "mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u";

/**
 * Clerk's headless browser build. It ships no UI components at all, which is
 * what keeps a prebuilt Clerk modal from ever rendering — the guarantee is
 * structural rather than a matter of remembering not to call `mountSignIn`.
 */
export const DEFAULT_CLERK_JS_URL = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/headless/+esm";

const APP_NAMES = {
  customer: "Tími NOW",
  clinic: "Tími NOW — Veterinary Console",
  admin: "Tími NOW — Platform Console"
};

export function publicConfig(env) {
  const surface = env.SURFACE || "customer";
  const authenticated = signInRequired(env);
  return {
    appName: APP_NAMES[surface] || APP_NAMES.customer,
    version: "1.2.0-platform",
    surface,
    signInRequired: authenticated,
    clerkPublishableKey: authenticated ? (env.CLERK_PUBLISHABLE_KEY || null) : null,
    clerkJsUrl: authenticated ? (env.CLERK_JS_URL || DEFAULT_CLERK_JS_URL) : null,
    /** The JWT template the Workers read tenant claims from. */
    clerkTokenTemplate: env.CLERK_TOKEN_TEMPLATE || "timinow",
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
    demoMode: env.DEMO_MODE === "true",
    /**
     * The customer-facing app's own origin — the one Worker that serves
     * `/r/:slug` (src/referrals.js) and `/widget.js` (src/widget.js). The
     * veterinary and admin consoles read this to build a clinic's referral
     * link and widget embed snippet, since neither is the Worker those paths
     * are mounted on.
     */
    customerAppUrl: env.CUSTOMER_APP_URL || "https://timinow.pet",
    /**
     * The terms and safety notice a care request is accepted against. Served
     * so a browser client never has to carry its own copy of the string the
     * Worker rejects everything else against.
     */
    legalVersion: LEGAL_VERSION,
    /**
     * Tími's own service fee, so every checkout screen quotes the same
     * numbers the ledger charges. See the constants in src/catalog.js for the
     * split and the disclosure rule when a clinic passes the whole fee on.
     */
    fees: {
      customerFeeCents: TIMI_CUSTOMER_FEE_CENTS,
      totalServiceFeeCents: TIMI_TOTAL_SERVICE_FEE_CENTS,
      currency: "usd"
    },
    database: hasDatabase(env) ? "d1" : "fixtures",
    map: {
      /** Public Mapbox token only. A secret (sk.) token must never appear here. */
      token: env.MAPBOX_PUBLIC_TOKEN || null,
      styleUrl: env.MAPBOX_STYLE_URL || DEFAULT_MAP_STYLE,
      /** Navigation reuses the same style so guidance matches the map. */
      navigationStyleUrl: env.MAPBOX_NAVIGATION_STYLE_URL || env.MAPBOX_STYLE_URL || DEFAULT_MAP_STYLE
    }
  };
}
