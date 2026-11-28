import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN } from "./helpers.js";

type Row = { id: string; status: string; version: number; merchantId?: string; fields: Record<string, unknown>; actions: { name: string; allowed: boolean; quiet?: boolean }[] };

function setup() {
  const t = makeTestApp();
  const list = (cookie: string, screen: string) => request(t.app).get(`/api/v1/screens/${screen}`).set("Cookie", cookie);
  const create = (cookie: string, screen: string, body: object) =>
    request(t.app).post(`/api/v1/screens/${screen}/records`).set("Cookie", cookie).set("Origin", ORIGIN).send(body);
  const act = (cookie: string, screen: string, id: string, action: string, body: object) =>
    request(t.app).post(`/api/v1/screens/${screen}/records/${id}/actions/${action}`).set("Cookie", cookie).set("Origin", ORIGIN).send(body);
  return { ...t, list, create, act };
}
const M = "mer_northwind_uk";

describe("Customers & Billing on the server (TEST fixtures)", () => {
  it("adds a customer and stores the email masked", async () => {
    const t = setup();
    const ops = t.loginAs("merchant.ops");
    const res = await t.create(ops, "ZP-COM-001", { merchantId: M, values: { name: "Ada Lovelace", email: "ada@example.com", country: "United Kingdom" } });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("ACTIVE");
    expect(res.body.data.fields.email).toBe("a••••@example.com");
    expect(JSON.stringify(res.body.data)).not.toContain("ada@example.com");
    expect((await t.create(ops, "ZP-COM-001", { merchantId: M, values: { name: "X", email: "not-an-email" } })).status).toBe(400);
  });

  it("lets only Customers & Billing roles create", async () => {
    const t = setup();
    expect((await t.create(t.loginAs("merchant.dev"), "ZP-COM-002", { merchantId: M, values: { name: "P", price: "10", billing: "One-off" } })).status).toBe(403);
    expect((await t.create(t.loginAs("merchant.viewer"), "ZP-COM-002", { merchantId: M, values: { name: "P", price: "10", billing: "One-off" } })).status).toBe(403);
  });

  it("creates and archives a product; routine actions never become notifications", async () => {
    const t = setup();
    const ops = t.loginAs("merchant.ops");
    const made = (await t.create(ops, "ZP-COM-002", { merchantId: M, values: { name: "Rain Shell", price: "89.99", billing: "One-off" } })).body.data as Row;
    expect(made.fields.price).toEqual({ minor: "8999", currency: "GBP" });
    expect(made.actions.find((a) => a.name === "archive")).toMatchObject({ allowed: true, quiet: true });
    const archived = await t.act(ops, "ZP-COM-002", made.id, "archive", { version: made.version });
    expect(archived.body.data.status).toBe("ARCHIVED");
    const notes = (await request(t.app).get("/api/v1/notifications").set("Cookie", ops)).body.data as { screenId: string }[];
    expect(notes.some((n) => n.screenId.startsWith("ZP-COM-"))).toBe(false);
  });

  it("runs an invoice from draft to paid, with a reason for marking it paid", async () => {
    const t = setup();
    const fin = t.loginAs("merchant.finance");
    const own = ((await t.list(fin, "ZP-COM-005")).body.data.items as Row[])[0]?.merchantId ?? M; // a merchant in this user's scope
    const draft = (await t.create(fin, "ZP-COM-005", { merchantId: own, values: { customer: "Mia Novak", email: "mia@example.com", amountDue: "120.00", dueDate: "2026-12-15" } })).body.data as Row;
    expect(draft.status).toBe("DRAFT");
    const open = (await t.act(fin, "ZP-COM-005", draft.id, "finalize", { version: draft.version })).body.data as Row;
    expect(open.status).toBe("OPEN");
    expect((await t.act(fin, "ZP-COM-005", open.id, "mark_paid", { version: open.version })).status).toBe(400); // reason required
    const paid = (await t.act(fin, "ZP-COM-005", open.id, "mark_paid", { version: open.version, reason: "Paid by bank transfer, ref 4471" })).body.data as Row;
    expect(paid.status).toBe("PAID");
    expect((paid.fields.amountPaid as { minor: string }).minor).toBe("12000");
  });

  it("cancels a subscription only with a reason, and starts trials when asked", async () => {
    const t = setup();
    const ops = t.loginAs("merchant.ops");
    const sub = (await t.create(ops, "ZP-COM-004", { merchantId: M, values: { customer: "Liam Clarke", product: "Outfitters Club", amount: "15", interval: "Monthly", trialDays: "14" } })).body.data as Row;
    expect(sub.status).toBe("TRIALING");
    expect((await t.act(ops, "ZP-COM-004", sub.id, "cancel", { version: sub.version })).status).toBe(400);
    const done = await t.act(ops, "ZP-COM-004", sub.id, "cancel", { version: sub.version, reason: "Customer asked to stop" });
    expect(done.body.data.status).toBe("CANCELED");
    expect(done.body.data.fields.currentPeriodEnd).toBe("—");
  });
});

