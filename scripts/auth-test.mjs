import { actorForRequest, frontendApiFromPublishableKey, signInRequired } from "../src/auth.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function encodePart(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
publicJwk.kid = "test-key";
publicJwk.alg = "RS256";
publicJwk.use = "sig";

const now = Math.floor(Date.now() / 1000);
const header = encodePart(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
const payload = encodePart(JSON.stringify({
  sub: "user_123",
  sid: "session_123",
  iss: "https://clerk.timi.example",
  azp: "https://timi.example",
  iat: now,
  nbf: now - 1,
  exp: now + 300,
  o: { id: "org_demo_hearth", rol: "admin" }
}));
const input = new TextEncoder().encode(`${header}.${payload}`);
const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, input);
const token = `${header}.${payload}.${encodePart(new Uint8Array(signature))}`;

const realFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ keys: [publicJwk] });

const env = {
  SIGN_IN_REQUIRED: "true",
  CLERK_ISSUER: "https://clerk.timi.example",
  AUTHORIZED_PARTIES: "https://timi.example"
};
const request = new Request("https://timi.example/api/clinic/dashboard", {
  headers: { authorization: `Bearer ${token}`, origin: "https://timi.example" }
});
const actor = await actorForRequest(request, env);
assert(actor?.authenticated === true, "A valid Clerk-style JWT must authenticate");
assert(actor.userId === "user_123" && actor.clerkOrgId === "org_demo_hearth" && actor.role === "admin", "Clerk user, organization, and role claims must be extracted");

const tamperedPayload = encodePart(JSON.stringify({ sub: "user_999", iss: "https://clerk.timi.example", exp: now + 300 }));
const tampered = `${header}.${tamperedPayload}.${encodePart(new Uint8Array(signature))}`;
const rejected = await actorForRequest(new Request("https://timi.example/api", { headers: { authorization: `Bearer ${tampered}` } }), env);
assert(rejected === null, "A tampered token must be rejected");
assert(signInRequired({ SIGN_IN_REQUIRED: "true" }) === true, "Exact true must enable authentication");
assert(signInRequired({ SIGN_IN_REQUIRED: "TRUE" }) === false, "Any value other than exact true must leave authentication disabled");

/**
 * The publishable key and CLERK_ISSUER can disagree, and the failure is silent:
 * a development key with a production issuer fetches JWKS from a host that does
 * not serve it, and every signed-in request 401s with nothing pointing at the
 * cause. That is exactly what a real deployment hit, so the key — which is
 * always self-consistent with its instance — has to win.
 */
assert(
  frontendApiFromPublishableKey("pk_test_bmF0aXZlLWJvbmVmaXNoLTE0OTkuY2xlcmsuYWNjb3VudHMuZGV2JA")
    === "native-bonefish-1499.clerk.accounts.dev",
  "A development publishable key must yield its accounts.dev host"
);
assert(
  frontendApiFromPublishableKey("pk_live_Y2xlcmsudGltaW5vdy5wZXQk") === "clerk.timinow.pet",
  "A production publishable key must yield its custom domain"
);
for (const junk of ["", "not-a-key", "pk_test_zzzz", null, undefined]) {
  assert(frontendApiFromPublishableKey(junk) === null, `A malformed key must yield null, not a guess: ${junk}`);
}

// A token issued by the instance the publishable key names must be accepted
// even when CLERK_ISSUER still points somewhere else entirely.
const derivedIssuerEnv = {
  SIGN_IN_REQUIRED: "true",
  CLERK_ISSUER: "https://clerk.timinow.pet",
  CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsudGltaS5leGFtcGxlJA",
  CLERK_JWKS_URL: "https://clerk.timi.example/.well-known/jwks.json"
};
const derivedActor = await actorForRequest(
  new Request("https://app.timinow.pet/api/session", { headers: { authorization: `Bearer ${token}` } }),
  derivedIssuerEnv
);
assert(
  derivedActor?.authenticated === true,
  "A token from the instance the publishable key names must be accepted despite a stale CLERK_ISSUER"
);

// A token from neither the configured nor the derived instance is still refused.
const wrongIssuerActor = await actorForRequest(
  new Request("https://app.timinow.pet/api/session", { headers: { authorization: `Bearer ${token}` } }),
  { ...derivedIssuerEnv, CLERK_PUBLISHABLE_KEY: "pk_live_ZXZpbC5leGFtcGxlJA", CLERK_ISSUER: "https://evil.example" }
);
assert(wrongIssuerActor === null, "A token from an unrecognised issuer must still be rejected");

globalThis.fetch = realFetch;
console.log("Clerk gate tests passed: exact flag, RS256 verification, organization claims, tamper rejection, and issuer derivation from the publishable key.");
