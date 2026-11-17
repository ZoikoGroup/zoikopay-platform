import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN, PASSWORD } from "./helpers.js";

/** ADR 0004 acceptance tests: exceptional access (03-05 §10.2; 02-02 WF-007, WF-011). */

type Xa = { id: string; status: string; version: number; actions: { name: string; allowed: boolean }[]; expiresAt: string | null; reviewDue: boolean };
type Agent = ReturnType<typeof request.agent>;

const NORTHWIND_UK = "mer_northwind_uk";
const support = { kind: "support", ticketId: "SUP-1042", purpose: "Customer says the refund never arrived", merchantIds: [NORTHWIND_UK], unmasked: [], durationMinutes: 60 };

function setup(start = Date.parse("2026-11-13T10:00:00Z")) {
  const clock = { now: start };
  const t = makeTestApp({ now: () => clock.now });
  const agent = async (username: string, stepUp = true) => {
    const a = request.agent(t.app);
    expect((await a.post("/auth/login").set("Origin", ORIGIN).send({ username, password: PASSWORD })).status).toBe(200);
    if (stepUp) expect((await a.post("/auth/reauth").set("Origin", ORIGIN).send({ password: PASSWORD })).status).toBe(200);
    return a;
  };
  const ask = (a: Agent, body: object = support) => a.post("/api/v1/exceptional-access").set("Origin", ORIGIN).send(body);
  const act = (a: Agent, g: Xa, action: string, body: object = {}) =>
    a.post(`/api/v1/exceptional-access/${g.id}/actions/${action}`).set("Origin", ORIGIN).send({ version: g.version, ...body });
  const payments = (a: Agent, g: Xa) => a.get(`/api/v1/exceptional-access/${g.id}/payments`);
  /** Support requests, Security approves: returns the active grant. */
  const active = async (body: object = support) => {
    const sup = await agent("support.agent");
    const g = (await ask(sup, body)).body.data as Xa;
    const sec = await agent("security.officer");
    const ok = (await act(sec, g, "approve")).body.data as Xa;
    expect(ok.status).toBe("ACTIVE");
    return { sup, sec, g: ok };
  };
  return { ...t, clock, agent, ask, act, payments, active };
}

