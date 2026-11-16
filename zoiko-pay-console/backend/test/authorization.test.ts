import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN } from "./helpers.js";

interface PaymentRow { id: string; merchantId: string; legalEntityId: string; method: unknown; customerEmailMasked: string; environment: string }

async function allPayments(app: Parameters<typeof request>[0], cookie: string): Promise<PaymentRow[]> {
  const res = await request(app).get("/api/v1/payments?pageSize=100").set("Cookie", cookie);
  expect(res.status).toBe(200);
  const total = res.body.data.total as number;
  const rows: PaymentRow[] = [...res.body.data.items];
  for (let page = 2; rows.length < total; page++) {
    const next = await request(app).get(`/api/v1/payments?pageSize=100&page=${page}`).set("Cookie", cookie);
    rows.push(...next.body.data.items);
  }
  return rows;
}

describe("role-based access", () => {
  const { app, services, loginAs } = makeTestApp();

  it("denies Super Admin transaction details and audits the denial (03-05 §10.1)", async () => {
    const res = await request(app).get("/api/v1/payments").set("Cookie", loginAs("super.admin"));
    expect(res.status).toBe(403);
    expect(services.audit.list({ outcome: "DENIED" }).some((e) => e.actorUsername === "super.admin")).toBe(true);
  });

  it("gives Super Admin health but no Overview data (03-05 §10.1: counts live on the Super Admin page)", async () => {
    const cookie = loginAs("super.admin");
    for (const path of ["/api/v1/overview/kpis?period=30d&currency=GBP", "/api/v1/overview/activity?period=7d", "/api/v1/overview/recent-activity"]) {
      expect((await request(app).get(path).set("Cookie", cookie)).status, path).toBe(403);
    }
    expect((await request(app).get("/api/v1/system/health").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get("/api/v1/platform/summary").set("Cookie", cookie)).status).toBe(200);
  });

  it("gives support no data by default (02-02: no default cross-tenant search)", async () => {
    const cookie = loginAs("support.agent");
    expect((await request(app).get("/api/v1/payments").set("Cookie", cookie)).status).toBe(403);
    const k = await request(app).get("/api/v1/overview/kpis").set("Cookie", cookie);
    expect(k.body.data.kpis.every((x: { restricted: boolean }) => x.restricted)).toBe(true);
  });

  it("lets SRE see health but no content", async () => {
    const cookie = loginAs("sre.oncall");
    expect((await request(app).get("/api/v1/system/health").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get("/api/v1/payments").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).get("/api/v1/overview/activity").set("Cookie", cookie)).status).toBe(403);
  });

  it("decides side-rail areas per persona from the screen specs (BR §07)", async () => {
    const areas = async (u: string) =>
      ((await request(app).get("/api/v1/me").set("Cookie", loginAs(u))).body.data.permissions as string[]).filter((p) => p.startsWith("area."));
    expect(await areas("super.admin")).toEqual(["area.platform"]); // 03-05 §10.1 coordination page only
    expect(await areas("ops.agent")).toEqual([
      "area.finance", "area.merchants", "area.partners", "area.payment_operations", "area.refunds_disputes", "area.routing",
    ]);
    expect(await areas("fin.controller.a")).toEqual(["area.finance", "area.payouts", "area.qa_release"]);
    expect(await areas("merchant.ops")).toEqual(["area.developers", "area.payment_operations", "area.refunds_disputes"]);
    expect(await areas("security.officer")).toEqual(["area.access", "area.audits", "area.exceptional", "area.partners", "area.risk_compliance"]);
    expect(await areas("support.agent")).toEqual(["area.exceptional"]); // WF-007
    expect(await areas("sre.oncall")).toEqual(["area.exceptional"]); // WF-011
    expect(await areas("iam.admin")).toEqual(["area.access"]);
    expect(await areas("merchant.owner")).toEqual(["area.access", "area.developers", "area.merchants"]);
  });

  it("returns permissions in /me for UI visibility only", async () => {
    const res = await request(app).get("/api/v1/me").set("Cookie", loginAs("merchant.viewer"));
    expect(res.body.data.personas).toEqual(["MVIEW"]);
    expect(res.body.data.permissions).toContain("payments.read");
    expect(res.body.data.permissions).not.toContain("payments.method.view");
    expect(res.body.data.permissions).not.toContain("health.view");
  });

  it("masks PII always and payment method unless permitted", async () => {
    const viewer = await allPayments(app, loginAs("merchant.viewer"));
    expect(viewer.every((p) => p.method === null)).toBe(true);
    expect(viewer.every((p) => /^c•••@example\.test$/.test(p.customerEmailMasked))).toBe(true);
    const ops = await request(app).get("/api/v1/payments?pageSize=5").set("Cookie", loginAs("ops.agent"));
    expect(ops.body.data.items[0].method).toMatchObject({ type: "card" });
    expect(JSON.stringify(ops.body)).not.toMatch(/customer\d+@/);
  });

  it("labels fixture data in every data response", async () => {
    const res = await request(app).get("/api/v1/payments?pageSize=1").set("Cookie", loginAs("ops.agent"));
    expect(res.body.meta).toMatchObject({ source: "fixture", environment: "TEST" });
  });
});

