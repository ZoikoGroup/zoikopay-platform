// Authentication end-to-end check against the REAL local stack: Keycloak
// realm "zoikopay", the Go gateway (8080) reading merchant.memberships and
// writing governance.audit_events in Postgres, the console backend (4000) and
// the frontend server (5173, proxying /api and /auth).
//
// Run it from a clean stack with `make e2e-auth` (repo root), which starts and
// stops everything and passes the log directory. `npm run test:e2e` runs the
// same checks against servers you started yourself; the log checks then SKIP.
//
// SYNTHETIC DATA ONLY: the local realm's fictional users, the local seed
// (scripts/seed-local.sql) and tokens minted here. Refuses any non-local URL.
// It changes the local realm for a few seconds (a short token lifespan, extra
// claims and roles) and puts every change back. Tokens are never printed.

import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const CONSOLE = env.E2E_CONSOLE_URL ?? "http://localhost:5173";
const GATEWAY = env.E2E_GATEWAY_URL ?? "http://localhost:8080";
const KEYCLOAK = env.E2E_KEYCLOAK_URL ?? "http://localhost:8180";
const ISSUER = `${KEYCLOAK}/realms/zoikopay`;
const PASSWORD = env.E2E_PASSWORD ?? "Zoiko@123"; // local realm users only
const CONSOLE_CLIENT = { id: "zoikopay-console", secret: env.OIDC_CLIENT_SECRET ?? "local-dev-only-console-secret" };
const SERVICE_CLIENT = { id: "zoikopay-console-admin", secret: env.ACCOUNT_ADMIN_CLIENT_SECRET ?? "local-dev-only-account-admin-secret" };
const KEYCLOAK_ADMIN_PASSWORD = env.ZP_KEYCLOAK_ADMIN_PASSWORD ?? "local-dev-only-admin";
const LOG_DIR = env.E2E_LOG_DIR; // set by scripts/e2e-auth.sh
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = ["compose", "-f", join(REPO, "deploy", "compose", "compose.yaml")];

for (const u of [CONSOLE, GATEWAY, KEYCLOAK]) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname)) throw new Error(`refusing non-local URL ${u}: synthetic local stack only`);
}

// Same IDs as backend/src/database/fixtures.ts and scripts/seed-local.sql.
const T = { northwind: "ten_019a0000000170008000000000000001", alder: "ten_019a0000000270008000000000000002" };
const M = {
  northwindUk: "mer_019a0000010170008000000000000101", northwindEu: "mer_019a0000010270008000000000000102",
  alderBooks: "mer_019a0000020170008000000000000201", alderTravel: "mer_019a0000020270008000000000000202",
  unknown: "mer_019a0000099970008000000000000999",
};
const sub = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SUB = { superAdmin: sub(1), support: sub(6), owner: sub(10), ops: sub(11), viewer: sub(12), finance: sub(14), dev: sub(15), ownerB: sub(19) };

// --- reporting ---------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passes++; else failures++;
}
const skip = (name, why) => console.log(`SKIP ${name}  (${why})`);
const section = (title) => console.log(`\n== ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** Every token obtained or forged in this run; the logs and the audit table must contain none of them. */
const secrets = new Set();
const keep = (t) => { if (t) secrets.add(t); return t; };

// --- Keycloak ------------------------------------------------------------------
async function tokenRequest(realmUrl, params) {
  const res = await fetch(`${realmUrl}/protocol/openid-connect/token`, { method: "POST", body: new URLSearchParams(params), signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token request failed (${res.status} ${body.error ?? ""})`);
  for (const k of ["access_token", "id_token", "refresh_token"]) keep(body[k]);
  return body;
}
/** A user's tokens from the console client (the same grant the console uses). */
const userTokens = (username) => tokenRequest(ISSUER, {
  grant_type: "password", client_id: CONSOLE_CLIENT.id, client_secret: CONSOLE_CLIENT.secret, username, password: PASSWORD, scope: "openid profile",
});

let adminToken;
const adminSignIn = async () => (adminToken = (await tokenRequest(`${KEYCLOAK}/realms/master`,
  { grant_type: "password", client_id: "admin-cli", username: "admin", password: KEYCLOAK_ADMIN_PASSWORD })).access_token);
