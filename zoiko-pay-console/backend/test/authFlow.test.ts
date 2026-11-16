import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN, PASSWORD } from "./helpers.js";

const login = (t: ReturnType<typeof makeTestApp>, body: object, origin: string | null = ORIGIN) => {
  const agent = request.agent(t.app);
  const req = agent.post("/auth/login").send(body);
  return { agent, res: origin ? req.set("Origin", origin) : req };
};

describe("sign-in form (POST /auth/login)", () => {
  it("signs in with a correct password and regenerates the session", async () => {
    const t = makeTestApp();
    const { agent, res } = login(t, { username: "ops.agent", password: PASSWORD });
    const r = await res;
    expect(r.status).toBe(200);
    const cookie = r.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^zp_console_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const me = await agent.get("/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ username: "ops.agent", personas: ["POR"], environment: "TEST" });
    expect(t.services.audit.list({ action: "auth.login", outcome: "SUCCEEDED" })).toHaveLength(1);
  });

  it("rejects a wrong password with a generic message and audits it without the password", async () => {
    const t = makeTestApp();
    const { agent, res } = login(t, { username: "ops.agent", password: "wrong" });
    const r = await res;
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: "INVALID_CREDENTIALS", title: "Invalid username or password" });
    expect((await agent.get("/api/v1/me")).status).toBe(401);
    const failed = t.services.audit.list({ action: "auth.login", outcome: "FAILED" });
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain("wrong");
  });

  it("gives the same answer for an unknown user (no username probing)", async () => {
    const t = makeTestApp();
    const r = await login(t, { username: "nobody", password: PASSWORD }).res;
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("INVALID_CREDENTIALS");
  });

  it("validates the form on the server", async () => {
    const t = makeTestApp();
    const r = await login(t, { username: "", password: "" }).res;
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(["password", "username"]);
    const extra = await login(t, { username: "a", password: "b", role: "SUPER_ADMIN" }).res;
    expect(extra.status).toBe(400);
  });

  it("refuses sign-in posted from another site (CSRF)", async () => {
    const t = makeTestApp();
    for (const origin of [null, "https://evil.example"]) {
      const r = await login(t, { username: "ops.agent", password: PASSWORD }, origin).res;
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("ORIGIN_REJECTED");
    }
  });

  it("limits sign-in attempts", async () => {
    const t = makeTestApp();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login(t, { username: "ops.agent", password: "wrong" }).res).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it("gives a signed-in user with no membership no access (deny by default)", async () => {
    const t = makeTestApp();
    t.idp.extraUsers.set("stranger", { sub: "unknown-sub", username: "stranger", displayName: "Stranger", authTime: Math.floor(Date.now() / 1000) });
    const { agent, res } = login(t, { username: "stranger", password: PASSWORD });
    expect((await res).status).toBe(200);
    const me = await agent.get("/api/v1/me");
    expect(me.body.data).toMatchObject({ hasAccess: false, personas: [], permissions: [] });
    expect((await agent.get("/api/v1/overview/kpis")).status).toBe(403);
  });

  it("signs out: ends the console session and the identity-provider session", async () => {
    const t = makeTestApp();
    const { agent, res } = login(t, { username: "ops.agent", password: PASSWORD });
    await res;
    expect((await agent.post("/auth/logout")).status).toBe(403); // origin required
    const out = await agent.post("/auth/logout").set("Origin", ORIGIN);
    expect(out.status).toBe(200);
    expect(t.idp.loggedOut).toEqual(["rt-ops.agent"]);
    expect((await agent.get("/api/v1/me")).status).toBe(401);
  });
});
