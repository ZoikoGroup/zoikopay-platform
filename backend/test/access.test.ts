import request from "supertest";
import { describe, expect, it } from "vitest";
import { FIXTURE_IDS } from "../src/database/fixtures.js";
import { makeTestApp, ORIGIN } from "./helpers.js";

/**
 * 02-02 ZP-PER-WF-002, role and delegation administration. Grants live only in
 * merchant.memberships (Go), which has no grant administration yet, so the
 * console refuses every Access-screen read and write (OPEN_QUESTIONS Q39). The
 * console's own in-memory grant list is gone: a grant made there would look
 * real but give nobody access.
 */
const ROUTES: [method: "get" | "post", path: string][] = [
  ["get", "/api/v1/access/members"],
  ["get", "/api/v1/access/members/00000000-0000-4000-8000-000000000011"],
  ["get", "/api/v1/access/options"],
  ["post", "/api/v1/access/requests"],
  ["post", "/api/v1/access/grants/grt_00001/actions/revoke"],
];

describe("Access screen while grant administration is not built", () => {
  it("refuses every read and write for the roles that may open it, with a clear reason", async () => {
    const t = makeTestApp();
    for (const username of ["merchant.owner", "iam.admin", "security.officer"]) {
      const cookie = t.loginAs(username);
      for (const [method, path] of ROUTES) {
        const res = method === "get"
          ? await request(t.app).get(path).set("Cookie", cookie)
          : await request(t.app).post(path).set("Cookie", cookie).set("Origin", ORIGIN)
            .send({ username: "merchant.dev", persona: "MOPS", merchantIds: [FIXTURE_IDS.merchants.northwindUk], environments: ["TEST"], reason: "x", version: 1 });
        expect(res.status, `${username} ${method} ${path}`).toBe(503);
        expect(res.body.code).toBe("GRANT_ADMINISTRATION_UNAVAILABLE");
        expect(res.body.detail).toMatch(/membership/i);
      }
    }
  });

  it("still refuses roles without the Access area first (403 before 503)", async () => {
    const t = makeTestApp();
    for (const username of ["merchant.ops", "merchant.viewer", "super.admin", "ops.agent"]) {
      expect((await request(t.app).get("/api/v1/access/members").set("Cookie", t.loginAs(username))).status, username).toBe(403);
    }
  });

  it("records each refused attempt in the console audit chain", async () => {
    const t = makeTestApp();
    await request(t.app).post("/api/v1/access/requests").set("Cookie", t.loginAs("merchant.owner")).set("Origin", ORIGIN).send({});
    expect(t.services.audit.list().some((e) => e.action === "access.request" && e.outcome === "FAILED")).toBe(true);
  });
});
