import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN, PASSWORD } from "./helpers.js";

type Row = { id: string; status: string; version: number; isOwnRequest: boolean; merchantId?: string; fields: Record<string, unknown>; actions: { name: string; allowed: boolean }[] };

function setup() {
  const t = makeTestApp();
  const list = (cookie: string, screen: string) => request(t.app).get(`/api/v1/screens/${screen}`).set("Cookie", cookie);
  const create = (cookie: string, screen: string, body: object) =>
    request(t.app).post(`/api/v1/screens/${screen}/records`).set("Cookie", cookie).set("Origin", ORIGIN).send(body);
  const act = (cookie: string, screen: string, id: string, action: string, body: object) =>
    request(t.app).post(`/api/v1/screens/${screen}/records/${id}/actions/${action}`).set("Cookie", cookie).set("Origin", ORIGIN).send(body);
  const signedInWithStepUp = async (username: string) => {
    const agent = request.agent(t.app);
    await agent.post("/auth/login").set("Origin", ORIGIN).send({ username, password: PASSWORD });
    expect((await agent.post("/auth/reauth").set("Origin", ORIGIN).send({ password: PASSWORD })).status).toBe(200);
    return agent;
  };
  return { ...t, list, create, act, signedInWithStepUp };
}

const ALL = ["ZP-STR-010", "ZP-STR-011", "ZP-STR-012", "ZP-STR-013", "ZP-STR-014", "ZP-STR-020", "ZP-STR-021", "ZP-STR-022", "ZP-STR-023", "ZP-STR-024", "ZP-STR-025", "ZP-STR-026", "ZP-STR-027"];

describe("Stripe-parity finance screens (TEST fixtures)", () => {
  it("serves every screen to finance roles with TEST rows, and to no one else", async () => {
    const t = setup();
    for (const id of ALL) {
      const res = await t.list(t.loginAs("fin.controller.a"), id);
      expect(res.status, id).toBe(200);
      expect(res.body.meta.source, id).toBe("fixture");
      expect((res.body.data.items as Row[]).length, id).toBeGreaterThan(0);
    }
    expect((await t.list(t.loginAs("merchant.ops"), "ZP-STR-010")).status).toBe(403); // no Finance area
    expect((await t.create(t.loginAs("merchant.ops"), "ZP-STR-010", { merchantId: "mer_northwind_uk", values: { amount: "10", source: "Bank transfer (TEST)" } })).status).toBe(403);
  });

  it("shows merchant finance only its own merchants", async () => {
    const t = setup();
    const rows = (await t.list(t.loginAs("merchant.finance"), "ZP-STR-010")).body.data.items as Row[];
    const merchants = new Set(rows.map((r) => r.merchantId));
    expect(merchants.size).toBeGreaterThan(0);
    const all = (await t.list(t.loginAs("fin.controller.a"), "ZP-STR-010")).body.data.items as Row[];
    expect(merchants.size).toBeLessThan(new Set(all.map((r) => r.merchantId)).size);
  });

  it("creates a top-up that a second person must approve with a fresh password", async () => {
    const t = setup();
    const made = await t.create(t.loginAs("fin.controller.a"), "ZP-STR-010", { merchantId: "mer_northwind_uk", values: { amount: "1250.50", source: "Bank transfer (TEST)" } });
    expect(made.status).toBe(201);
    const r = made.body.data as Row;
    expect(r.status).toBe("REQUIRES_APPROVAL");
    expect(r.fields.amount).toEqual({ minor: "125050", currency: "GBP" }); // exact minor units, no floats
    expect(r.isOwnRequest).toBe(true);

    const self = await t.act(t.loginAs("fin.controller.a"), "ZP-STR-010", r.id, "approve", { version: r.version });
    expect(self.body.code).toBe("SELF_APPROVAL_PROHIBITED");
    const noPassword = await t.act(t.loginAs("fin.controller.b"), "ZP-STR-010", r.id, "approve", { version: r.version });
    expect(noPassword.body.code).toBe("STEP_UP_REQUIRED");

    const b = await t.signedInWithStepUp("fin.controller.b");
    const done = await b.post(`/api/v1/screens/ZP-STR-010/records/${r.id}/actions/approve`).set("Origin", ORIGIN).send({ version: r.version });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("SUCCEEDED");
    expect(t.services.audit.list({ action: "screen.ZP-STR-010.create", outcome: "SUCCEEDED" })).toHaveLength(1);
    expect(t.services.audit.list({ action: "screen.ZP-STR-010.approve", outcome: "SUCCEEDED" })).toHaveLength(1);
  });

  it("validates create forms on the server", async () => {
    const t = setup();
    const c = t.loginAs("fin.controller.a");
    const bad = async (values: Record<string, string>, merchantId = "mer_northwind_uk") => (await t.create(c, "ZP-STR-010", { merchantId, values })).status;
    expect(await bad({ amount: "12.345", source: "Bank transfer (TEST)" })).toBe(400); // three decimals
    expect(await bad({ amount: "0", source: "Bank transfer (TEST)" })).toBe(400);
    expect(await bad({ amount: "-5", source: "Bank transfer (TEST)" })).toBe(400);
    expect(await bad({ amount: "10", source: "Somewhere else" })).toBe(400); // not a listed option
    expect(await bad({ source: "Bank transfer (TEST)" })).toBe(400); // amount required
    expect(await bad({ amount: "10", source: "Bank transfer (TEST)" }, "mer_unknown")).toBe(400);
    expect((await t.create(c, "ZP-STR-012", { merchantId: "mer_northwind_uk", values: {} })).status).toBe(404); // fees: read-only
    expect(t.services.audit.list({ action: "screen.ZP-STR-010.create", outcome: "DENIED" }).length).toBeGreaterThanOrEqual(6);
  });

  it("refuses creates outside the caller's merchant scope", async () => {
    const t = setup();
    const own = ((await t.list(t.loginAs("merchant.finance"), "ZP-STR-010")).body.data.items as Row[])[0]!.merchantId;
    const foreign = ["mer_northwind_uk", "mer_alder_books", "mer_kestrel_uk"].find((m) => m !== own && !m.startsWith(own?.slice(0, 8) ?? "x"))!;
    const res = await t.create(t.loginAs("merchant.finance"), "ZP-STR-010", { merchantId: foreign, values: { amount: "10", source: "Bank transfer (TEST)" } });
    expect(res.status).toBe(400);
  });

  it("lets only a Finance Controller close a revenue period", async () => {
    const t = setup();
    const open = ((await t.list(t.loginAs("fin.controller.a"), "ZP-STR-022")).body.data.items as Row[]).find((r) => r.status === "OPEN")!;
    expect(open.actions.find((a) => a.name === "close_period")?.allowed).toBe(true);
    const asRecon = ((await t.list(t.loginAs("recon.analyst"), "ZP-STR-022")).body.data.items as Row[]).find((r) => r.id === open.id)!;
    expect(asRecon.actions.find((a) => a.name === "close_period")?.allowed).toBe(false);
  });
});
