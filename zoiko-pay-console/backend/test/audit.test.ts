import request from "supertest";
import { describe, expect, it } from "vitest";
import { AuditLog, type AuditEntry } from "../src/services/audit.js";
import { compareMinor, sumMinor } from "../src/services/money.js";
import { makeTestApp } from "./helpers.js";

const entry = (n: number) => ({ actorSub: `u${n}`, actorUsername: `user${n}`, action: "auth.login", outcome: "SUCCEEDED" as const });

describe("hash-chained audit log", () => {
  it("verifies an untouched chain", () => {
    const log = new AuditLog();
    for (let i = 0; i < 5; i++) log.append(entry(i));
    expect(log.verify()).toEqual({ valid: true, checked: 5 });
  });

  it("detects edits, deletions and reordering", () => {
    const log = new AuditLog();
    for (let i = 0; i < 5; i++) log.append(entry(i));
    const all = [...log.list()];
    const edited: AuditEntry[] = all.map((e) => (e.seq === 3 ? { ...e, actorUsername: "someone-else" } : e));
    expect(log.verify(edited)).toMatchObject({ valid: false, brokenAt: 3 });
    expect(log.verify(all.filter((e) => e.seq !== 2))).toMatchObject({ valid: false, brokenAt: 3 });
    expect(log.verify([all[1]!, all[0]!, ...all.slice(2)])).toMatchObject({ valid: false, brokenAt: 2 });
  });

  it("freezes entries", () => {
    const e = new AuditLog().append(entry(1));
    expect(Object.isFrozen(e)).toBe(true);
  });

  it("records denied requests", async () => {
    const { app, services, loginAs } = makeTestApp();
    await request(app).get("/api/v1/payments").set("Cookie", loginAs("super.admin"));
    const denied = services.audit.list({ outcome: "DENIED" });
    expect(denied.some((e) => e.actorUsername === "super.admin")).toBe(true);
    expect(services.audit.verify().valid).toBe(true);
  });
});

describe("money helpers", () => {
  it("adds and compares minor units without floating point", () => {
    expect(sumMinor(["10", "20", "9007199254740993"])).toBe("9007199254741023");
    expect(compareMinor("100", "99")).toBe(1);
    expect(() => sumMinor(["1.5"])).toThrow();
  });
});