describe("billing tools on the server (TEST fixtures)", () => {
  const TOOLS = ["ZP-STR-001", "ZP-STR-002", "ZP-STR-003", "ZP-STR-004", "ZP-STR-005", "ZP-STR-006", "ZP-STR-007", "ZP-STR-008", "ZP-STR-009"];
  it("serves every billing tool to Customers & Billing roles only", async () => {
    const t = setup();
    for (const id of TOOLS) {
      const res = await t.list(t.loginAs("merchant.ops"), id);
      expect(res.status, id).toBe(200);
      expect((res.body.data.items as Row[]).length, id).toBeGreaterThan(0);
      expect(res.body.data.create?.allowed, id).toBe(true);
    }
    expect((await t.list(t.loginAs("merchant.viewer"), "ZP-STR-001")).status).toBe(403);
    expect((await t.list(t.loginAs("fin.controller.a"), "ZP-STR-001")).status).toBe(403); // finance has no Customers & Billing area
  });

  it("creates a coupon and expires it", async () => {
    const t = setup();
    const ops = t.loginAs("merchant.ops");
    const c = (await t.create(ops, "ZP-STR-001", { merchantId: M, values: { name: "winter10", discountType: "Percentage discount", value: "10", duration: "Once" } })).body.data as Row;
    expect(c.fields).toMatchObject({ name: "WINTER10", value: "10%" });
    expect((await t.act(ops, "ZP-STR-001", c.id, "expire", { version: c.version })).body.data.status).toBe("EXPIRED");
  });

  it("moves a test clock forward one month", async () => {
    const t = setup();
    const ops = t.loginAs("merchant.ops");
    const clock = (await t.create(ops, "ZP-STR-005", { merchantId: M, values: { name: "Renewal", frozenTime: "2026-01-15" } })).body.data as Row;
    const moved = (await t.act(ops, "ZP-STR-005", clock.id, "advance", { version: clock.version })).body.data as Row;
    expect(moved.fields.frozenTime).toBe("2026-02-14");
    expect(moved.status).toBe("READY");
  });
});

describe("developer workbench on the server (TEST fixtures)", () => {
  it("serves events, logs and keys to developer roles only, with secrets always masked", async () => {
    const t = setup();
    const dev = t.loginAs("merchant.dev");
    for (const id of ["ZP-STR-032", "ZP-STR-033", "ZP-STR-034"]) {
      const res = await t.list(dev, id);
      expect(res.status, id).toBe(200);
      expect((res.body.data.items as Row[]).length, id).toBeGreaterThan(0);
    }
    const keys = (await t.list(dev, "ZP-STR-034")).body.data.items as Row[];
    for (const k of keys.filter((x) => String(x.fields.token).startsWith("sk_") || String(x.fields.token).startsWith("rk_"))) {
      expect(String(k.fields.token)).toContain("••••"); // a secret is never returned in full
    }
    expect((await t.list(t.loginAs("fin.controller.a"), "ZP-STR-034")).status).toBe(403);
  });

  it("creates a restricted key and revokes it with a reason", async () => {
    const t = setup();
    const dev = t.loginAs("merchant.dev");
    const own = ((await t.list(dev, "ZP-STR-034")).body.data.items as Row[])[0]!.merchantId!;
    const key = (await t.create(dev, "ZP-STR-034", { merchantId: own, values: { name: "Reporting", permissions: "Charges: read" } })).body.data as Row;
    expect(String(key.fields.token)).toMatch(/^rk_test_••••/);
    expect((await t.act(dev, "ZP-STR-034", key.id, "revoke", { version: key.version })).status).toBe(400);
    expect((await t.act(dev, "ZP-STR-034", key.id, "revoke", { version: key.version, reason: "No longer used by reporting" })).body.data.status).toBe("REVOKED");
  });

  it("adds an HTTPS webhook endpoint only, and sends it a test event", async () => {
    const t = setup();
    const dev = t.loginAs("merchant.dev");
    const own = ((await t.list(dev, "ZP-BRW-013")).body.data.items as Row[])[0]!.merchantId!;
    const http = await t.create(dev, "ZP-BRW-013", { merchantId: own, values: { url: "http://insecure.example/hook", name: "Orders", events: "refund.succeeded" } });
    expect(http.status).toBe(409);
    const ok = (await t.create(dev, "ZP-BRW-013", { merchantId: own, values: { url: "https://hooks.example.com/zoiko", name: "Orders", events: "refund.succeeded" } })).body.data as Row;
    expect(ok.fields.kind).toBe("Webhook endpoint");
    const sent = await t.act(dev, "ZP-BRW-013", ok.id, "send_test", { version: ok.version });
    expect(sent.status).toBe(200);
    expect(sent.body.data.status).toBe("ACTIVE");
  });
});

