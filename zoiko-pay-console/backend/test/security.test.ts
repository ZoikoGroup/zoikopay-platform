import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN } from "./helpers.js";

describe("transport and request security", () => {
  const { app, loginAs } = makeTestApp();

  it("serves liveness without a session", async () => {
    const res = await request(app).get("/api/v1/health/live");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
  });

  it("rejects every data endpoint without a session, as problem+json", async () => {
    for (const path of ["/api/v1/me", "/api/v1/payments", "/api/v1/system/health", "/api/v1/overview/kpis", "/api/v1/overview/recent-activity"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.body.code).toBe("UNAUTHENTICATED");
      expect(res.body.requestId).toBeTruthy();
    }
  });

  it("ignores client-supplied identity, role and tenant headers", async () => {
    const res = await request(app).get("/api/v1/payments")
      .set("X-User", "super.admin").set("X-Role", "PFIN").set("X-Tenant-Id", "ten_northwind").set("Authorization", "Bearer forged");
    expect(res.status).toBe(401);
  });

  it("sets security headers and a request id", async () => {
    const res = await request(app).get("/api/v1/health/live");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects state-changing requests from another origin (CSRF)", async () => {
    const cookie = loginAs("fin.controller.b");
    for (const origin of [undefined, "https://evil.example"]) {
      const req = request(app).put("/api/v1/session/environment").set("Cookie", cookie).send({ environment: "TEST" });
      const res = await (origin ? req.set("Origin", origin) : req);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("ORIGIN_REJECTED");
    }
    const okRes = await request(app).put("/api/v1/session/environment").set("Cookie", cookie).set("Origin", ORIGIN).send({ environment: "TEST" });
    expect(okRes.status).toBe(200);
  });

  it("validates input on the server", async () => {
    const cookie = loginAs("ops.agent");
    const bad = await request(app).get("/api/v1/payments?pageSize=5000&status=NOT_A_STATUS").set("Cookie", cookie);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION_FAILED");
    expect(bad.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(["pageSize", "status.0"]);

    const badId = await request(app).get("/api/v1/payments/not-an-id").set("Cookie", cookie);
    expect(badId.status).toBe(400);

    const malformed = await request(app).put("/api/v1/session/environment").set("Cookie", cookie).set("Origin", ORIGIN)
      .set("Content-Type", "application/json").send("{not json");
    expect(malformed.status).toBe(400);

    const extra = await request(app).put("/api/v1/session/environment").set("Cookie", cookie).set("Origin", ORIGIN)
      .send({ environment: "TEST", role: "SUPER_ADMIN" });
    expect(extra.status).toBe(400);
  });

  it("returns 404 problem for unknown routes", async () => {
    const res = await request(app).get("/api/v1/does-not-exist").set("Cookie", loginAs("ops.agent"));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("expires sessions after the absolute lifetime", async () => {
    const cookie = loginAs("ops.agent", { loginAgoMs: 9 * 3_600_000 });
    const res = await request(app).get("/api/v1/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_EXPIRED");
  });
});
