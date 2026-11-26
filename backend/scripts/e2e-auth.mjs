// End-to-end check against the REAL stack: Keycloak realm "zoikopay", the Go
// gateway (8080) reading merchant.memberships in Postgres, the console backend
// (4000) and the frontend server (5173, proxying /api and /auth).
//
// Roles come only from merchant.memberships through the gateway (OPEN_QUESTIONS
// Q39). This script revokes a real grant in Postgres mid-session and checks the
// very next console request is denied, then restores it with a new grant.
//
// Prerequisites (repo root): `make up`, `make migrate`, `make seed-local`,
// `make run-gateway`; then the backend and frontend dev servers.
// Run: npm run test:e2e   (from backend)
//
// SYNTHETIC DATA ONLY: local realm users and the local seed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONSOLE = process.env.E2E_CONSOLE_URL ?? "http://localhost:5173";
const GATEWAY = process.env.E2E_GATEWAY_URL ?? "http://localhost:8080";
const PASSWORD = process.env.E2E_PASSWORD ?? "Zoiko@123";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ISSUER = "http://localhost:8180/realms/zoikopay";

// Same IDs as backend/src/database/fixtures.ts and scripts/seed-local.sql.
const NORTHWIND = "ten_019a0000000170008000000000000001";
const NORTHWIND_UK = "mer_019a0000010170008000000000000101";
const NORTHWIND_EU = "mer_019a0000010270008000000000000102";
const ALDER_BOOKS = "mer_019a0000020170008000000000000201";
const ALDER_TRAVEL = "mer_019a0000020270008000000000000202";
const MERCHANT_FINANCE_SUB = "00000000-0000-4000-8000-000000000014";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

