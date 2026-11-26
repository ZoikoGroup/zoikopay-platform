import request from "supertest";
import { describe, expect, it } from "vitest";
import { FIXTURE_IDS } from "../src/database/fixtures.js";
import { FixtureDataSource } from "../src/database/dataSource.js";
import { GatewayDirectory } from "../src/integrations/directory.js";
import { FakeGateway, wireGrant } from "./fakeGateway.js";
import { accessTokenFor, FakeIdp, makeTestApp, ORIGIN, PASSWORD, testConfig } from "./helpers.js";

/**
 * Plan step 8 (OPEN_QUESTIONS Q39): the console reads roles and scope only
 * from merchant.memberships through the Go gateway (GET /v1/principal), on
 * every request, with the signed-in user's own access token.
 */
const T = FIXTURE_IDS.tenants;
const M = FIXTURE_IDS.merchants;
const STAFF = ["super.admin", "ops.agent", "fin.controller.a", "risk.analyst", "support.agent", "security.officer",
  "iam.admin", "sre.oncall", "compliance.officer", "recon.analyst", "partner.ops"];

function setup(opts: { now?: () => number } = {}) {
  const gateway = new FakeGateway();
  const now = opts.now ?? Date.now;
  const idp = new FakeIdp(now);
  const directory = new GatewayDirectory({
    baseUrl: testConfig.gatewayUrl, issuer: testConfig.oidc.issuer, idp, data: new FixtureDataSource(now()), now, fetch: gateway.fetch,
  });
  const t = makeTestApp({ directory, idp, now: opts.now });
  const get = (path: string, cookie: string) => request(t.app).get(path).set("Cookie", cookie);
  return { ...t, gateway, get };
}

const merchantIdsOf = (res: request.Response) => new Set(res.body.data.items.map((p: { merchantId: string }) => p.merchantId));

