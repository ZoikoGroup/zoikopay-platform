import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN, PASSWORD } from "./helpers.js";

/** 02-02 ZP-PER-WF-002: role and delegation administration. */

type Grant = { id: string; persona: string; status: string; version: number; actions: { name: string; allowed: boolean; blockedReason?: string }[] };

function setup() {
  const t = makeTestApp();
  /** Signs in through the form and confirms the password (step-up). */
  const agent = async (username: string, stepUp = true) => {
    const a = request.agent(t.app);
    expect((await a.post("/auth/login").set("Origin", ORIGIN).send({ username, password: PASSWORD })).status).toBe(200);
    if (stepUp) expect((await a.post("/auth/reauth").set("Origin", ORIGIN).send({ password: PASSWORD })).status).toBe(200);
    return a;
  };
  const post = (a: ReturnType<typeof request.agent>, path: string, body: object) => a.post(`/api/v1${path}`).set("Origin", ORIGIN).send(body);
  const ask = (a: ReturnType<typeof request.agent>, body: object) =>
    post(a, "/access/requests", { environments: ["TEST"], reason: "Joining the payments team", ...body });
  const act = (a: ReturnType<typeof request.agent>, g: Grant, action: string, body: object = {}) =>
    post(a, `/access/grants/${g.id}/actions/${action}`, { version: g.version, ...body });
  const newAccount = async (username: string) => {
    await t.accounts.createAccount({ username, password: "Strong#Pass1", firstName: "New", lastName: "Person" });
    return t.accounts.extra.find((x) => x.username === username)!;
  };
  return { ...t, agent, ask, act, newAccount };
}

const pending = (body: { data: { grants: Grant[] } }) => body.data.grants.find((g) => g.status === "PENDING_APPROVAL")!;

describe("Access screen: who may open it", () => {
  it("is open to merchant owner, IAM and Security only", async () => {
    const t = setup();
    for (const [u, code] of [["iam.admin", 200], ["merchant.owner", 200], ["security.officer", 200], ["ops.agent", 403], ["super.admin", 403], ["merchant.ops", 403]] as const) {
      expect((await request(t.app).get("/api/v1/access/members").set("Cookie", t.loginAs(u))).status, u).toBe(code);
    }
  });

  it("shows a merchant owner only their own organisation's people", async () => {
    const t = setup();
    const res = await request(t.app).get("/api/v1/access/members").set("Cookie", t.loginAs("merchant.owner"));
    const names = (res.body.data.items as { username: string }[]).map((r) => r.username).sort();
    expect(names).toEqual(["merchant.dev", "merchant.finance", "merchant.ops", "merchant.owner"]); // northwind only; no staff, no other merchant
    const self = (res.body.data.items as { username: string; isSelf: boolean; nextStep: string | null }[]).find((r) => r.username === "merchant.owner")!;
    expect(self.isSelf).toBe(true);
    expect(self.nextStep).toBeNull();
  });

  it("shows IAM new accounts that have no role yet", async () => {
    const t = setup();
    await t.newAccount("new.person");
    const res = await request(t.app).get("/api/v1/access/members?status=NO_ROLE").set("Cookie", t.loginAs("iam.admin"));
    expect((res.body.data.items as { username: string }[]).map((r) => r.username)).toEqual(["new.person"]);
  });
});