/** A browser-like client: keeps the session cookie and sends the console Origin on writes. */
function client() {
  let cookie = "";
  async function call(method, path, body, origin = CONSOLE) {
    const res = await fetch(`${CONSOLE}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(origin && method !== "GET" ? { origin } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith("zp_console_sid=")) cookie = c.split(";")[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, raw: text, setCookie: set.join("; ") };
  }
  return {
    get: (p) => call("GET", p),
    post: (p, b, origin) => call("POST", p, b, origin),
    put: (p, b) => call("PUT", p, b),
    login: (username, password = PASSWORD) => call("POST", "/auth/login", { username, password }),
  };
}

/** Runs SQL in the local Postgres container as zp_gateway (BC-01's runtime role), so RLS applies. */
function psqlAsGateway(sql) {
  return execFileSync("docker", ["compose", "-f", join(REPO, "deploy", "compose", "compose.yaml"), "exec", "-T",
    "-e", `PGPASSWORD=${process.env.ZP_APP_PASSWORD ?? "local-dev-only-app"}`, "postgres",
    "psql", "-X", "-q", "-A", "-t", "-h", "localhost", "-U", "zp_gateway", "-d", "zoikopay", "-v", "ON_ERROR_STOP=1", "-f", "-"],
  { input: sql, encoding: "utf8" });
}

const merchantsOf = (res) => new Set(res.body?.data?.items?.map((p) => p.merchantId));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// --- 0. The gateway is the real one ------------------------------------------
const gw = await fetch(`${GATEWAY}/v1/principal`);
check("gateway GET /v1/principal without a token is 401", gw.status === 401);

// --- 1. Sign-in form ------------------------------------------------------
const bad = client();
const wrong = await bad.login("merchant.ops", "wrong-password");
check("wrong password is rejected by Keycloak", wrong.status === 401 && wrong.body?.code === "INVALID_CREDENTIALS");
check("no session after a failed sign-in", (await bad.get("/api/v1/me")).status === 401);
const unknown = await bad.login("no.such.user");
check("unknown user gets the same answer", unknown.status === 401 && unknown.body?.code === "INVALID_CREDENTIALS");
const csrf = await client().post("/auth/login", { username: "merchant.ops", password: PASSWORD }, "https://evil.example");
check("sign-in posted from another site is refused", csrf.status === 403 && csrf.body?.code === "ORIGIN_REJECTED");

// --- 2. Roles come from merchant.memberships through the gateway -------------
const mops = client();
const ok = await mops.login("merchant.ops");
check("merchant.ops signs in with the console's own form", ok.status === 200, `HTTP ${ok.status}`);
check("no token reaches the browser at sign-in", !/eyJ|refresh|access_token/i.test(ok.raw + ok.setCookie));
const me = await mops.get("/api/v1/me");
check("merchant.ops resolves to MOPS in TEST from their grant", me.body?.data?.personas?.join() === "MOPS" && me.body?.data?.environment === "TEST",
  me.body?.data?.personas?.join());
check("/me carries no token", !/eyJ/.test(me.raw));
const pays = await mops.get("/api/v1/payments?pageSize=100");
check("merchant.ops sees payments of Northwind UK only (merchant grant)", pays.status === 200 && same(merchantsOf(pays), new Set([NORTHWIND_UK])));
check("data is labelled as mock data", pays.body?.meta?.source === "fixture");
const first = pays.body?.data?.items?.[0]?.id;
const detail = first && (await mops.get(`/api/v1/payments/${first}`));
check("payment detail with evidence timeline loads", detail?.status === 200 && detail?.body?.data?.timeline?.length > 0);
const scope = await mops.get("/api/v1/scope");
check("legal entity comes from the covered merchant only (39.2)", scope.body?.data?.legalEntities?.map((e) => e.id).join() === "cell_uk_01");
const kpis = await mops.get("/api/v1/overview/kpis?period=7d&currency=GBP");
check("dashboard KPIs load", kpis.status === 200 && kpis.body?.data?.kpis?.length === 6);
check("merchant.ops cannot switch to LIVE", (await mops.put("/api/v1/session/environment", { environment: "LIVE" })).status === 403);
const forged = await fetch(`${CONSOLE}/api/v1/me`, { headers: { cookie: "", "x-zp-persona": "SUPER_ADMIN", "x-tenant-id": NORTHWIND, authorization: "Bearer forged" } });
check("forged headers without a session get nothing", forged.status === 401);

const owner = client();
await owner.login("merchant.owner");
const ownerPays = await owner.get("/api/v1/payments?pageSize=100");
check("merchant.owner (tenant-wide MOWN) sees both Northwind merchants and nothing else",
  (await owner.get("/api/v1/me")).body?.data?.personas?.join() === "MOWN" && same(merchantsOf(ownerPays), new Set([NORTHWIND_UK, NORTHWIND_EU])));
const access = await owner.get("/api/v1/access/members");
check("Access screen refuses grant administration (39.6)", access.status === 503 && access.body?.code === "GRANT_ADMINISTRATION_UNAVAILABLE");

const viewer = client();
await viewer.login("merchant.viewer");
check("merchant.viewer (MVIEW, Alder) sees Alder only",
  same(merchantsOf(await viewer.get("/api/v1/payments?pageSize=100")), new Set([ALDER_BOOKS, ALDER_TRAVEL])));
const audit = await viewer.get("/api/v1/audit?limit=500");
check("console audit chain verifies", audit.status === 200 && audit.body?.data?.verification?.valid === true);

// --- 3. No staff wildcard: staff personas never come from memberships (36.1, 39.3) ---
// A staff user's access is exactly their live rows in merchant.memberships,
// which hold merchant personas only: normally none, so no access at all.
const STAFF = { "super.admin": 1, "ops.agent": 2, "security.officer": 7, "iam.admin": 8, "fin.controller.a": 3 };
const STAFF_PERSONAS = ["SUPER_ADMIN", "POR", "PSUP", "PRISK", "PCOMP", "PRECON", "PFIN", "PPSP", "PIAM", "PSEC", "PSRE"];
for (const [username, n] of Object.entries(STAFF)) {
  const sub = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // The caller's own live grants, read the way the gateway reads them (own-grant RLS policy).
  const live = psqlAsGateway(`BEGIN;
SELECT set_config('zp.subject_issuer', '${ISSUER}', true), set_config('zp.subject', '${sub}', true) \\g /dev/null
SELECT persona FROM merchant.memberships ORDER BY tenant_id, merchant_id NULLS FIRST, persona;
COMMIT;`).trim().split("\n").filter(Boolean);
  const c = client();
  const login = await c.login(username);
  const m = (await c.get("/api/v1/me")).body?.data;
  const staffOnly = [await c.get("/api/v1/platform/summary"), await c.get("/api/v1/exceptional-access")].every((r) => r.status === 403);
  const noStaffPersona = !m?.personas?.some((p) => STAFF_PERSONAS.includes(p));
  const matchesDb = live.length === 0
    ? m?.hasAccess === false && m?.personas?.length === 0 && (await c.get("/api/v1/payments")).status === 403
    : m?.personas?.join() === live[0];
  check(`${username}: no staff persona, staff pages refused, access = their memberships rows`,
    login.status === 200 && noStaffPersona && staffOnly && matchesDb, live.length ? `holds a real ${live[0]} grant in Postgres` : "no grant: no access");
}

// --- 4. Revoke a real grant mid-session: denied on the next request ----------
console.log("(waiting 61 s for the sign-in rate limit window)");
await new Promise((r) => setTimeout(r, 61_000));
const fin = client();
await fin.login("merchant.finance");
const before = await fin.get("/api/v1/payments?pageSize=100");
check("merchant.finance (MFIN) sees Northwind payments before revocation", before.status === 200 && merchantsOf(before).size === 2);
const revoked = psqlAsGateway(`BEGIN;
SELECT set_config('zp.tenant_id', '${NORTHWIND}', true) \\g /dev/null
UPDATE merchant.memberships SET revoked_at_utc = now(), revoked_by_issuer = '${ISSUER}', revoked_by_subject = 'zp-e2e-revoker'
WHERE issuer = '${ISSUER}' AND subject = '${MERCHANT_FINANCE_SUB}' AND revoked_at_utc IS NULL RETURNING persona;
COMMIT;`).trim();
check("the MFIN grant is revoked in merchant.memberships", revoked === "MFIN", revoked);
const after = await fin.get("/api/v1/payments");
const afterMe = await fin.get("/api/v1/me");
check("same session, next request: payments denied", after.status === 403);
check("same session, next request: no access left", afterMe.status === 200 && afterMe.body?.data?.hasAccess === false);
psqlAsGateway(readFileSync(join(REPO, "scripts", "seed-local.sql"), "utf8"));
const restored = await fin.get("/api/v1/payments?pageSize=100");
check("a new grant (seed re-run) restores access on the next request", restored.status === 200 && merchantsOf(restored).size === 2);

// --- 5. Screens and step-up with real password re-entry ----------------------
const refunds = await mops.get("/api/v1/screens/ZP-BRW-008");
check("merchant.ops opens Refunds (ZP-BRW-008), own merchant's records only",
  refunds.status === 200 && (refunds.body?.data?.items ?? []).every((r) => r.merchantId === NORTHWIND_UK));
check("merchant.ops cannot open Payouts (ZP-BRW-010)", [403, 404].includes((await mops.get("/api/v1/screens/ZP-BRW-010")).status));
check("wrong password at re-entry is refused by Keycloak", (await mops.post("/auth/reauth", { password: "wrong" })).status === 401);
check("password re-entry succeeds through Keycloak", (await mops.post("/auth/reauth", { password: PASSWORD })).status === 200);
const sb = await mops.post("/api/v1/sandbox/payment-intents", { merchantId: NORTHWIND_UK, amount_minor: "1999", currency: "GBP", capture_mode: "automatic", order_ref: "E2E-1" });
check("sandbox intent without Idempotency-Key is refused", sb.status === 400);

// --- 6. Create account and change password (real Keycloak) --------------------
console.log("(waiting 61 s for the sign-in rate limit window)");
await new Promise((r) => setTimeout(r, 61_000));
const uname = `e2e.user${Date.now().toString().slice(-6)}`;
const reg = await client().post("/auth/register", { username: uname, firstName: "E2E", lastName: "User", email: `${uname}@example.test`, password: "First#Pass1" });
check("create account succeeds in Keycloak", reg.status === 201, uname);
const weak = await client().post("/auth/register", { username: `${uname}x`, firstName: "E2E", lastName: "User", email: `${uname}x@example.test`, password: "weak" });
check("weak password is refused", weak.status === 400);
const fresh = client();
check("new account can sign in", (await fresh.login(uname, "First#Pass1")).status === 200);
const freshMe = await fresh.get("/api/v1/me");
check("new account has no grant, so no access (deny by default)", freshMe.body?.data?.hasAccess === false && (await fresh.get("/api/v1/overview/kpis")).status === 403);
const cp = await client().post("/auth/change-password", { username: uname, currentPassword: "First#Pass1", newPassword: "Second#Pass2" });
check("change password succeeds", cp.status === 200);
check("old password no longer works", (await client().login(uname, "First#Pass1")).status === 401);
check("new password works", (await client().login(uname, "Second#Pass2")).status === 200);

// --- 7. Sign-out ------------------------------------------------------------
const out = await mops.post("/auth/logout", {});
check("sign-out succeeds", out.status === 200);
check("session is gone after sign-out", (await mops.get("/api/v1/me")).status === 401);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll end-to-end checks passed");
process.exit(failures ? 1 : 0);
