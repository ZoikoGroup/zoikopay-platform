import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp, ORIGIN } from "./helpers.js";

describe("settings and setup guide (TEST, per user)", () => {
  it("saves a user's settings, validates them, and never shows them to another user", async () => {
    const t = makeTestApp();
    const a = t.loginAs("merchant.ops");
    const put = (cookie: string, section: string, body: object) => request(t.app).put(`/api/v1/preferences/${section}`).set("Cookie", cookie).set("Origin", ORIGIN).send(body);

    expect((await put(a, "branding", { brandColor: "green" })).status).toBe(400);
    expect((await put(a, "portal", { returnUrl: "http://plain.example" })).status).toBe(400);
    expect((await put(a, "personal", { favouriteFood: "pizza" })).status).toBe(400); // unknown field
    expect((await put(a, "unknown", {})).status).toBe(400);

    const ok = await put(a, "branding", { brandColor: "#123abc", invoicePrefix: "ZPAY", footer: "Thanks!", reminders: "On the due date" });
    expect(ok.status).toBe(200);
    expect((await request(t.app).get("/api/v1/preferences").set("Cookie", a)).body.data.branding).toEqual({ brandColor: "#123abc", invoicePrefix: "ZPAY", footer: "Thanks!", reminders: "On the due date" });
    expect((await request(t.app).get("/api/v1/preferences").set("Cookie", t.loginAs("merchant.dev"))).body.data).toEqual({});
    expect(t.services.audit.list({ action: "preferences.branding.update", outcome: "SUCCEEDED" })).toHaveLength(1);
  });

  it("ticks setup steps from what the user has actually done", async () => {
    const t = makeTestApp();
    const ops = t.loginAs("merchant.ops");
    const progress = async () => (await request(t.app).get("/api/v1/setup-progress").set("Cookie", ops)).body.data as Record<string, boolean>;
    expect(await progress()).toMatchObject({ product: false, details: false });
    await request(t.app).post("/api/v1/screens/ZP-COM-002/records").set("Cookie", ops).set("Origin", ORIGIN)
      .send({ merchantId: "mer_northwind_uk", values: { name: "Hat", price: "12", billing: "One-off" } });
    await request(t.app).put("/api/v1/preferences/personal").set("Cookie", ops).set("Origin", ORIGIN).send({ phone: "+44 20 7946 0000" });
    expect(await progress()).toMatchObject({ product: true, details: true, webhook: false });
  });
});
