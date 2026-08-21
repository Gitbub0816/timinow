import { actorForRequest, signInRequired } from "../src/auth.js";

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

globalThis.fetch = realFetch;
console.log("Clerk gate tests passed: exact flag, RS256 verification, organization claims, and tamper rejection.");
