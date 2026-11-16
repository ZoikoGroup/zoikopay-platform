import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN } from "./helpers.js";

/** 03-05 §10.1: Super Admin is a coordination role. Health, counts and redacted tenant metadata only. */
describe("Super Admin platform page", () => {
  it("is served only to Super Admin", async () => {
    const t = makeTestApp();
    const get = (u: string) => request(t.app).get("/api/v1/platform/summary").set("Cookie", t.loginAs(u));
    expect((await get("super.admin")).status).toBe(200);
    for (const u of ["ops.agent", "fin.controller.a", "iam.admin", "security.officer", "sre.oncall", "merchant.owner"]) {
      expect((await get(u)).status, u).toBe(403);
    }
    expect(t.services.audit.list({ action: "GET /api/v1/platform/summary", outcome: "DENIED" }).length).toBe(6);
  });

  it("returns counts and identifiers, never amounts, people, customers or payment records", async () => {
    const t = makeTestApp();
    const res = await request(t.app).get("/api/v1/platform/summary").set("Cookie", t.loginAs("super.admin"));
    const d = res.body.data;
    expect(d.totals.merchants).toBeGreaterThan(0);
    expect(d.organisations.map((o: { id: string }) => o.id)).toEqual(["ten_alder", "ten_kestrel", "ten_northwind"]);
    expect(d.roles.find((r: { persona: string }) => r.persona === "PFIN").count).toBe(2);

    const body = JSON.stringify(d);
    for (const forbidden of ["amountMinor", "amount_minor", "customerEmail", "@", "last4", "pi_", "username", "displayName", "Rowan Hale", "secret"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it("counts security signals without exposing audit bodies", async () => {
    const t = makeTestApp();
    await request(t.app).get("/api/v1/payments").set("Cookie", t.loginAs("super.admin")); // refused
    const d = (await request(t.app).get("/api/v1/platform/summary").set("Cookie", t.loginAs("super.admin"))).body.data;
    expect(d.signals.items.find((x: { key: string }) => x.key === "denied").count).toBeGreaterThanOrEqual(1);
    expect(d.signals.auditChain.valid).toBe(true);
    expect(JSON.stringify(d.signals)).not.toContain("actorUsername");
  });

  it("does not widen Super Admin's data access anywhere else", async () => {
    const t = makeTestApp();
    const c = t.loginAs("super.admin");
    for (const path of ["/api/v1/payments", "/api/v1/screens/ZP-BRW-010", "/api/v1/screens/ZP-BRW-009", "/api/v1/audit"]) {
      expect((await request(t.app).get(path).set("Cookie", c)).status, path).toBe(403);
    }
  });

  it("has no Overview: the Super Admin page is the default dashboard (03-05 §10.1)", async () => {
    const t = makeTestApp();
    const c = t.loginAs("super.admin");
    const me = (await request(t.app).get("/api/v1/me").set("Cookie", c)).body.data;
    expect([...me.permissions].sort()).toEqual(["area.platform", "health.view"]);
    // Per-merchant drill-down (fraud rate, settlement, pending payouts) is merchant operating data.
    for (const path of [
      "/api/v1/overview/kpis?period=7d&currency=GBP",
      "/api/v1/overview/kpis?period=7d&currency=GBP&merchantId=mer_northwind_uk",
      "/api/v1/overview/activity?period=7d&currency=GBP",
      "/api/v1/overview/recent-activity",
      "/api/v1/scope",
      "/api/v1/search?q=pi_",
    ]) {
      expect((await request(t.app).get(path).set("Cookie", c)).status, path).toBe(403);
    }
    expect((await request(t.app).get("/api/v1/system/health").set("Cookie", c)).status).toBe(200);
  });

  it("refuses LIVE instead of showing TEST counts under a LIVE badge", async () => {
    const t = makeTestApp();
    const c = t.loginAs("super.admin");
    expect((await request(t.app).put("/api/v1/session/environment").set("Cookie", c).set("Origin", ORIGIN).send({ environment: "LIVE" })).status).toBe(200);
    const res = await request(t.app).get("/api/v1/platform/summary").set("Cookie", c);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("LIVE_DATA_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain("totals");
  });
});
