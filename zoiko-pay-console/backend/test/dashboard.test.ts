import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers.js";

/**
 * Who sees what on the Overview dashboard, pinned to the 02-02 §03 permission register:
 *   PAYMENT.READ    MOWN, MOPS, MFIN, MVIEW, POR
 *   RISK.CASE.READ  PRISK, PCOMP, POR
 *   PAYOUT.READ     MFIN, PRECON, PFIN
 *   LEDGER.READ     MFIN, MVIEW, PRECON, PFIN
 */
describe("dashboard access per role (02-02 §03)", () => {
  const t = makeTestApp();
  const get = (u: string, path: string) => request(t.app).get(path).set("Cookie", t.loginAs(u));
  const kpi = async (u: string, key: string) => {
    const res = await get(u, "/api/v1/overview/kpis?period=30d&currency=GBP");
    expect(res.status, u).toBe(200);
    return (res.body.data.kpis as { key: string; restricted: boolean }[]).find((k) => k.key === key)!;
  };

  it("serves payment records only to PAYMENT.READ roles", async () => {
    for (const u of ["merchant.owner", "merchant.ops", "merchant.finance", "merchant.viewer", "ops.agent"]) {
      expect((await get(u, "/api/v1/payments")).status, u).toBe(200);
    }
    for (const u of ["risk.analyst", "recon.analyst", "fin.controller.a", "compliance.officer", "support.agent", "sre.oncall", "merchant.dev", "super.admin"]) {
      expect((await get(u, "/api/v1/payments")).status, u).toBe(403);
    }
  });

  it("shows risk screening only to RISK.CASE.READ roles", async () => {
    const risk = async (u: string) => ((await get(u, "/api/v1/payments?pageSize=50")).body.data.items as { risk: unknown }[]).map((p) => p.risk);
    expect((await risk("ops.agent")).some((r) => r !== null)).toBe(true);
    for (const u of ["merchant.ops", "merchant.owner", "merchant.finance", "merchant.viewer"]) {
      expect((await risk(u)).every((r) => r === null), u).toBe(true);
    }
  });

  it("shows the payout queue count only to PAYOUT.READ roles", async () => {
    for (const u of ["merchant.finance", "recon.analyst", "fin.controller.a"]) expect((await kpi(u, "pending_approvals")).restricted, u).toBe(false);
    for (const u of ["merchant.owner", "merchant.ops", "merchant.viewer", "ops.agent", "risk.analyst"]) expect((await kpi(u, "pending_approvals")).restricted, u).toBe(true);
  });

  it("shows settlement status only to LEDGER.READ roles", async () => {
    for (const u of ["merchant.finance", "merchant.viewer", "recon.analyst", "fin.controller.a"]) expect((await kpi(u, "settlement")).restricted, u).toBe(false);
    for (const u of ["merchant.owner", "merchant.ops", "ops.agent", "risk.analyst"]) expect((await kpi(u, "settlement")).restricted, u).toBe(true);
  });

  it("filters recent activity by the same rules", async () => {
    const kinds = async (u: string) => ((await get(u, "/api/v1/overview/recent-activity")).body.data as { kind: string }[]).map((a) => a.kind);
    for (const u of ["merchant.owner", "merchant.ops", "merchant.viewer"]) {
      const k = await kinds(u);
      expect(k, u).not.toContain("risk_alert");
      expect(k, u).not.toContain("payout_completed");
    }
    expect(await kinds("ops.agent")).not.toContain("payout_completed");
    for (const u of ["risk.analyst", "fin.controller.a", "recon.analyst"]) expect(await kinds(u), u).toEqual([]); // no PAYMENT.READ
  });
});