describe("Granting a role (two people)", () => {
  it("gives a new account a role after an independent approval, effective on the next request", async () => {
    const t = setup();
    const acct = await t.newAccount("new.person");
    const a = await t.agent("iam.admin");
    const req = await t.ask(a, { username: "new.person", persona: "POR", legalEntityIds: ["cell_uk_01"] });
    expect(req.status).toBe(201);
    const g = pending(req.body);
    expect(t.services.directory.find(acct.sub)).toBeUndefined(); // not live until approved

    // The requester cannot approve their own request.
    const self = g.actions.find((x) => x.name === "approve")!;
    expect(self.allowed).toBe(false);
    expect((await t.act(a, g, "approve")).body.code).toBe("SELF_APPROVAL_PROHIBITED");

    const b = await t.agent("iam.admin.b");
    const ok = await t.act(b, g, "approve");
    expect(ok.status).toBe(200);
    expect(t.services.directory.find(acct.sub)?.personas).toEqual(["POR"]);
    expect(t.services.audit.list({ action: "access.grant.approve", outcome: "SUCCEEDED" })).toHaveLength(1);
  });

  it("requires the checker's password again", async () => {
    const t = setup();
    await t.newAccount("new.person");
    const g = pending((await t.ask(await t.agent("iam.admin"), { username: "new.person", persona: "PRISK", legalEntityIds: ["cell_uk_01"] })).body);
    const res = await t.act(await t.agent("iam.admin.b", false), g, "approve");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("STEP_UP_REQUIRED");
  });

  it("refuses self-grant, Super Admin, and roles above a merchant owner", async () => {
    const t = setup();
    const iam = await t.agent("iam.admin");
    expect((await t.ask(iam, { username: "iam.admin", persona: "PSEC", legalEntityIds: ["cell_uk_01"] })).body.code).toBe("SELF_GRANT_PROHIBITED");
    await t.newAccount("new.person");
    expect((await t.ask(iam, { username: "new.person", persona: "SUPER_ADMIN" })).body.code).toBe("ROLE_EXCEEDS_DELEGATOR");

    const owner = await t.agent("merchant.owner");
    expect((await t.ask(owner, { username: "new.person", persona: "MOWN", merchantIds: ["*"] })).body.code).toBe("ROLE_EXCEEDS_DELEGATOR");
    expect((await t.ask(owner, { username: "new.person", persona: "POR", legalEntityIds: ["cell_uk_01"] })).body.code).toBe("ROLE_EXCEEDS_DELEGATOR");
    // LIVE is outside the owner's own access.
    expect((await t.ask(owner, { username: "new.person", persona: "MOPS", merchantIds: ["*"], environments: ["LIVE"] })).body.code).toBe("ROLE_EXCEEDS_DELEGATOR");
  });

  it("keeps a merchant owner inside their own organisation", async () => {
    const t = setup();
    const owner = await t.agent("merchant.owner");
    await t.newAccount("new.person");
    // A merchant of another organisation.
    const other = t.services.data.merchants("TEST").find((m) => m.tenantId !== "ten_northwind")!;
    expect((await t.ask(owner, { username: "new.person", persona: "MOPS", merchantIds: [other.id] })).status).toBe(403);
    // Someone who belongs elsewhere cannot be taken over; the answer does not say where.
    const res = await t.ask(owner, { username: "merchant.viewer", persona: "MVIEW", merchantIds: ["*"] });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("alder");
  });

  it("lets IAM approve a merchant owner's request; the new role replaces the old one", async () => {
    const t = setup();
    const owner = await t.agent("merchant.owner");
    const req = await t.ask(owner, { username: "merchant.ops", persona: "MVIEW", merchantIds: ["*"] });
    expect(req.status).toBe(201);
    await t.act(await t.agent("iam.admin"), pending(req.body), "approve");
    const grants = t.services.access.allGrants().filter((g) => g.username === "merchant.ops");
    expect(grants.map((g) => [g.persona, g.status])).toEqual([["MOPS", "REPLACED"], ["MVIEW", "ACTIVE"]]);
  });

  it("needs a reason to reject, and refuses a stale version", async () => {
    const t = setup();
    await t.newAccount("new.person");
    const g = pending((await t.ask(await t.agent("iam.admin"), { username: "new.person", persona: "PPSP", legalEntityIds: ["cell_uk_01"] })).body);
    const b = await t.agent("iam.admin.b");
    expect((await t.act(b, g, "reject", { reason: "no" })).status).toBe(400);
    expect((await t.act(b, { ...g, version: 99 }, "reject", { reason: "Not part of the partner team" })).body.code).toBe("STALE_VERSION");
    expect((await t.act(b, g, "reject", { reason: "Not part of the partner team" })).body.data.grants[0].status).toBe("REJECTED");
  });

  it("refuses fields that would set the requester, status or approver", async () => {
    const t = setup();
    await t.newAccount("new.person");
    const res = await t.ask(await t.agent("iam.admin"), { username: "new.person", persona: "POR", legalEntityIds: ["cell_uk_01"], status: "ACTIVE" });
    expect(res.status).toBe(400);
  });
});

describe("Revoking and narrowing", () => {
  it("revokes immediately: the person's very next request is denied", async () => {
    const t = setup();
    const victim = t.loginAs("merchant.ops");
    expect((await request(t.app).get("/api/v1/payments").set("Cookie", victim)).status).toBe(200);

    const sec = await t.agent("security.officer");
    const member = await sec.get("/api/v1/access/members/00000000-0000-4000-8000-000000000011");
    const g = (member.body.data.grants as Grant[]).find((x) => x.status === "ACTIVE")!;
    expect((await t.act(sec, g, "revoke", { reason: "Left the company today" })).status).toBe(200);

    expect((await request(t.app).get("/api/v1/payments").set("Cookie", victim)).status).toBe(403);
    expect((await request(t.app).get("/api/v1/me").set("Cookie", victim)).body.data.hasAccess).toBe(false);
  });

  it("does not let anyone revoke or change their own access", async () => {
    const t = setup();
    const iam = await t.agent("iam.admin");
    const own = (await iam.get("/api/v1/access/members/00000000-0000-4000-8000-000000000008")).body.data.grants[0] as Grant;
    expect(own.actions.every((x) => !x.allowed)).toBe(true);
    expect((await t.act(iam, own, "revoke", { reason: "Testing self revoke" })).body.code).toBe("SELF_GRANT_PROHIBITED");
  });

  it("narrows by moving the expiry earlier only, and expired roles stop working", async () => {
    let now = Date.parse("2026-11-11T10:00:00Z");
    const t = makeTestApp({ now: () => now });
    const a = request.agent(t.app);
    await a.post("/auth/login").set("Origin", ORIGIN).send({ username: "iam.admin", password: PASSWORD });
    const g = ((await a.get("/api/v1/access/members/00000000-0000-4000-8000-000000000016")).body.data.grants as Grant[])[0]!;
    const narrow = (expiresAt: string, version: number) =>
      a.post(`/api/v1/access/grants/${g.id}/actions/narrow`).set("Origin", ORIGIN).send({ version, expiresAt, reason: "Contract ends this week" });
    expect((await narrow("2026-11-13", g.version)).status).toBe(200);
    expect((await narrow("2026-12-01", g.version + 1)).status).toBe(400); // never extends
    now = Date.parse("2026-11-14T00:00:00Z");
    expect(t.services.directory.find("00000000-0000-4000-8000-000000000016")).toBeUndefined();
  });
});

describe("Notifications", () => {
  it("tells an eligible checker, but not the requester, that a grant waits", async () => {
    const t = setup();
    await t.newAccount("new.person");
    await t.ask(await t.agent("iam.admin"), { username: "new.person", persona: "POR", legalEntityIds: ["cell_uk_01"] });
    const titles = async (u: string) => ((await request(t.app).get("/api/v1/notifications").set("Cookie", t.loginAs(u))).body.data as { title: string }[]).map((n) => n.title);
    expect((await titles("iam.admin.b")).some((x) => x.startsWith("Access: approve"))).toBe(true);
    expect((await titles("iam.admin")).some((x) => x.startsWith("Access:"))).toBe(false);
  });
});
