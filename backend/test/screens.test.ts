import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN, PASSWORD } from "./helpers.js";

type Row = { id: string; status: string; version: number; isOwnRequest: boolean; merchantId?: string; actions: { name: string; allowed: boolean; blockedReason?: string }[] };

function setup() {
  const t = makeTestApp();
  const list = async (cookie: string, screen: string, q = "") => request(t.app).get(`/api/v1/screens/${screen}${q}`).set("Cookie", cookie);
  const act = (cookie: string, screen: string, id: string, action: string, body: object) =>
    request(t.app).post(`/api/v1/screens/${screen}/records/${id}/actions/${action}`).set("Cookie", cookie).set("Origin", ORIGIN).send(body);
  /** Signs in through the real form and confirms the password (step-up). */
  const signedInWithStepUp = async (username: string) => {
    const agent = request.agent(t.app);
    await agent.post("/auth/login").set("Origin", ORIGIN).send({ username, password: PASSWORD });
    const r = await agent.post("/auth/reauth").set("Origin", ORIGIN).send({ password: PASSWORD });
    expect(r.status).toBe(200);
    return agent;
  };
  return { ...t, list, act, signedInWithStepUp };
}

describe("console screens (Business Requirements §07)", () => {
  it("serves each area only to roles the specs list", async () => {
    const t = setup();
    expect((await t.list(t.loginAs("ops.agent"), "ZP-BRW-006")).status).toBe(200); // Routing: PAY-OPS
    expect((await t.list(t.loginAs("ops.agent"), "ZP-BRW-010")).status).toBe(403); // Payouts: not PAY-OPS
    expect((await t.list(t.loginAs("super.admin"), "ZP-BRW-002")).status).toBe(403);
    expect((await t.list(t.loginAs("fin.controller.a"), "ZP-BRW-010")).status).toBe(200);
  });

  it("keeps merchant-owned records inside the caller's scope", async () => {
    const t = setup();
    const res = await t.list(t.loginAs("merchant.ops"), "ZP-BRW-008");
    expect(res.status).toBe(200);
    expect(new Set(res.body.data.items.map((r: Row) => r.merchantId))).toEqual(new Set(["mer_northwind_uk"]));
    const foreign = t.services.screens.rawRows("ZP-BRW-008").find((r) => r.merchantId === "mer_alder_books")!;
    expect((await request(t.app).get(`/api/v1/screens/ZP-BRW-008/records/${foreign.id}`).set("Cookie", t.loginAs("merchant.ops"))).status).toBe(404);
  });

  it("never sends who raised a record, only whether it was you", async () => {
    const t = setup();
    const res = await t.list(t.loginAs("fin.controller.a"), "ZP-BRW-010");
    expect(JSON.stringify(res.body)).not.toContain("requestedBySub");
    expect(res.body.data.items.some((r: Row) => r.isOwnRequest)).toBe(true);
  });

  it("enforces requester-cannot-approve, step-up and version for payouts", async () => {
    const t = setup();
    const rows = (await t.list(t.loginAs("fin.controller.a"), "ZP-BRW-010", "?status=REQUIRES_APPROVAL")).body.data.items as Row[];
    const own = rows.find((r) => r.isOwnRequest)!;
    const ownAttempt = await t.act(t.loginAs("fin.controller.a"), "ZP-BRW-010", own.id, "approve", { version: own.version });
    expect(ownAttempt.status).toBe(403);
    expect(ownAttempt.body.code).toBe("SELF_APPROVAL_PROHIBITED");

    const target = rows.find((r) => r.isOwnRequest && r.actions.length)!;
    const noStepUp = await t.act(t.loginAs("fin.controller.b"), "ZP-BRW-010", target.id, "approve", { version: target.version });
    expect([401, 409]).toContain(noStepUp.status); // 401 STEP_UP_REQUIRED, or 409 if a guard (hold/deadline) applies first

    const b = await t.signedInWithStepUp("fin.controller.b");
    const view = (await b.get("/api/v1/screens/ZP-BRW-010?status=REQUIRES_APPROVAL")).body.data.items as Row[];
    const ok = view.find((r) => r.actions.find((a) => a.name === "approve")?.allowed)!;
    expect(ok).toBeDefined();
    const stale = await b.post(`/api/v1/screens/ZP-BRW-010/records/${ok.id}/actions/approve`).set("Origin", ORIGIN).send({ version: ok.version + 5 });
    expect(stale.body.code).toBe("STALE_VERSION");
    const done = await b.post(`/api/v1/screens/ZP-BRW-010/records/${ok.id}/actions/approve`).set("Origin", ORIGIN).send({ version: ok.version });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("READY");
    expect(done.body.data.fields.approvalStatus).toBe("APPROVED");
    expect(done.body.data.fields.gates.maker_checker).toBe("PASSED");
    expect(t.services.audit.list({ action: "screen.ZP-BRW-010.approve", outcome: "SUCCEEDED" })).toHaveLength(1);
  });

  it("requires a reason for refusals", async () => {
    const t = setup();
    const rows = (await t.list(t.loginAs("compliance.officer"), "ZP-BRW-002")).body.data.items as Row[];
    const r = rows.find((x) => x.actions.find((a) => a.name === "reject")?.allowed)!;
    const noReason = await t.act(t.loginAs("compliance.officer"), "ZP-BRW-002", r.id, "reject", { version: r.version });
    expect(noReason.status).toBe(400);
    const ok = await t.act(t.loginAs("compliance.officer"), "ZP-BRW-002", r.id, "reject", { version: r.version, reason: "Beneficial owner evidence inconsistent" });
    expect(ok.body.data.status).toBe("REJECTED");
    expect(ok.body.data.timeline.at(-1).note).toBe("Beneficial owner evidence inconsistent");
  });

  it("applies spec guards, e.g. no GO while a gate is not passed", async () => {
    const t = setup();
    const a = await t.signedInWithStepUp("fin.controller.b");
    const rows = (await a.get("/api/v1/screens/ZP-BRW-014")).body.data.items as Row[];
    const blocked = rows.find((r) => r.status === "PENDING_DECISION" && !r.actions.find((x) => x.name === "go")?.allowed)!;
    const res = await a.post(`/api/v1/screens/ZP-BRW-014/records/${blocked.id}/actions/go`).set("Origin", ORIGIN).send({ version: blocked.version });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/Every gate G0–G7 must pass/);
  });

  it("refuses LIVE", async () => {
    const t = setup();
    const res = await t.list(t.loginAs("fin.controller.a", { environment: "LIVE" }), "ZP-BRW-010");
    expect(res.body.code).toBe("LIVE_DATA_UNAVAILABLE");
  });

  it("rejects a wrong password at step-up", async () => {
    const t = setup();
    const agent = request.agent(t.app);
    await agent.post("/auth/login").set("Origin", ORIGIN).send({ username: "ops.agent", password: PASSWORD });
    const r = await agent.post("/auth/reauth").set("Origin", ORIGIN).send({ password: "wrong" });
    expect(r.status).toBe(401);
    expect((await agent.get("/api/v1/me")).body.data.stepUpValidUntil).toBeNull();
  });
});