describe("payment products and other products on the server (TEST fixtures)", () => {
  const IDS = ["ZP-STR-015", "ZP-STR-016", "ZP-STR-017", "ZP-STR-018", "ZP-STR-019", "ZP-STR-028", "ZP-STR-029", "ZP-STR-030", "ZP-STR-031"];
  it("serves every product page to Customers & Billing roles", async () => {
    const t = setup();
    for (const id of IDS) {
      const res = await t.list(t.loginAs("merchant.ops"), id);
      expect(res.status, id).toBe(200);
      expect((res.body.data.items as Row[]).length, id).toBeGreaterThan(0);
    }
    expect((await t.list(t.loginAs("merchant.viewer"), "ZP-STR-015")).status).toBe(403);
  });

  it("completes a checkout session without creating a payment", async () => {
    const t = setup();
    const ops = t.loginAs("merchant.ops");
    const before = (await request(t.app).get("/api/v1/payments?pageSize=1").set("Cookie", ops)).body.data.total as number;
    expect((await t.create(ops, "ZP-STR-015", { merchantId: M, values: { mode: "Payment", amount: "29", successUrl: "http://plain.example" } })).status).toBe(409);
    const s = (await t.create(ops, "ZP-STR-015", { merchantId: M, values: { mode: "Payment", amount: "29", successUrl: "https://shop.example/thanks" } })).body.data as Row;
    expect(s.status).toBe("OPEN");
    const done = (await t.act(ops, "ZP-STR-015", s.id, "simulate_payment", { version: s.version })).body.data as Row;
    expect(done.status).toBe("COMPLETE");
    expect(String(done.fields.notice)).toContain("no payment is created");
    const after = (await request(t.app).get("/api/v1/payments?pageSize=1").set("Cookie", ops)).body.data.total as number;
    expect(after).toBe(before); // the console never creates payments
  });

  it("verifies an identity session and files a company", async () => {
    const t = setup();
    const ops = t.loginAs("merchant.ops");
    const vs = (await t.create(ops, "ZP-STR-028", { merchantId: M, values: { type: "ID number", reference: "user_77" } })).body.data as Row;
    expect((await t.act(ops, "ZP-STR-028", vs.id, "verify", { version: vs.version })).body.data.status).toBe("VERIFIED");
    const co = (await t.create(ops, "ZP-STR-031", { merchantId: M, values: { company: "Acme Labs Ltd", jurisdiction: "Ireland" } })).body.data as Row;
    const filed = (await t.act(ops, "ZP-STR-031", co.id, "file", { version: co.version })).body.data as Row;
    expect(filed.status).toBe("FILED");
    expect((await t.act(ops, "ZP-STR-031", co.id, "incorporate", { version: filed.version })).body.data.status).toBe("INCORPORATED");
  });

  it("creates a tax rate for the chosen merchant's legal cell, with a valid rate only", async () => {
    const t = setup();
    const op = t.loginAs("ops.agent");
    expect((await t.create(op, "ZP-COM-006", { merchantId: M, values: { name: "VAT", jurisdiction: "Germany", rate: "abc", inclusive: "Inclusive" } })).status).toBe(409);
    const r = await t.create(op, "ZP-COM-006", { merchantId: M, values: { name: "VAT (reduced)", jurisdiction: "United Kingdom", rate: "7.25", inclusive: "Inclusive" } });
    expect(r.status).toBe(201);
    expect(r.body.data.fields).toMatchObject({ rate: "7.25%", legalEntity: "cell_uk_01" });
    expect(r.body.data.merchantId).toBeUndefined(); // a platform-level record, not a merchant's
    expect((await t.create(t.loginAs("merchant.ops"), "ZP-COM-006", { merchantId: M, values: { name: "VAT", jurisdiction: "Germany", rate: "19", inclusive: "Inclusive" } })).status).toBe(403);
  });
});