describe("tenant and legal-entity isolation", () => {
  const { app, services, loginAs } = makeTestApp();

  it("limits a merchant operator to their own merchant", async () => {
    const rows = await allPayments(app, loginAs("merchant.ops"));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.merchantId))).toEqual(new Set(["mer_northwind_uk"]));
  });

  it("limits a merchant owner to their own tenant", async () => {
    const rows = await allPayments(app, loginAs("merchant.owner"));
    expect(new Set(rows.map((r) => r.merchantId))).toEqual(new Set(["mer_northwind_uk", "mer_northwind_eu"]));
  });

  it("limits an internal agent to their legal entity", async () => {
    const rows = await allPayments(app, loginAs("ops.agent"));
    expect(new Set(rows.map((r) => r.legalEntityId))).toEqual(new Set(["cell_uk_01"]));
  });

  it("answers 404, not 403, for another tenant's record so IDs cannot be probed", async () => {
    const foreign = services.data.payments("TEST").find((p) => p.tenantId === "ten_alder")!;
    const res = await request(app).get(`/api/v1/payments/${foreign.id}`).set("Cookie", loginAs("merchant.ops"));
    expect(res.status).toBe(404);
    expect(services.audit.list({ action: "payments.read", outcome: "DENIED" }).at(-1)?.resource?.id).toBe(foreign.id);
  });

  it("ignores filters that point outside the caller's scope", async () => {
    const cookie = loginAs("merchant.ops");
    const res = await request(app).get("/api/v1/payments?merchantId=mer_alder_books").set("Cookie", cookie);
    expect(res.body.data.total).toBe(0);
    const k = await request(app).get("/api/v1/overview/kpis?merchantId=mer_alder_books").set("Cookie", cookie);
    expect(k.status).toBe(404);
  });

  it("keeps recent activity inside the caller's scope", async () => {
    const res = await request(app).get("/api/v1/overview/recent-activity").set("Cookie", loginAs("merchant.ops"));
    expect(res.status).toBe(200);
    expect(res.body.data.every((a: { merchantId: string }) => a.merchantId === "mer_northwind_uk")).toBe(true);
  });
});

describe("environment isolation (TEST / LIVE)", () => {
  const { app, services, loginAs } = makeTestApp();

  it("refuses LIVE for a user without LIVE membership, and audits it", async () => {
    const res = await request(app).put("/api/v1/session/environment").set("Cookie", loginAs("ops.agent")).set("Origin", ORIGIN).send({ environment: "LIVE" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ENVIRONMENT_NOT_PERMITTED");
    expect(services.audit.list({ action: "session.environment", outcome: "DENIED" })).toHaveLength(1);
  });

  it("never serves TEST fixtures when LIVE is selected", async () => {
    const cookie = loginAs("fin.controller.a");
    const sw = await request(app).put("/api/v1/session/environment").set("Cookie", cookie).set("Origin", ORIGIN).send({ environment: "LIVE" });
    expect(sw.status).toBe(200);
    const kpis = await request(app).get("/api/v1/overview/kpis").set("Cookie", cookie);
    expect(kpis.status).toBe(503);
    expect(kpis.body.code).toBe("LIVE_DATA_UNAVAILABLE");
    // A payment reader on LIVE (forced session; the data source refuses before any scope check).
    const reader = loginAs("ops.agent", { environment: "LIVE" });
    for (const path of ["/api/v1/payments", "/api/v1/overview/recent-activity"]) {
      const res = await request(app).get(path).set("Cookie", reader);
      expect(res.status, path).toBe(503);
      expect(res.body.code).toBe("LIVE_DATA_UNAVAILABLE");
    }
    const me = await request(app).get("/api/v1/me").set("Cookie", cookie);
    expect(me.body.data.environment).toBe("LIVE");
  });

  it("does not let a TEST record be read from a LIVE session", async () => {
    const id = services.data.payments("TEST")[0]!.id;
    const res = await request(app).get(`/api/v1/payments/${id}`).set("Cookie", loginAs("ops.agent", { environment: "LIVE" }));
    expect(res.status).toBe(503);
  });
});