describe("sandbox payment intent (ZP-BRW-004, 04-08 idempotency)", () => {
  const body = { merchantId: "mer_northwind_uk", amount_minor: "1999", currency: "GBP", capture_mode: "automatic", order_ref: "ORD-1" };
  const post = (t: ReturnType<typeof setup>, cookie: string, b: object, key?: string) => {
    const r = request(t.app).post("/api/v1/sandbox/payment-intents").set("Cookie", cookie).set("Origin", ORIGIN);
    return (key ? r.set("Idempotency-Key", key) : r).send(b);
  };

  it("requires an Idempotency-Key and validates amount and currency", async () => {
    const t = setup();
    const c = t.loginAs("merchant.ops");
    expect((await post(t, c, body)).status).toBe(400);
    expect((await post(t, c, { ...body, amount_minor: "19.99" }, "key-00000001")).status).toBe(400);
    expect((await post(t, c, { ...body, amount_minor: 1999 }, "key-00000001")).status).toBe(400); // JSON number refused (ADR 0001 §3)
    expect((await post(t, c, { ...body, currency: "EUR" }, "key-00000001")).status).toBe(400);
  });

  it("replays the same key and refuses the same key with a different body", async () => {
    const t = setup();
    const c = t.loginAs("merchant.ops");
    const first = await post(t, c, body, "key-00000002");
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ status: "REQUIRES_PAYMENT_METHOD", simulated: true, idempotent_replay: false });
    const again = await post(t, c, body, "key-00000002");
    expect(again.body.data).toMatchObject({ id: first.body.data.id, idempotent_replay: true });
    const conflict = await post(t, c, { ...body, amount_minor: "2999" }, "key-00000002");
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("is only for merchants in scope", async () => {
    const t = setup();
    const res = await post(t, t.loginAs("merchant.ops"), { ...body, merchantId: "mer_alder_books" }, "key-00000003");
    expect(res.status).toBe(404);
  });
});

describe("global shell (search, notifications, audit)", () => {
  it("search returns only records the caller may open", async () => {
    const t = setup();
    const res = await request(t.app).get("/api/v1/search?q=alder").set("Cookie", t.loginAs("merchant.ops"));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data)).not.toMatch(/alder/i);
  });

  it("notifications list items awaiting the caller's decision", async () => {
    const t = setup();
    const res = await request(t.app).get("/api/v1/notifications").set("Cookie", t.loginAs("fin.controller.b"));
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((n: { screenId: string }) => n.screenId.startsWith("ZP-BRW-"))).toBe(true);
  });

  it("audit log is for audit roles only", async () => {
    const t = setup();
    expect((await request(t.app).get("/api/v1/audit").set("Cookie", t.loginAs("ops.agent"))).status).toBe(403);
    const res = await request(t.app).get("/api/v1/audit").set("Cookie", t.loginAs("security.officer"));
    expect(res.status).toBe(200);
    expect(res.body.data.verification.valid).toBe(true);
  });
});