describe("ADR 0004 exceptional access", () => {
  it("1. the requester cannot approve; Security approves, a different person", async () => {
    const t = setup();
    const sup = await t.agent("support.agent");
    const g = (await t.ask(sup)).body.data as Xa;
    expect(g.status).toBe("REQUESTED");
    expect((await t.act(sup, g, "approve")).status).toBe(403);
    expect((await t.act(await t.agent("ops.agent"), g, "approve")).status).toBe(403); // not even the area
    expect((await t.act(await t.agent("security.officer"), g, "approve")).body.data.status).toBe("ACTIVE");
  });

  it("2. refuses no ticket, cross-organisation, cross-cell, too many merchants and too long", async () => {
    const t = setup();
    const sup = await t.agent("support.agent");
    expect((await t.ask(sup, { ...support, ticketId: "" })).status).toBe(400);
    expect((await t.ask(sup, { ...support, merchantIds: [NORTHWIND_UK, "mer_alder_books"] })).status).toBe(400); // two organisations
    expect((await t.ask(sup, { ...support, merchantIds: [NORTHWIND_UK, "mer_northwind_eu"] })).status).toBe(400); // two cells
    expect((await t.ask(sup, { ...support, durationMinutes: 241 })).status).toBe(400);
    expect((await t.ask(sup, { ...support, kind: "breakglass", ticketId: "INC-7", durationMinutes: 180 })).status).toBe(403); // Support cannot break glass
    const sre = await t.agent("sre.oncall");
    expect((await t.ask(sre, { ...support, kind: "breakglass", ticketId: "INC-7", durationMinutes: 180 })).status).toBe(400); // over 120
    expect((await t.ask(sre, { ...support, kind: "breakglass", ticketId: "INC-7", durationMinutes: 90 })).status).toBe(201);
  });

  it("3. approval needs a fresh password", async () => {
    const t = setup();
    const g = (await t.ask(await t.agent("support.agent"))).body.data as Xa;
    const res = await t.act(await t.agent("security.officer", false), g, "approve");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STEP_UP_REQUIRED");
  });

  it("4. the holder reads the named merchant's payments, masked, and every read is logged", async () => {
    const t = setup();
    const { sup, sec, g } = await t.active();
    const list = await t.payments(sup, g);
    expect(list.status).toBe(200);
    const rows = list.body.data.items as { merchantId: string; customerEmail: string; method: { last4: string } }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.merchantId === NORTHWIND_UK)).toBe(true);
    expect(rows.every((r) => r.customerEmail.includes("•••") && r.method.last4 === "••••")).toBe(true);

    // A payment of another merchant is not reachable, even by id.
    const other = t.services.data.payments("TEST").find((p) => p.merchantId !== NORTHWIND_UK)!;
    expect((await sup.get(`/api/v1/exceptional-access/${g.id}/payments/${other.id}`)).status).toBe(404);
    // Normal routes stay closed: the grant does not change the role.
    expect((await sup.get("/api/v1/payments")).status).toBe(403);

    const detail = await sec.get(`/api/v1/exceptional-access/${g.id}`);
    expect(detail.body.data.readCount).toBe(1);
    expect(t.services.audit.list({ action: "exceptional.use", outcome: "ALLOWED" })).toHaveLength(1);
  });

  it("4b. unmasks only the fields that were approved", async () => {
    const t = setup();
    const { sup, g } = await t.active({ ...support, unmasked: ["customer_email"] });
    const rows = (await t.payments(sup, g)).body.data.items as { customerEmail: string; method: { last4: string } }[];
    expect(rows[0]!.customerEmail).not.toContain("•••");
    expect(rows[0]!.method.last4).toBe("••••");
  });

  it("5. no write is reachable through a grant", async () => {
    const t = setup();
    const { sup, g } = await t.active();
    for (const [method, path] of [["post", `/api/v1/exceptional-access/${g.id}/payments`], ["put", `/api/v1/exceptional-access/${g.id}/payments`]] as const) {
      expect((await sup[method](path).set("Origin", ORIGIN).send({})).status, path).toBe(404);
    }
    // A real refund record: Support still cannot act on it while holding a grant.
    const refund = t.services.screens.rawRows("ZP-BRW-008")[0]!;
    const res = await sup.post(`/api/v1/screens/ZP-BRW-008/records/${refund.id}/actions/approve`).set("Origin", ORIGIN).send({ version: refund.version });
    expect([403, 404]).toContain(res.status);
    expect(refund.version).toBe(1);
  });

  it("6. one minute after expiry the window is closed, before anything else runs", async () => {
    const t = setup();
    const { sup, g } = await t.active();
    t.clock.now += 61 * 60_000;
    const res = await t.payments(sup, g);
    expect(res.status).toBe(403);
    expect((await sup.get(`/api/v1/exceptional-access/${g.id}`)).body.data.status).toBe("EXPIRED");
  });

  it("7. revoke and role change close the window on the next request", async () => {
    const t = setup();
    const { sup, sec, g } = await t.active();
    expect((await t.act(sec, g, "revoke", { reason: "Ticket resolved by phone" })).body.data.status).toBe("REVOKED");
    expect((await t.payments(sup, g)).status).toBe(403);

    const t2 = setup();
    const second = await t2.active();
    const grant = t2.services.access.allGrants().find((x) => x.username === "support.agent" && x.status === "ACTIVE")!;
    grant.status = "REVOKED"; // as if IAM revoked the Support role
    expect((await t2.payments(second.sup, second.g)).status).toBe(403);
    expect((await second.sec.get(`/api/v1/exceptional-access/${second.g.id}`)).body.data.status).toBe("CLOSED");
  });

  it("8. the reviewer is neither the approver nor the holder", async () => {
    const t = setup();
    const { sup, sec, g } = await t.active();
    const closed = (await t.act(sup, g, "close")).body.data as Xa;
    expect(closed.reviewDue).toBe(true);
    // The approver cannot review. There is only one Security officer locally, so nobody can yet.
    const res = await t.act(sec, closed, "review", { outcome: "in_policy", reason: "Reads match the ticket" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SELF_APPROVAL_PROHIBITED");
  });

  it("9. Super Admin cannot request, approve or see grants; it sees counts", async () => {
    const t = setup();
    await t.active();
    const sa = await t.agent("super.admin");
    expect((await t.ask(sa)).status).toBe(403);
    expect((await sa.get("/api/v1/exceptional-access")).status).toBe(403);
    const summary = (await sa.get("/api/v1/platform/summary")).body.data;
    expect(summary.exceptionalAccess).toEqual({ waiting: 0, active: 1, reviewDue: 0, reviewOverdue: 0 });
    expect(JSON.stringify(summary)).not.toContain("SUP-1042");
  });

  it("10. every transition and read is in the audit chain; requests lapse after 30 minutes", async () => {
    const t = setup();
    const { sup, g } = await t.active();
    await t.payments(sup, g);
    for (const a of ["exceptional.request", "exceptional.approve", "exceptional.use"]) {
      expect(t.services.audit.list({ action: a }).length, a).toBeGreaterThan(0);
    }
    expect(t.services.audit.verify().valid).toBe(true);

    const pending = (await t.ask(sup, { ...support, ticketId: "SUP-2000" })).body.data as Xa;
    t.clock.now += 31 * 60_000;
    expect((await sup.get(`/api/v1/exceptional-access/${pending.id}`)).body.data.status).toBe("LAPSED");
  });

  it("Support only sees their own requests; Security sees all and is notified", async () => {
    const t = setup();
    await t.ask(await t.agent("support.agent"));
    const sre = await t.agent("sre.oncall");
    expect((await sre.get("/api/v1/exceptional-access")).body.data.items).toHaveLength(0);
    const sec = await t.agent("security.officer");
    expect((await sec.get("/api/v1/exceptional-access")).body.data.items).toHaveLength(1);
    const bell = (await sec.get("/api/v1/notifications")).body.data as { title: string }[];
    expect(bell.some((n) => n.title === "Exceptional access: approve SUP-1042")).toBe(true);
  });
});