/** Local Keycloak admin API. The admin token lasts 60 s, so a refused token is renewed once. */
async function admin(method, path, body) {
  const send = () => fetch(`${KEYCLOAK}/admin/realms/zoikopay${path}`, {
    method, headers: { authorization: `Bearer ${adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  if (!adminToken) await adminSignIn();
  let res = await send();
  if (res.status === 401) { await adminSignIn(); res = await send(); }
  if (!res.ok && res.status !== 404) throw new Error(`Keycloak admin ${method} ${path}: ${res.status}`);
  return res.status === 204 || res.status === 201 ? null : res.json().catch(() => null);
}
/** Puts a realm change back; a failure is reported, never hidden. */
async function undo(what, fn) {
  try { await fn(); } catch (e) { check(`cleanup: ${what}`, false, e.message); }
}

// An unexpected error is a failed run, reported like any other check.
process.on("unhandledRejection", (e) => { check("the run completed without an unexpected error", false, String(e?.message ?? e)); finish(); });
function finish() {
  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures ? "END-TO-END CHECK FAILED" : "All end-to-end checks passed");
  process.exit(failures ? 1 : 0);
}

// --- JWT helpers (for forged tokens; nothing here is printed) ----------------------
const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const header = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString());
const { privateKey: attackerKey, publicKey: attackerPub } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rs256 = (h, p) => { const d = `${b64u(h)}.${b64u(p)}`; return keep(`${d}.${sign("sha256", Buffer.from(d), attackerKey).toString("base64url")}`); };

// --- gateway -------------------------------------------------------------------
/** Every direct gateway request, by trace ID, for the audit checks. */
const gatewayCalls = [];
async function gw(path, token, headers = {}, { method = "GET", body } = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method, signal: AbortSignal.timeout(10_000), body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token !== undefined ? { authorization: token } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  const trace = res.headers.get("x-trace-id");
  gatewayCalls.push({ path, status: res.status, trace });
  return { status: res.status, body: parsed, trace, www: res.headers.get("www-authenticate"), etag: res.headers.get("etag") };
}
const bearer = (t) => `Bearer ${t}`;
/** A fresh Idempotency-Key: a quoted UUID (04-08, RFC 9651 string). */
const idemKey = () => `"${crypto.randomUUID()}"`;
/** POST to the gateway with a fresh Idempotency-Key unless headers carry one. */
const gwPost = (path, token, body, headers = {}) => gw(path, token, { "idempotency-key": idemKey(), ...headers }, { method: "POST", body });
/** A problem body without its per-request IDs, to compare responses for sameness. */
const masked = (b) => JSON.stringify({ ...b, trace_id: undefined, request_id: undefined });

// --- console (a browser-like client) --------------------------------------------
function client() {
  let cookie = "";
  async function call(method, path, body, origin = CONSOLE, extra = {}) {
    const res = await fetch(`${CONSOLE}${path}`, {
      method, redirect: "manual",
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(origin && method !== "GET" ? { origin } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith("zp_console_sid=")) cookie = c.split(";")[0];
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: res.status, body: json, raw, setCookie: set.join("; ") };
  }
  return {
    get: (p, extra) => call("GET", p, undefined, CONSOLE, extra),
    post: (p, b, origin) => call("POST", p, b, origin),
    put: (p, b) => call("PUT", p, b),
    login: (username, password = PASSWORD) => call("POST", "/auth/login", { username, password }),
  };
}
const merchantsOf = (res) => new Set(res.body?.data?.items?.map((p) => p.merchantId));

// --- Postgres (local container) -----------------------------------------------
function psql(user, sql) {
  return execFileSync("docker", [...COMPOSE, "exec", "-T", "-e", `PGPASSWORD=${env.ZP_APP_PASSWORD ?? "local-dev-only-app"}`, "postgres",
    "psql", "-X", "-q", "-A", "-t", "-h", "localhost", "-U", user, "-d", "zoikopay", "-v", "ON_ERROR_STOP=1", "-f", "-"],
  { input: sql, encoding: "utf8" }).trim();
}
const asGateway = (sql) => psql("zp_gateway", sql); // BC-01's runtime role: RLS and the delegation rules apply
const asSuperuser = (sql) => psql("postgres", sql); // the provisioning role (Q40) and assertions
const reseed = () => asSuperuser(readFileSync(join(REPO, "scripts", "seed-local.sql"), "utf8"));
/** The ID of member's live grant of persona in Northwind, as Northwind's owner lists it. */
async function grantOf(ownerToken, member, persona) {
  const list = await gw(`/v1/tenants/${T.northwind}/memberships`, ownerToken);
  return list.body?.data?.find((m) => m.member?.subject === member && m.persona === persona)?.id;
}

// =============================================================================
section("1. Valid login: roles come only from merchant.memberships");
const t = {
  ops: await userTokens("merchant.ops"), owner: await userTokens("merchant.owner"), dev: await userTokens("merchant.dev"),
  finance: await userTokens("merchant.finance"), superAdmin: await userTokens("super.admin"),
};
check("Keycloak issues a gateway-audience access token to the console client", [decode(t.ops.access_token).aud].flat().includes("zoikopay-gateway"));
const opsPrincipal = await gw("/v1/principal", bearer(t.ops.access_token));
const g0 = opsPrincipal.body?.grants ?? [];
check("gateway: merchant.ops holds exactly MOPS on Northwind UK", opsPrincipal.status === 200 && opsPrincipal.body?.subject === SUB.ops
  && g0.length === 1 && g0[0].persona === "mops" && g0[0].tenant_id === T.northwind && g0[0].merchant_id === M.northwindUk);
const ownerPrincipal = await gw("/v1/principal", bearer(t.owner.access_token));
check("gateway: merchant.owner holds tenant-wide MOWN on Northwind", ownerPrincipal.body?.grants?.length === 1
  && ownerPrincipal.body.grants[0].persona === "mown" && ownerPrincipal.body.grants[0].merchant_id === undefined);
const staffPrincipal = await gw("/v1/principal", bearer(t.superAdmin.access_token));
check("gateway: super.admin signs in but holds no grant (no staff wildcard)", staffPrincipal.status === 200 && staffPrincipal.body?.grants?.length === 0);

const bad = client();
check("console: wrong password is rejected by Keycloak", (await bad.login("merchant.ops", "wrong-password")).body?.code === "INVALID_CREDENTIALS");
check("console: unknown user gets the same answer", (await bad.login("no.such.user")).body?.code === "INVALID_CREDENTIALS");
check("console: no session after a failed sign-in", (await bad.get("/api/v1/me")).status === 401);
const csrf = await client().post("/auth/login", { username: "merchant.ops", password: PASSWORD }, "https://evil.example");
check("console: sign-in posted from another site is refused", csrf.status === 403 && csrf.body?.code === "ORIGIN_REJECTED");

const mops = client();
const opsLogin = await mops.login("merchant.ops");
check("console: merchant.ops signs in with the console's own form", opsLogin.status === 200);
check("console: no token reaches the browser at sign-in", !/eyJ|refresh|access_token/i.test(opsLogin.raw + opsLogin.setCookie));
const opsMe = await mops.get("/api/v1/me");
check("console: merchant.ops resolves to MOPS in TEST", opsMe.body?.data?.personas?.join() === "MOPS" && opsMe.body?.data?.environment === "TEST");
check("console: /me carries no token", !/eyJ/.test(opsMe.raw));
const opsPays = await mops.get("/api/v1/payments?pageSize=100");
check("console: merchant.ops sees Northwind UK payments only", opsPays.status === 200 && same(merchantsOf(opsPays), new Set([M.northwindUk])));
check("console: data is labelled as mock data", opsPays.body?.meta?.source === "fixture");
check("console: legal entity comes from the covered merchant only (Q39 39.2)",
  (await mops.get("/api/v1/scope")).body?.data?.legalEntities?.map((e) => e.id).join() === "cell_uk_01");
check("console: merchant.ops cannot switch to LIVE", (await mops.put("/api/v1/session/environment", { environment: "LIVE" })).status === 403);

const owner = client();
await owner.login("merchant.owner");
check("console: merchant.owner sees both Northwind merchants and nothing else",
  same(merchantsOf(await owner.get("/api/v1/payments?pageSize=100")), new Set([M.northwindUk, M.northwindEu])));
const access = await owner.get("/api/v1/access/members");
check("console: Access screen refuses grant administration (Q39 39.6)", access.status === 503 && access.body?.code === "GRANT_ADMINISTRATION_UNAVAILABLE");

const viewer = client(); // exactly three console requests: sign-in, payments, audit (counted in section 7)
await viewer.login("merchant.viewer");
const viewerPays = await viewer.get("/api/v1/payments?pageSize=100");
check("console: merchant.viewer sees Alder only", same(merchantsOf(viewerPays), new Set([M.alderBooks, M.alderTravel])));
check("console: console audit chain verifies", (await viewer.get("/api/v1/audit?limit=500")).body?.data?.verification?.valid === true);
const alderPayment = viewerPays.body?.data?.items?.[0]?.id;

for (const username of ["super.admin", "security.officer", "iam.admin"]) {
  const c = client();
  const login = await c.login(username);
  const m = (await c.get("/api/v1/me")).body?.data;
  const refused = [await c.get("/api/v1/payments"), await c.get("/api/v1/platform/summary"), await c.get("/api/v1/exceptional-access")].every((r) => r.status === 403);
  check(`console: ${username} signs in with no access and no staff persona`, login.status === 200 && m?.hasAccess === false && m?.personas?.length === 0 && refused);
}

// =============================================================================
section("2. Bad, expired, wrong-audience and forged tokens get 401");
const jwks = await (await fetch(`${ISSUER}/protocol/openid-connect/certs`)).json();
const kcKey = jwks.keys.find((k) => k.use === "sig" && k.alg === "RS256");
const real = t.ops.access_token;
const [rh, , rs] = real.split(".");
const ownerClaims = { ...decode(real), sub: SUB.owner };
const service = await tokenRequest(ISSUER, { grant_type: "client_credentials", client_id: SERVICE_CLIENT.id, client_secret: SERVICE_CLIENT.secret });
await admin("GET", "/roles"); // signs in to the local Keycloak admin console (realm master)
const master = adminToken; // a real, validly signed token from another issuer
check("the service-client token really lacks the gateway audience", ![decode(service.access_token).aud].flat().includes("zoikopay-gateway"));
const badTokens = {
  "no Authorization header": undefined,
  "empty bearer": "Bearer ",
  "wrong scheme": `Basic ${Buffer.from("merchant.ops:x").toString("base64")}`,
  "not a JWT": "Bearer not-a-jwt",
  "three garbage parts": "Bearer aaa.bbb.ccc",
  "alg none": bearer(keep(`${b64u({ alg: "none", typ: "JWT" })}.${b64u(ownerClaims)}.`)),
  "real signature, payload changed to another user": bearer(keep(`${rh}.${b64u(ownerClaims)}.${rs}`)),
  "signed by an attacker key under Keycloak's key ID": bearer(rs256({ alg: "RS256", typ: "JWT", kid: kcKey.kid }, ownerClaims)),
  "HS256 keyed with Keycloak's public key (algorithm confusion)": bearer(keep((() => {
    const d = `${b64u({ alg: "HS256", typ: "JWT", kid: kcKey.kid })}.${b64u(ownerClaims)}`;
    return `${d}.${createHmac("sha256", JSON.stringify(kcKey)).update(d).digest("base64url")}`;
  })())),
  "embedded attacker key (jwk header)": bearer(rs256({ alg: "RS256", typ: "JWT", kid: kcKey.kid, jwk: attackerPub.export({ format: "jwk" }) }, ownerClaims)),
  "ID token instead of an access token": bearer(t.ops.id_token),
  "refresh token": bearer(t.ops.refresh_token),
  "wrong audience (service client token)": bearer(service.access_token),
  "other issuer (realm master token)": bearer(master),
};
const unauthorized = [];
for (const [name, auth] of Object.entries(badTokens)) {
  const r = await gw(`/v1/merchants/${M.northwindUk}`, auth);
  unauthorized.push(r);
  check(`gateway: ${name} → 401`, r.status === 401 && r.body?.code === "authentication_required" && /^Bearer/.test(r.www ?? ""), `HTTP ${r.status}`);
}
check("gateway: every 401 has the same body (the reason is never revealed)", new Set(unauthorized.map((r) => masked(r.body))).size === 1);
check("gateway: an unauthenticated caller cannot discover routes (401 on an unknown /v1 path)", (await gw("/v1/no_such_route", undefined)).status === 401);

// Expired: a real token with a 5 s lifespan; the gateway allows 30 s clock leeway (ADR 0007).
const consoleClient = (await admin("GET", `/clients?clientId=${CONSOLE_CLIENT.id}`))[0];
const original = structuredClone(consoleClient);
let shortLived;
try {
  await admin("PUT", `/clients/${consoleClient.id}`, { ...consoleClient, attributes: { ...consoleClient.attributes, "access.token.lifespan": "5" } });
  shortLived = (await userTokens("merchant.ops")).access_token;
} finally {
  // An empty value removes the override, so the realm's own lifespan applies again.
  await undo("token lifespan", () => admin("PUT", `/clients/${consoleClient.id}`, { ...original, attributes: { ...original.attributes, "access.token.lifespan": "" } }));
}
const shortClaims = decode(shortLived);
check("a real short-lived token is issued (5 s)", shortClaims.exp - shortClaims.iat <= 5);
const restored = decode((await userTokens("merchant.ops")).access_token);
check("the console client's token lifespan is back to the realm's (300 s)", restored.exp - restored.iat >= 300, `${restored.exp - restored.iat} s`);
check("gateway: that token works before it expires", (await gw(`/v1/merchants/${M.northwindUk}`, bearer(shortLived))).status === 200);
const expiredAt = (shortClaims.exp + 31) * 1000;

// =============================================================================
section("3. Another tenant's data gets 404; a missing permission gets 403");
const ops = bearer(t.ops.access_token);
const own = await gw(`/v1/merchants/${M.northwindUk}`, ops);
check("gateway: merchant.ops reads their own merchant (200)", own.status === 200 && own.body?.id === M.northwindUk);
const notFound = {
  "sibling merchant in the same tenant, no grant": await gw(`/v1/merchants/${M.northwindEu}`, ops),
  "another tenant's merchant": await gw(`/v1/merchants/${M.alderBooks}`, ops),
  "a merchant that does not exist": await gw(`/v1/merchants/${M.unknown}`, ops),
  "a malformed ID": await gw("/v1/merchants/not-a-merchant", ops),
};
for (const [name, r] of Object.entries(notFound)) check(`gateway: ${name} → 404`, r.status === 404 && r.body?.code === "resource_not_found", `HTTP ${r.status}`);
check("gateway: all those 404s are identical (existence is never revealed)", new Set(Object.values(notFound).map((r) => masked(r.body))).size === 1);
const forbidden = await gw(`/v1/merchants/${M.northwindUk}`, bearer(t.dev.access_token));
check("gateway: merchant.dev (MDEV, no MERCHANT.PROFILE.READ) on their own merchant → 403", forbidden.status === 403 && forbidden.body?.code === "permission_denied");
check("gateway: merchant.owner (tenant-wide) reads the sibling merchant (200)", (await gw(`/v1/merchants/${M.northwindEu}`, bearer(t.owner.access_token))).status === 200);
check("gateway: super.admin (no grant) → 404", (await gw(`/v1/merchants/${M.northwindUk}`, bearer(t.superAdmin.access_token))).status === 404);
const mdev = client();
await mdev.login("merchant.dev");
check("console: merchant.dev has no payments permission → 403", (await mdev.get("/api/v1/payments")).status === 403);
check("console: merchant.ops asking for another tenant's merchant → 404", (await mops.get(`/api/v1/overview/kpis?period=7d&currency=GBP&merchantId=${M.alderBooks}`)).status === 404);
check("console: merchant.ops opening another tenant's payment → 404", !!alderPayment && (await mops.get(`/api/v1/payments/${alderPayment}`)).status === 404);

// =============================================================================
console.log("\n(waiting 61 s: the console allows 10 password checks a minute; the 5 s token also expires)");
await sleep(Math.max(61_000, expiredAt - Date.now()));
check("gateway: the expired token → 401", (await gw(`/v1/merchants/${M.northwindUk}`, bearer(shortLived))).status === 401);

// =============================================================================
section("4. Forged tenant and role claims, headers and metadata change nothing");
const forgedHeaders = { "X-Tenant-Id": T.alder, "X-Zp-Tenant": T.alder, "X-Zp-Persona": "MOWN", "X-Role": "SUPER_ADMIN", "X-Zp-Subject": SUB.owner, "X-Forwarded-User": "super.admin" };
const hdrAlder = await gw(`/v1/merchants/${M.alderBooks}?tenant_id=${T.alder}&persona=MOWN&subject=${SUB.owner}`, ops, forgedHeaders);
check("gateway: forged headers and query values do not open another tenant (404)", hdrAlder.status === 404);
const hdrPrincipal = await gw(`/v1/principal?tenant_id=${T.alder}`, ops, forgedHeaders);
check("gateway: forged headers do not change the principal", hdrPrincipal.body?.grants?.length === 1 && hdrPrincipal.body.grants[0].persona === "mops");
const hdrConsole = await mops.get("/api/v1/me", forgedHeaders);
check("console: forged headers on a real session do not change the role", hdrConsole.body?.data?.personas?.join() === "MOPS");
const noSession = await fetch(`${CONSOLE}/api/v1/me`, { headers: { ...forgedHeaders, authorization: ops } });
check("console: a bearer token and forged headers without a session get 401", noSession.status === 401);

// Make Keycloak itself put forged claims in real, validly signed tokens: realm
// roles, hard-coded tenant and persona claims, and user metadata.
const roleNames = ["SUPER_ADMIN", "MOWN"];
let forgedOps;
let forgedSupport;
try {
  for (const name of roleNames) await admin("POST", "/roles", { name, description: "e2e forged role (removed after the run)" });
  const roles = await Promise.all(roleNames.map((n) => admin("GET", `/roles/${n}`)));
  for (const s of [SUB.ops, SUB.support]) await admin("POST", `/users/${s}/role-mappings/realm`, roles);
  const claim = (name, value, type = "String") => ({ name: `e2e-forged-${name}`, protocol: "openid-connect", protocolMapper: "oidc-hardcoded-claim-mapper",
    config: { "claim.name": name, "claim.value": value, "jsonType.label": type, "access.token.claim": "true", "id.token.claim": "true", "userinfo.token.claim": "true" } });
  for (const m of [claim("tenant_id", T.alder), claim("merchant_id", M.alderBooks), claim("persona", "MOWN"),
    claim("user_metadata", JSON.stringify({ tenant_id: T.alder, role: "SUPER_ADMIN" }), "JSON")]) {
    await admin("POST", `/clients/${consoleClient.id}/protocol-mappers/models`, m);
  }
  forgedOps = (await userTokens("merchant.ops")).access_token;
  forgedSupport = (await userTokens("support.agent")).access_token;
  const c = decode(forgedOps);
  check("the forged claims really are in Keycloak-signed tokens", c.tenant_id === T.alder && c.persona === "MOWN"
    && c.user_metadata?.role === "SUPER_ADMIN" && c.realm_access?.roles?.includes("SUPER_ADMIN") && header(forgedOps).kid === kcKey.kid);

  const p1 = await gw("/v1/principal", bearer(forgedOps));
  check("gateway: merchant.ops with forged claims still holds only MOPS on Northwind UK", p1.body?.grants?.length === 1 && p1.body.grants[0].persona === "mops");
  check("gateway: forged tenant claim does not open that tenant (404)", (await gw(`/v1/merchants/${M.alderBooks}`, bearer(forgedOps))).status === 404);
  check("gateway: support.agent with SUPER_ADMIN/MOWN claims holds nothing", (await gw("/v1/principal", bearer(forgedSupport))).body?.grants?.length === 0);
  check("gateway: support.agent with forged claims → 404 on a Northwind merchant", (await gw(`/v1/merchants/${M.northwindUk}`, bearer(forgedSupport))).status === 404);
  const sup = client();
  await sup.login("support.agent");
  const supMe = (await sup.get("/api/v1/me")).body?.data;
  check("console: support.agent signed in with forged claims has no access", supMe?.hasAccess === false && supMe?.personas?.length === 0);
  const mops2 = client();
  await mops2.login("merchant.ops");
  check("console: merchant.ops signed in with forged claims is still MOPS on Northwind UK only",
    (await mops2.get("/api/v1/me")).body?.data?.personas?.join() === "MOPS" && same(merchantsOf(await mops2.get("/api/v1/payments?pageSize=100")), new Set([M.northwindUk])));
} catch (e) {
  check("forged-claims setup completed", false, e.message);
} finally {
  // Remove every forged mapper by name, even if setup stopped half way.
  await undo("forged claim mappers", async () => {
    for (const m of await admin("GET", `/clients/${consoleClient.id}/protocol-mappers/models`)) {
      if (m.name.startsWith("e2e-forged-")) await admin("DELETE", `/clients/${consoleClient.id}/protocol-mappers/models/${m.id}`);
    }
  });
  await undo("forged realm roles", async () => { for (const name of roleNames) await admin("DELETE", `/roles/${name}`); });
}
const after = decode((await userTokens("merchant.ops")).access_token);
check("the realm is back as imported (forged claims and roles removed)", after.tenant_id === undefined && !after.realm_access?.roles?.includes("SUPER_ADMIN"));

// =============================================================================
section("5. A revoked grant is denied on the next request");
const fin = client();
await fin.login("merchant.finance");
const finToken = bearer(t.finance.access_token);
check("before: merchant.finance reads a Northwind merchant through the gateway", (await gw(`/v1/merchants/${M.northwindUk}`, finToken)).status === 200);
check("before: merchant.finance sees Northwind payments in the console", (await fin.get("/api/v1/payments?pageSize=100")).status === 200);
const ownerToken = bearer(t.owner.access_token);
const finGrant = await grantOf(ownerToken, SUB.finance, "mfin");
const revokedFin = await gwPost(`/v1/tenants/${T.northwind}/memberships/${finGrant}/revocation`, ownerToken, { reason: "end-to-end revocation check" });
check("Northwind's owner revokes the MFIN grant through the gateway", revokedFin.status === 200 && !!revokedFin.body?.revoked_at, `HTTP ${revokedFin.status}`);
check("gateway, same token, next request → 404", (await gw(`/v1/merchants/${M.northwindUk}`, finToken)).status === 404);
check("gateway, same token: the principal lists no grant", (await gw("/v1/principal", finToken)).body?.grants?.length === 0);
check("console, same session, next request: payments denied", (await fin.get("/api/v1/payments")).status === 403);
check("console, same session: no access left", (await fin.get("/api/v1/me")).body?.data?.hasAccess === false);
reseed();
check("a new grant restores access on the next request (gateway and console)",
  (await gw(`/v1/merchants/${M.northwindUk}`, finToken)).status === 200 && (await fin.get("/api/v1/payments")).status === 200);

// =============================================================================
section("5b. Grant administration: invite, accept, request, approve, access works, revoke, denied");
// A fresh synthetic person, created in the local realm for this run only.
const memberName = `e2e.member${Date.now().toString().slice(-6)}`;
const memberPassword = "Member#Pass1"; // synthetic, local realm only
await admin("POST", "/users", { username: memberName, enabled: true, email: `${memberName}@example.test`, emailVerified: true,
  firstName: "E2E", lastName: "Member", credentials: [{ type: "password", value: memberPassword, temporary: false }] });
const memberSub = (await admin("GET", `/users?username=${encodeURIComponent(memberName)}&exact=true`))?.[0]?.id;
const memberToken = bearer(keep((await tokenRequest(ISSUER, { grant_type: "password", client_id: CONSOLE_CLIENT.id,
  client_secret: CONSOLE_CLIENT.secret, username: memberName, password: memberPassword, scope: "openid profile" })).access_token));
const ownerBToken = bearer((await userTokens("merchant.owner.b")).access_token);
const tenantPath = `/v1/tenants/${T.northwind}`;

const inviteKey = idemKey();
const invite = await gwPost(`${tenantPath}/invitations`, ownerToken, undefined, { "idempotency-key": inviteKey });
const invitationToken = keep(invite.body?.token);
check("owner invites: 201, a pending inv_ with a one-time zpinv_ token", invite.status === 201 && invite.body?.status === "pending"
  && /^inv_/.test(invite.body?.id ?? "") && /^zpinv_/.test(invitationToken ?? ""), `HTTP ${invite.status}`);
const inviteReplay = await gwPost(`${tenantPath}/invitations`, ownerToken, undefined, { "idempotency-key": inviteKey });
check("a retried invitation (same key) returns the same invitation without the token", inviteReplay.status === 200
  && inviteReplay.body?.id === invite.body?.id && inviteReplay.body?.token === undefined);
check("merchant.ops (not an owner) cannot invite → 403", (await gwPost(`${tenantPath}/invitations`, ops)).status === 403);
check("another tenant's caller gets 404 for Northwind's invitations", (await gwPost(`${tenantPath}/invitations`, bearer(t.superAdmin.access_token))).status === 404);

const accepted = await gwPost("/v1/invitations/accept", memberToken, { token: invitationToken });
check("the invitee accepts with the token in the body", accepted.status === 200 && accepted.body?.accepted_by?.subject === memberSub, `HTTP ${accepted.status}`);
check("the same token cannot be used again (replay) → 404", (await gwPost("/v1/invitations/accept", memberToken, { token: invitationToken })).status === 404);
check("accepting grants nothing yet", (await gw("/v1/principal", memberToken)).body?.grants?.length === 0
  && (await gw(`/v1/merchants/${M.northwindUk}`, memberToken)).status === 404);

const window = (days) => ({ effective_from: new Date().toISOString(), expires_at: new Date(Date.now() + days * 86_400_000).toISOString() });
const accessReq = await gwPost(`${tenantPath}/access_requests`, ownerToken,
  { invitation_id: invite.body?.id, merchant_id: M.northwindUk, persona: "mview", purpose: "end-to-end grant check", ...window(7) });
check("owner (maker) requests MVIEW on Northwind UK: awaiting independent approval", accessReq.status === 201
  && accessReq.body?.status === "awaiting_independent_approval" && accessReq.etag === '"access-request-v1"', `HTTP ${accessReq.status}`);
const reqPath = `${tenantPath}/access_requests/${accessReq.body?.id}`;
const v1 = { "if-match": '"access-request-v1"' };
check("the maker cannot approve their own request → 409 sod_conflict", (await gwPost(`${reqPath}/approval`, ownerToken, undefined, v1)).body?.code === "sod_conflict");
check("the member cannot approve it → 404 (not a member of the tenant yet)", (await gwPost(`${reqPath}/approval`, memberToken, undefined, v1)).status === 404);
check("merchant.ops (not an owner) cannot approve → 403", (await gwPost(`${reqPath}/approval`, ops, undefined, v1)).status === 403);
const above = await gwPost(`${tenantPath}/access_requests`, ownerToken,
  { invitation_id: invite.body?.id, persona: "mfin", purpose: "outlasts the owner", ...window(400) });
check("a role outlasting the maker's own owner grant → 403 delegation_exceeded", above.status === 403 && above.body?.code === "delegation_exceeded");
const ownerRole = await gwPost(`${tenantPath}/access_requests`, ownerToken,
  { invitation_id: invite.body?.id, persona: "mown", purpose: "owner role", ...window(7) });
check("an owner role cannot be requested → 403", ownerRole.status === 403);
check("a stale If-Match → 409 version_conflict", (await gwPost(`${reqPath}/approval`, ownerBToken, undefined, { "if-match": '"access-request-v9"' })).body?.code === "version_conflict");
const approval = await gwPost(`${reqPath}/approval`, ownerBToken, undefined, v1);
check("a second owner (checker) approves: the grant exists", approval.status === 200 && approval.body?.status === "approved"
  && /^mbr_/.test(approval.body?.membership_id ?? ""), `HTTP ${approval.status}`);

const memberRead = await gw(`/v1/merchants/${M.northwindUk}`, memberToken);
check("access works: the member reads Northwind UK", memberRead.status === 200 && memberRead.body?.id === M.northwindUk);
const memberGrants = (await gw("/v1/principal", memberToken)).body?.grants ?? [];
check("the member's principal is exactly MVIEW on Northwind UK", memberGrants.length === 1 && memberGrants[0].persona === "mview" && memberGrants[0].merchant_id === M.northwindUk);
check("…and not Northwind EU", (await gw(`/v1/merchants/${M.northwindEu}`, memberToken)).status === 404);
const memberConsole = client();
await memberConsole.login(memberName, memberPassword);
check("in the console the member is MVIEW and sees Northwind UK only",
  (await memberConsole.get("/api/v1/me")).body?.data?.personas?.join() === "MVIEW"
  && same(merchantsOf(await memberConsole.get("/api/v1/payments?pageSize=100")), new Set([M.northwindUk])));

const revoke = await gwPost(`${tenantPath}/memberships/${approval.body?.membership_id}/revocation`, ownerToken, { reason: "end-to-end flow done" });
check("the owner revokes the grant", revoke.status === 200 && revoke.body?.revoked_by?.subject === SUB.owner, `HTTP ${revoke.status}`);
check("denied: the same token's next request → 404", (await gw(`/v1/merchants/${M.northwindUk}`, memberToken)).status === 404);
check("denied: the same console session's next request has no access", (await memberConsole.get("/api/v1/me")).body?.data?.hasAccess === false);

const events = asSuperuser(`SELECT string_agg(event_type, ',' ORDER BY occurred_at_utc) FROM merchant.grant_events
  WHERE invitation_id = '${invite.body?.id}' OR access_request_id = '${accessReq.body?.id}' OR membership_id = '${approval.body?.membership_id}';`);
check("every change left a grant event", events === "INVITATION_CREATED,INVITATION_ACCEPTED,ACCESS_REQUESTED,ACCESS_APPROVED,GRANT_CREATED,GRANT_REVOKED", events);
let direct = "";
try {
  asGateway(`BEGIN;
SELECT set_config('zp.tenant_id', '${T.northwind}', true) \\g /dev/null
INSERT INTO merchant.memberships (id, issuer, subject, tenant_id, environment, persona, granted_by_issuer, granted_by_subject,
  approved_by_issuer, approved_by_subject, granted_at_utc, effective_from_utc, expires_at_utc)
VALUES (uuidv7(), '${ISSUER}', '${memberSub}', '${T.northwind}', 'TEST', 'MOWN', '${ISSUER}', '${SUB.owner}', '${ISSUER}', '${SUB.ownerB}', now(), now(), now() + interval '1 day');
COMMIT;`);
} catch (e) {
  direct = String(e.stderr ?? e.message);
}
check("the database itself refuses a grant the runtime role writes directly", /owner grants are created only by tenant provisioning|approved access request/.test(direct));
const noToken = asSuperuser(`SELECT count(*) FROM merchant.invitations WHERE position('zpinv_' in encode(token_hash, 'escape')) > 0;`);
check("only the invitation token's hash is stored", noToken === "0");

// Screens and step-up with real password re-entry.
const refunds = await mops.get("/api/v1/screens/ZP-BRW-008");
check("console: merchant.ops opens Refunds (ZP-BRW-008), own merchant's records only", refunds.status === 200 && (refunds.body?.data?.items ?? []).every((r) => r.merchantId === M.northwindUk));
check("console: merchant.ops cannot open Payouts (ZP-BRW-010)", [403, 404].includes((await mops.get("/api/v1/screens/ZP-BRW-010")).status));
check("console: wrong password at re-entry is refused by Keycloak", (await mops.post("/auth/reauth", { password: "wrong" })).status === 401);
check("console: password re-entry succeeds through Keycloak", (await mops.post("/auth/reauth", { password: PASSWORD })).status === 200);

// =============================================================================
console.log("\n(waiting 61 s for the console's sign-in rate limit)");
await sleep(61_000);
section("6. Account creation and password change (real Keycloak)");
const uname = `e2e.user${Date.now().toString().slice(-6)}`;
check("create account succeeds", (await client().post("/auth/register", { username: uname, firstName: "E2E", lastName: "User", email: `${uname}@example.test`, password: "First#Pass1" })).status === 201, uname);
check("weak password is refused", (await client().post("/auth/register", { username: `${uname}x`, firstName: "E2E", lastName: "User", email: `${uname}x@example.test`, password: "weak" })).status === 400);
const fresh = client();
check("new account can sign in", (await fresh.login(uname, "First#Pass1")).status === 200);
check("new account has no grant, so no access (deny by default)", (await fresh.get("/api/v1/me")).body?.data?.hasAccess === false && (await fresh.get("/api/v1/overview/kpis")).status === 403);
check("change password succeeds", (await client().post("/auth/change-password", { username: uname, currentPassword: "First#Pass1", newPassword: "Second#Pass2" })).status === 200);
check("old password no longer works", (await client().login(uname, "First#Pass1")).status === 401);
check("new password works", (await client().login(uname, "Second#Pass2")).status === 200);
const out = await mops.post("/auth/logout", {});
check("sign-out succeeds and ends the session", out.status === 200 && (await mops.get("/api/v1/me")).status === 401);

// =============================================================================
section("7. Every request leaves an audit entry");
await sleep(500);
const rows = JSON.parse(asSuperuser(`SELECT coalesce(json_agg(json_build_object('trace', trace_id, 'action', action, 'outcome', outcome,
  'subject', actor_subject, 'tenant', tenant_id, 'status', http_status, 'reason', reason)), '[]') FROM governance.audit_events;`));
const byTrace = new Map();
for (const r of rows) byTrace.set(r.trace, [...(byTrace.get(r.trace) ?? []), r]);
const traced = gatewayCalls.filter((c) => c.trace);
check(`gateway: every one of the ${gatewayCalls.length} direct requests carried a trace ID`, traced.length === gatewayCalls.length);
const missing = traced.filter((c) => byTrace.get(c.trace)?.length !== 1);
check(`audit: each of those requests has exactly one entry`, missing.length === 0, missing.length ? `${missing.length} without exactly one` : `${traced.length} entries`);
const entries = traced.map((c) => ({ c, e: byTrace.get(c.trace)?.[0] })).filter((x) => x.e);
check("audit: each entry's status matches the response", entries.every(({ c, e }) => e.status === c.status));
const outcomeOf = (s) => (s < 400 ? "ALLOWED" : s >= 500 ? "FAILED" : "DENIED");
check("audit: outcomes are ALLOWED / DENIED / FAILED by status", entries.every(({ c, e }) => e.outcome === outcomeOf(c.status)));
check("audit: a 401 never records an actor (rejected claims are not trusted)", entries.filter(({ c }) => c.status === 401).every(({ e }) => e.subject === null));
check("audit: a 404 never records a tenant (no existence leak)", entries.filter(({ c }) => c.status === 404).every(({ e }) => e.tenant === null));
check("audit: a 200 or 403 on a merchant records the caller's own tenant",
  entries.filter(({ c }) => c.path.startsWith("/v1/merchants/") && [200, 403].includes(c.status)).every(({ e }) => e.tenant === T.northwind));
const viewerReads = rows.filter((r) => r.action === "getPrincipal" && r.subject === SUB.viewer);
check("audit: every console request reads grants through the gateway and is audited (merchant.viewer: 3 requests, 3 entries)",
  viewerReads.length === 3 && viewerReads.every((r) => r.outcome === "ALLOWED"), `${viewerReads.length} entries`);
const auditText = asSuperuser("SELECT coalesce(string_agg(row_to_json(a)::text, E'\\n'), '') FROM governance.audit_events a;");
check("audit: no entry contains a token", !auditText.includes("eyJ") && [...secrets].every((s) => !auditText.includes(s)));

// =============================================================================
section("8. No token in any log");
const tokenParts = [...secrets].flatMap((s) => [s, ...s.split(".").filter((p) => p.length >= 40)]);
const tokenIn = (text) => tokenParts.find((p) => text.includes(p));
if (!LOG_DIR) {
  skip("gateway, console backend and frontend logs", "set E2E_LOG_DIR, or run `make e2e-auth`");
} else {
  for (const name of ["gateway.log", "backend.log", "frontend.log"]) {
    const file = join(LOG_DIR, name);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const lines = text.split("\n").filter(Boolean).length;
    check(`${name}: not empty (${lines} lines), no token, no "eyJ", no password`,
      lines > 0 && !tokenIn(text) && !text.includes("eyJ") && !text.includes(PASSWORD) && !text.includes("Second#Pass2"));
  }
  const gwLog = readFileSync(join(LOG_DIR, "gateway.log"), "utf8");
  check("gateway.log has one line per direct request (the scan saw real traffic)", traced.every((c) => gwLog.includes(c.trace)));
}
const since = env.E2E_STARTED_AT;
for (const svc of ["keycloak", "postgres"]) {
  const text = execFileSync("docker", [...COMPOSE, "logs", "--no-color", ...(since ? ["--since", since] : []), svc], { encoding: "utf8", maxBuffer: 64 << 20 });
  check(`${svc} container log: no token from this run`, !tokenIn(text));
}

finish();