describe("roles come only from merchant.memberships through the gateway (Q39)", () => {
  it("deny by default: a valid sign-in with no live grant gets no access", async () => {
    const t = setup();
    const cookie = t.loginAs("merchant.ops"); // the gateway holds no grant for them
    const me = await t.get("/api/v1/me", cookie);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ hasAccess: false, personas: [], permissions: [] });
    for (const path of ["/api/v1/overview/kpis", "/api/v1/payments", "/api/v1/scope"]) {
      expect((await t.get(path, cookie)).status, path).toBe(403);
    }
    expect((await t.get("/api/v1/screens/ZP-BRW-008", cookie)).status).toBe(403);
    t.gateway.set("merchant.ops", [wireGrant(T.northwind, M.northwindUk, "mops")]);
    expect((await t.get("/api/v1/screens/ZP-BRW-008", cookie)).status).toBe(200); // the same session, once a grant exists
  });

  it("production configuration needs an explicit https gateway URL", async () => {
    const { loadConfig } = await import("../src/config.js");
    const env = { NODE_ENV: "production", OIDC_ISSUER: "https://idp.test/realms/zoikopay", OIDC_CLIENT_ID: "console", OIDC_CLIENT_SECRET: "s",
      SESSION_SECRET: "a-valid-testing-secret-of-at-least-32-characters", ACCOUNT_ADMIN_CLIENT_SECRET: "rotated-test-only-secret" };
    expect(() => loadConfig(env)).toThrow(/GATEWAY_URL/);
    expect(() => loadConfig({ ...env, GATEWAY_URL: "http://gateway.test" })).toThrow(/GATEWAY_URL/);
    expect(loadConfig({ ...env, GATEWAY_URL: "https://gateway.test/" }).gatewayUrl).toBe("https://gateway.test");
  });

  it("security tests: unit-level proof that every gateway read carries a timeout and refuses redirects", async () => {
    const seen: RequestInit[] = [];
    const d = new GatewayDirectory({ baseUrl: "http://gw.test", issuer: testConfig.oidc.issuer, idp: new FakeIdp(), data: new FixtureDataSource(),
      fetch: async (_u, init) => { seen.push(init!); throw new TypeError("fetch failed"); } });
    const user = { sub: "s", username: "u", displayName: "U", loginAt: 0, authTime: 0, environment: "TEST" as const,
      accessToken: "at-x-0", accessTokenExpiresAt: Date.now() + 60 * 60_000 };
    await expect(d.current(user)).rejects.toMatchObject({ status: 503, code: "MEMBERSHIP_UNAVAILABLE" });
    expect(seen[0]!.redirect).toBe("error");
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("no staff wildcard: every platform-staff user gets nothing, Super Admin included (36.1, 39.3)", async () => {
    const t = setup();
    for (const username of STAFF) {
      const cookie = t.loginAs(username);
      const me = await t.get("/api/v1/me", cookie);
      expect(me.body.data, username).toMatchObject({ hasAccess: false, personas: [] });
      for (const path of ["/api/v1/platform/summary", "/api/v1/access/members", "/api/v1/exceptional-access", "/api/v1/payments"]) {
        expect((await t.get(path, cookie)).status, `${username} ${path}`).toBe(403);
      }
    }
  });

  it("a merchant grant gives that persona on that merchant only", async () => {
    const t = setup();
    t.gateway.set("merchant.ops", [wireGrant(T.northwind, M.northwindUk, "mops")]);
    const cookie = t.loginAs("merchant.ops");
    const me = await t.get("/api/v1/me", cookie);
    expect(me.body.data).toMatchObject({ hasAccess: true, personas: ["MOPS"], environments: ["TEST"] });
    expect(merchantIdsOf(await t.get("/api/v1/payments?pageSize=100", cookie))).toEqual(new Set([M.northwindUk]));
    const scope = await t.get("/api/v1/scope", cookie);
    expect(scope.body.data.merchants.map((m: { id: string }) => m.id)).toEqual([M.northwindUk]);
    // 2(a): the legal entity comes from the covered merchant's own record, never wider (narrows 36.17).
    expect(scope.body.data.legalEntities.map((e: { id: string }) => e.id)).toEqual(["cell_uk_01"]);
  });

  it("a tenant-wide grant covers every merchant of that tenant and nothing else", async () => {
    const t = setup();
    t.gateway.set("merchant.owner", [wireGrant(T.northwind, undefined, "mown")]);
    const cookie = t.loginAs("merchant.owner");
    expect(merchantIdsOf(await t.get("/api/v1/payments?pageSize=100", cookie))).toEqual(new Set([M.northwindUk, M.northwindEu]));
    const other = await t.get(`/api/v1/payments?merchantId=${M.alderBooks}`, cookie);
    expect(other.body.data.items).toEqual([]);
  });

  it("several grants are never combined: one active grant per request, in a fixed order", async () => {
    const t = setup();
    // MOPS on Northwind UK and MVIEW on all of Alder. Combining them would give MOPS on Alder.
    t.gateway.set("merchant.ops", [wireGrant(T.alder, undefined, "mview"), wireGrant(T.northwind, M.northwindUk, "mops")]);
    const cookie = t.loginAs("merchant.ops");
    const me = await t.get("/api/v1/me", cookie);
    expect(me.body.data.personas).toEqual(["MOPS"]); // Northwind sorts before Alder by tenant ID
    expect(merchantIdsOf(await t.get("/api/v1/payments?pageSize=100", cookie))).toEqual(new Set([M.northwindUk]));
  });

  it("roles are not cached: a revoked grant stops working on the very next request", async () => {
    const t = setup();
    t.gateway.set("merchant.finance", [wireGrant(T.northwind, undefined, "mfin")]);
    const cookie = t.loginAs("merchant.finance");
    expect((await t.get("/api/v1/payments", cookie)).status).toBe(200);
    const before = t.gateway.calls.length;
    t.gateway.revokeAll("merchant.finance");
    expect((await t.get("/api/v1/payments", cookie)).status).toBe(403);
    expect((await t.get("/api/v1/me", cookie)).body.data.hasAccess).toBe(false);
    expect(t.gateway.calls.length - before).toBe(2); // one gateway read per console request
  });

  it("a grant outside its validity window is ignored, checked again with the console's clock", async () => {
    const t = setup();
    const past = Date.now() - 3_600_000;
    t.gateway.set("merchant.ops", [wireGrant(T.northwind, M.northwindUk, "mops", { from: past - 7_200_000, until: past })]);
    expect((await t.get("/api/v1/me", t.loginAs("merchant.ops"))).body.data.hasAccess).toBe(false);
    t.gateway.set("merchant.dev", [wireGrant(T.northwind, M.northwindUk, "mdev", { from: Date.now() + 3_600_000 })]);
    expect((await t.get("/api/v1/me", t.loginAs("merchant.dev"))).body.data.hasAccess).toBe(false);
  });

  it("the token, headers and user metadata never grant anything", async () => {
    const t = setup();
    t.gateway.set("merchant.viewer", [wireGrant(T.alder, undefined, "mview")]);
    const res = await request(t.app).get("/api/v1/me").set("Cookie", t.loginAs("merchant.viewer"))
      .set("X-Zp-Persona", "SUPER_ADMIN").set("X-Role", "MOWN").set("X-Tenant-Id", T.northwind)
      .set("X-Zp-Subject", "00000000-0000-4000-8000-000000000001").set("Authorization", "Bearer forged");
    expect(res.body.data).toMatchObject({ personas: ["MVIEW"] });
    // The gateway saw only the session's own access token, never the browser's headers.
    const call = t.gateway.calls.at(-1)!;
    expect(call.method).toBe("GET");
    expect(call.headers.authorization).toBe(`Bearer ${accessTokenFor("merchant.viewer")}`);
    expect(Object.keys(call.headers).sort()).toEqual(["accept", "authorization"]);
  });

  it("fails closed with 503 when the gateway cannot be reached or errors", async () => {
    const t = setup();
    t.gateway.set("merchant.owner", [wireGrant(T.northwind, undefined, "mown")]);
    const cookie = t.loginAs("merchant.owner");
    t.gateway.down = true;
    for (const path of ["/api/v1/me", "/api/v1/payments", "/api/v1/overview/kpis"]) {
      const res = await t.get(path, cookie);
      expect(res.status, path).toBe(503);
      expect(res.body.code).toBe("MEMBERSHIP_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain(accessTokenFor("merchant.owner"));
    }
    t.gateway.down = false;
    t.gateway.status = 500;
    expect((await t.get("/api/v1/me", cookie)).body.code).toBe("MEMBERSHIP_UNAVAILABLE");
  });

  it("fails closed with 503 on a malformed or inconsistent answer", async () => {
    const cases: Record<string, (b: Record<string, unknown>) => Record<string, unknown>> = {
      "staff persona": (b) => ({ ...b, grants: [{ ...wireGrant(T.northwind, undefined, "mown"), persona: "super_admin" }] }),
      "upper-case persona": (b) => ({ ...b, grants: [{ ...wireGrant(T.northwind, undefined, "mown"), persona: "MOWN" }] }),
      "wildcard tenant": (b) => ({ ...b, grants: [{ ...wireGrant(T.northwind, undefined, "mown"), tenant_id: "*" }] }),
      "malformed merchant": (b) => ({ ...b, grants: [wireGrant(T.northwind, "mer_northwind_uk", "mops")] }),
      "someone else's subject": (b) => ({ ...b, subject: "00000000-0000-4000-8000-000000000001" }),
      "another issuer": (b) => ({ ...b, issuer: "https://elsewhere.example.test/" }),
      "unknown field": (b) => ({ ...b, roles: ["SUPER_ADMIN"] }),
      "unknown environment": (b) => ({ ...b, environment: "staging" }),
      "not a principal": () => ({ object: "merchant" }),
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const t = setup();
      t.gateway.set("merchant.owner", [wireGrant(T.northwind, undefined, "mown")]);
      t.gateway.mutate = mutate;
      const res = await t.get("/api/v1/payments", t.loginAs("merchant.owner"));
      expect(res.status, name).toBe(503);
      expect(res.body.code, name).toBe("MEMBERSHIP_UNAVAILABLE");
    }
  });

  it("a gateway refusal of the principal (grants in both TEST and LIVE) means no access", async () => {
    const t = setup();
    t.gateway.set("merchant.owner", [wireGrant(T.northwind, undefined, "mown")]);
    t.gateway.status = 403;
    expect((await t.get("/api/v1/me", t.loginAs("merchant.owner"))).body.data.hasAccess).toBe(false);
  });

  it("refreshes an expired access token server-side, and ends the session when the refresh is refused", async () => {
    let clock = Date.now();
    const t = setup({ now: () => clock });
    t.gateway.set("merchant.ops", [wireGrant(T.northwind, M.northwindUk, "mops")]);
    const cookie = t.loginAs("merchant.ops", { tokenExpiresInMs: 60_000 });
    expect((await t.get("/api/v1/me", cookie)).body.data.personas).toEqual(["MOPS"]);
    expect(t.idp.refreshed).toEqual([]);

    clock += 2 * 60_000; // the access token has expired
    expect((await t.get("/api/v1/me", cookie)).body.data.personas).toEqual(["MOPS"]);
    expect(t.idp.refreshed).toEqual(["rt-merchant.ops"]);
    expect(t.gateway.calls.at(-1)!.headers.authorization).toBe(`Bearer ${accessTokenFor("merchant.ops", 1)}`);

    clock += 10 * 60_000;
    t.idp.deadRefreshTokens.add("rt-merchant.ops#1"); // the Keycloak session has ended
    const ended = await t.get("/api/v1/me", cookie);
    expect(ended.status).toBe(401);
    expect(ended.body.code).toBe("SESSION_EXPIRED");
    expect((await t.get("/api/v1/me", cookie)).body.code).toBe("UNAUTHENTICATED"); // the console session is gone too
  });

  it("when the gateway refuses the token, refreshes once and retries, then ends the session", async () => {
    const t = setup();
    t.gateway.set("merchant.ops", [wireGrant(T.northwind, M.northwindUk, "mops")]);
    const cookie = t.loginAs("merchant.ops");
    t.gateway.rejectedTokens.add(accessTokenFor("merchant.ops"));
    expect((await t.get("/api/v1/me", cookie)).body.data.personas).toEqual(["MOPS"]);
    expect(t.idp.refreshed).toHaveLength(1);

    t.gateway.rejectedTokens.add(accessTokenFor("merchant.ops", 1));
    t.gateway.rejectedTokens.add(accessTokenFor("merchant.ops", 2));
    expect((await t.get("/api/v1/me", cookie)).body.code).toBe("SESSION_EXPIRED");
  });
});

describe("no wildcard tenant in the policy, whatever the scope's kind", () => {
  it("a scope covers only the tenants it lists", async () => {
    const { inScope } = await import("../src/authorization/policy.js");
    const { buildPrincipal } = await import("../src/authorization/principal.js");
    const user = { sub: "s", username: "u", displayName: "U", loginAt: 0, authTime: 0, environment: "TEST" as const };
    for (const kind of ["internal", "merchant"] as const) {
      const p = buildPrincipal(user, { sub: "s", username: "u", displayName: "U", personas: ["MVIEW"],
        scope: { kind, legalEntityIds: ["cell_uk_01"], tenantIds: [T.northwind], merchantIds: "*", environments: ["TEST"] } });
      const at = (tenantId: string, merchantId: string) => ({ tenantId, merchantId, legalEntityId: "cell_uk_01", environment: "TEST" as const });
      expect(inScope(p, at(T.northwind, M.northwindUk)), kind).toBe(true);
      expect(inScope(p, at(T.alder, M.alderBooks)), kind).toBe(false);
      expect(inScope(p, at(T.kestrel, M.kestrelUk)), kind).toBe(false);
    }
  });
});

describe("sign-in reads grants from the gateway", () => {
  it("signs in, keeps tokens server-side and records whether a grant was found", async () => {
    const t = setup();
    t.gateway.set("merchant.owner", [wireGrant(T.northwind, undefined, "mown")]);
    const agent = request.agent(t.app);
    const login = await agent.post("/auth/login").set("Origin", ORIGIN).send({ username: "merchant.owner", password: PASSWORD });
    expect(login.status).toBe(200);
    const raw = JSON.stringify({ body: login.body, headers: login.headers });
    expect(raw).not.toContain(accessTokenFor("merchant.owner"));
    expect(raw).not.toContain("rt-merchant.owner");
    const me = await agent.get("/api/v1/me");
    expect(me.body.data.personas).toEqual(["MOWN"]);
    expect(JSON.stringify(me.body)).not.toContain("at-");
    expect(t.services.audit.list().find((e) => e.action === "auth.login")?.detail).toMatchObject({ membership: "found" });
  });

  it("refuses sign-in while grants cannot be read, and creates no session", async () => {
    const t = setup();
    t.gateway.down = true;
    const agent = request.agent(t.app);
    const login = await agent.post("/auth/login").set("Origin", ORIGIN).send({ username: "merchant.owner", password: PASSWORD });
    expect(login.status).toBe(503);
    expect(login.body.code).toBe("MEMBERSHIP_UNAVAILABLE");
    expect(t.idp.loggedOut).toEqual(["rt-merchant.owner"]); // the Keycloak session is ended too
    expect((await agent.get("/api/v1/me")).status).toBe(401);
  });

  it("a staff sign-in succeeds with no access", async () => {
    const t = setup();
    const agent = request.agent(t.app);
    expect((await agent.post("/auth/login").set("Origin", ORIGIN).send({ username: "super.admin", password: PASSWORD })).status).toBe(200);
    expect((await agent.get("/api/v1/me")).body.data).toMatchObject({ hasAccess: false, personas: [] });
    expect(t.services.audit.list().find((e) => e.action === "auth.login")?.detail).toMatchObject({ membership: "none" });
  });
});
