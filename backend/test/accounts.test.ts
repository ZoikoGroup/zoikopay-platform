import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN, PASSWORD } from "./helpers.js";

const post = (t: ReturnType<typeof makeTestApp>, path: string, body: object, origin: string | null = ORIGIN) => {
  const r = request(t.app).post(path).send(body);
  return origin ? r.set("Origin", origin) : r;
};
const account = { username: "new.user", firstName: "New", lastName: "User", email: "new.user@example.test", password: "Strong#Pass1" };

describe("create account (sign-in page)", () => {
  it("creates an account with no role", async () => {
    const t = makeTestApp();
    const res = await post(t, "/auth/register", account);
    expect(res.status).toBe(201);
    expect(t.accounts.created).toEqual(["new.user"]);
    expect(t.services.audit.list({ action: "account.create", outcome: "SUCCEEDED" })).toHaveLength(1);
    expect(t.services.directory.find("anything-for-new.user")).toBeUndefined(); // no membership is created
  });

  it("enforces the password policy on the server", async () => {
    const t = makeTestApp();
    for (const pw of ["short1!", "alllowercase1!", "NoDigits!!", "NoSymbol123", "new.userA1!"]) {
      const res = await post(t, "/auth/register", { ...account, password: pw });
      expect(res.status, pw).toBe(400);
    }
    expect((await post(t, "/auth/register", { ...account, password: "Zoiko@123" })).status).toBe(201);
  });

  it("refuses a taken username", async () => {
    const t = makeTestApp();
    const res = await post(t, "/auth/register", { ...account, username: "ops.agent" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("USERNAME_TAKEN");
  });

  it("validates fields and refuses extra ones (no self-assigned roles)", async () => {
    const t = makeTestApp();
    expect((await post(t, "/auth/register", { ...account, email: "nope" })).status).toBe(400);
    expect((await post(t, "/auth/register", { ...account, username: "1bad" })).status).toBe(400);
    expect((await post(t, "/auth/register", { ...account, role: "SUPER_ADMIN" })).status).toBe(400);
  });

  it("refuses requests from another site", async () => {
    const t = makeTestApp();
    expect((await post(t, "/auth/register", account, "https://evil.example")).status).toBe(403);
  });
});

describe("change password (sign-in page)", () => {
  it("checks the current password first", async () => {
    const t = makeTestApp();
    const bad = await post(t, "/auth/change-password", { username: "ops.agent", currentPassword: "wrong", newPassword: "Another#Pass2" });
    expect(bad.status).toBe(401);
    expect(t.accounts.passwords.size).toBe(0);
    const ok = await post(t, "/auth/change-password", { username: "ops.agent", currentPassword: PASSWORD, newPassword: "Another#Pass2" });
    expect(ok.status).toBe(200);
    expect(t.accounts.passwords.get("ops.agent")).toBe("Another#Pass2");
  });

  it("refuses a weak or unchanged new password", async () => {
    const t = makeTestApp();
    expect((await post(t, "/auth/change-password", { username: "ops.agent", currentPassword: PASSWORD, newPassword: "weak" })).status).toBe(400);
    expect((await post(t, "/auth/change-password", { username: "ops.agent", currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400);
  });
});
