// End-to-end check against the REAL stack: Keycloak realm "zoikopay", the
// console backend (4000) and the frontend server (5173, proxying /api and /auth).
//
// Prerequisites: `make up` (repo root), backend running, frontend running.
// Run: npm run test:e2e   (from backend)

const CONSOLE = process.env.E2E_CONSOLE_URL ?? "http://localhost:5173";
const PASSWORD = process.env.E2E_PASSWORD ?? "Zoiko@123";
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
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return {
    get: (p) => call("GET", p),
    post: (p, b, origin) => call("POST", p, b, origin),
    put: (p, b) => call("PUT", p, b),
    login: (username, password = PASSWORD) => call("POST", "/auth/login", { username, password }),
  };
}

// --- 1. Sign-in form ------------------------------------------------------
const bad = client();
const wrong = await bad.login("ops.agent", "wrong-password");
check("wrong password is rejected by Keycloak", wrong.status === 401 && wrong.body?.code === "INVALID_CREDENTIALS");
check("no session after a failed sign-in", (await bad.get("/api/v1/me")).status === 401);
const unknown = await bad.login("no.such.user");
check("unknown user gets the same answer", unknown.status === 401 && unknown.body?.code === "INVALID_CREDENTIALS");
const csrf = await client().post("/auth/login", { username: "ops.agent", password: PASSWORD }, "https://evil.example");
check("sign-in posted from another site is refused", csrf.status === 403 && csrf.body?.code === "ORIGIN_REJECTED");

const ops = client();
const ok = await ops.login("ops.agent");
check("ops.agent signs in with the console's own form", ok.status === 200, `HTTP ${ok.status}`);
const me = await ops.get("/api/v1/me");
check("session resolves to persona POR in TEST", me.body?.data?.personas?.[0] === "POR" && me.body?.data?.environment === "TEST");

// --- 2. Dashboard data and access rules -------------------------------------
const kpis = await ops.get("/api/v1/overview/kpis?period=7d&currency=GBP");
check("dashboard KPIs load", kpis.status === 200 && kpis.body?.data?.kpis?.length === 6);
const pays = await ops.get("/api/v1/payments?pageSize=100");
const cells = new Set(pays.body?.data?.items?.map((p) => p.legalEntityId));
check("ops.agent sees payments only from cell_uk_01", pays.status === 200 && cells.size === 1 && cells.has("cell_uk_01"));
check("data is labelled as mock data", pays.body?.meta?.source === "fixture");
const first = pays.body?.data?.items?.[0]?.id;
const detail = first && (await ops.get(`/api/v1/payments/${first}`));
check("payment detail with evidence timeline loads", detail?.status === 200 && detail?.body?.data?.timeline?.length > 0);

const admin = client();
await admin.login("super.admin");
check("super.admin is denied transaction details", (await admin.get("/api/v1/payments")).status === 403);
const adminKpis = await admin.get("/api/v1/overview/kpis?period=7d&currency=GBP");
const vol = adminKpis.body?.data?.kpis?.find((k) => k.key === "volume");
check("super.admin gets counts but no money amounts", vol?.restricted === true && vol?.value === null);
const health = await admin.get("/api/v1/system/health");
check("system health is probed live", health.body?.data?.source === "live-service",
  `${health.body?.data?.services?.filter((s) => s.ok).length}/${health.body?.data?.services?.length} ok`);

const env = await ops.put("/api/v1/session/environment", { environment: "LIVE" });
check("ops.agent cannot switch to LIVE", env.status === 403);

// --- 3. Spec screens, two-person decision with real password re-entry --------
check("ops.agent opens Routing (ZP-BRW-006)", (await ops.get("/api/v1/screens/ZP-BRW-006")).status === 200);
check("ops.agent is refused Payouts (ZP-BRW-010)", (await ops.get("/api/v1/screens/ZP-BRW-010")).status === 403);
const finA = client();
await finA.login("fin.controller.a");
const aRows = (await finA.get("/api/v1/screens/ZP-BRW-010?status=REQUIRES_APPROVAL")).body?.data?.items ?? [];
const own = aRows.find((r) => r.isOwnRequest);
const self = own && (await finA.post(`/api/v1/screens/ZP-BRW-010/records/${own.id}/actions/approve`, { version: own.version }));
check("maker cannot approve their own payout", self?.body?.code === "SELF_APPROVAL_PROHIBITED");

const finB = client();
await finB.login("fin.controller.b");
let rows = (await finB.get("/api/v1/screens/ZP-BRW-010?status=REQUIRES_APPROVAL")).body?.data?.items ?? [];
let target = rows.find((r) => r.actions.find((a) => a.name === "approve")?.allowed);
const noStep = target && (await finB.post(`/api/v1/screens/ZP-BRW-010/records/${target.id}/actions/approve`, { version: target.version }));
check("checker without password re-entry is refused", noStep?.body?.code === "STEP_UP_REQUIRED");
const wrongPw = await finB.post("/auth/reauth", { password: "wrong" });
check("wrong password at re-entry is refused by Keycloak", wrongPw.status === 401);
const reauth = await finB.post("/auth/reauth", { password: PASSWORD });
check("password re-entry succeeds through Keycloak", reauth.status === 200);
const approved = target && (await finB.post(`/api/v1/screens/ZP-BRW-010/records/${target.id}/actions/approve`, { version: target.version }));
check("independent checker approves after re-entry", approved?.status === 200 && approved?.body?.data?.status === "READY", target?.id);

const sec = client();
await sec.login("security.officer");
const audit = await sec.get("/api/v1/audit?limit=500");
check("approval is in the audit log and the chain verifies",
  audit.body?.data?.verification?.valid === true && audit.body?.data?.items?.some((e) => e.action === "screen.ZP-BRW-010.approve" && e.outcome === "SUCCEEDED"));

const mops = client();
await mops.login("merchant.ops");
const sb = await mops.post("/api/v1/sandbox/payment-intents", { merchantId: "mer_northwind_uk", amount_minor: "1999", currency: "GBP", capture_mode: "automatic", order_ref: "E2E-1" });
check("sandbox intent without Idempotency-Key is refused", sb.status === 400);
const hits = await finB.get("/api/v1/search?q=po_");
check("global search returns records the caller may open", hits.status === 200 && hits.body?.data?.length > 0);
const notes = await finB.get("/api/v1/notifications");
check("notifications list decisions awaiting the caller", notes.status === 200 && Array.isArray(notes.body?.data));

// --- 4. Create account and change password (real Keycloak) --------------------
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
check("new account has no role (deny by default)", freshMe.body?.data?.hasAccess === false && (await fresh.get("/api/v1/overview/kpis")).status === 403);
const cp = await client().post("/auth/change-password", { username: uname, currentPassword: "First#Pass1", newPassword: "Second#Pass2" });
check("change password succeeds", cp.status === 200);
check("old password no longer works", (await client().login(uname, "First#Pass1")).status === 401);
check("new password works", (await client().login(uname, "Second#Pass2")).status === 200);

// --- 5. Sign-out ------------------------------------------------------------
const out = await ops.post("/auth/logout", {});
check("sign-out succeeds", out.status === 200);
check("session is gone after sign-out", (await ops.get("/api/v1/me")).status === 401);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll end-to-end checks passed");
process.exit(failures ? 1 : 0);
