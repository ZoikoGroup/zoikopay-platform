/**
 * Persona → permission catalog.
 *
 * Personas are the 02-02 (Personas & Permissions) codes. Data permissions
 * follow each persona's "permitted intent" and "restriction", and 03-05 §10
 * (Super Admin policy). Deny by default: a permission that is not listed for
 * a persona is not held.
 *
 * Holding a permission is necessary but never sufficient: every record is also
 * checked against the caller's scope (tenant, legal entity, merchant,
 * environment) in policy.ts.
 */

/** Data permissions used by the dashboard. */
const DATA = [
  "overview.view",
  "metrics.counts.view", // aggregate counts and ratios
  "metrics.amounts.view", // aggregate money amounts
  "payments.read", // 02-02 PAYMENT.READ
  "payments.method.view", // card brand + last4
  "risk.read", // 02-02 RISK.CASE.READ: risk screening outcomes and alerts
  "payouts.read", // 02-02 PAYOUT.READ: payout queue counts and payout activity
  "ledger.read", // 02-02 LEDGER.READ: settlement and reconciliation status
  "health.view",
] as const;

/**
 * One permission per side-rail area (Business Requirements 01-05 §07:
 * "Hide items by persona, enforce authorization server-side").
 */
const AREAS = [
  "area.merchants",
  "area.payment_operations",
  "area.routing",
  "area.partners",
  "area.refunds_disputes",
  "area.finance",
  "area.payouts",
  "area.risk_compliance",
  "area.developers",
  "area.audits",
  "area.qa_release",
  // Not in the 01-05 §07 side rail: role administration from 02-02 ZP-PER-WF-002
  // (OPEN_QUESTIONS Q18).
  "area.access",
  // Not in the 01-05 §07 side rail: Super Admin coordination page (03-05 §10.1).
  "area.platform",
  // Not in the §07 rail: exceptional access, 02-02 WF-007 / WF-011 (ADR 0004).
  "area.exceptional",
] as const;

export const PERMISSIONS = [...DATA, ...AREAS] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERSONAS = [
  "SUPER_ADMIN",
  "MOWN", "MOPS", "MFIN", "MDEV", "MVIEW",
  "POR", "PSUP", "PRISK", "PCOMP", "PRECON", "PFIN", "PPSP", "PIAM", "PSEC", "PSRE",
] as const;
export type Persona = (typeof PERSONAS)[number];

/** Display names, from the 02-02 persona model. */
export const PERSONA_LABELS: Record<Persona, string> = {
  SUPER_ADMIN: "Super Admin",
  MOWN: "Merchant owner",
  MOPS: "Merchant operations",
  MFIN: "Merchant finance",
  MDEV: "Merchant developer",
  MVIEW: "Merchant auditor / viewer",
  POR: "Pay Operations Agent",
  PSUP: "Support Agent",
  PRISK: "Risk Analyst",
  PCOMP: "Compliance Officer",
  PRECON: "Reconciliation Analyst",
  PFIN: "Finance Controller",
  PPSP: "Partner Operations / PSP Liaison",
  PIAM: "IAM Administrator",
  PSEC: "Security Officer",
  PSRE: "Site Reliability Engineer",
};

export const MERCHANT_PERSONAS: readonly Persona[] = ["MOWN", "MOPS", "MFIN", "MDEV", "MVIEW"];

const base: Permission[] = ["overview.view"];

/** Dashboard data access per persona. */
const DATA_PERMISSIONS: Record<Persona, readonly Permission[]> = {
  // 03-05 §10.1: coordination role. "Default dashboard shows service health,
  // counts and redacted tenant metadata": that is the Super Admin page
  // (area.platform), which computes its own platform-wide counts. No Overview:
  // its per-merchant drill-down (fraud rate, settlement, payouts) is merchant
  // operating data, not coordination data. No transactions, PII, money
  // amounts, ledger or funds.
  SUPER_ADMIN: ["health.view"],

  // Each data permission follows the 02-02 §03 permission register exactly:
  //   PAYMENT.READ    MOWN, MOPS, MFIN, MVIEW, POR
  //   RISK.CASE.READ  PRISK, PCOMP, POR
  //   PAYOUT.READ     MFIN, PRECON, PFIN
  //   LEDGER.READ     MFIN, MVIEW, PRECON, PFIN (PAUD is not a console persona, Q23)
  // Aggregate counts and amounts go to roles whose 02-02 intent covers
  // operating or financial figures; a role never sees a figure it could not
  // read as records.

  // Merchant side (02-02). Scope is always the merchant's own tenant/merchants.
  MOWN: [...base, "metrics.counts.view", "metrics.amounts.view", "payments.read"],
  MOPS: [...base, "metrics.counts.view", "metrics.amounts.view", "payments.read", "payments.method.view"],
  MFIN: [...base, "metrics.counts.view", "metrics.amounts.view", "payments.read", "payouts.read", "ledger.read"],
  MDEV: [...base],
  MVIEW: [...base, "metrics.counts.view", "metrics.amounts.view", "payments.read", "ledger.read"],

  // Internal (02-02).
  POR: [...base, "metrics.counts.view", "metrics.amounts.view", "payments.read", "payments.method.view", "risk.read", "health.view"],
  // "No default cross-tenant search": support sees no data by default.
  PSUP: [...base, "health.view"],
  // Not PAYMENT.READ: risk works from risk cases, so counts only, no payment records.
  PRISK: [...base, "metrics.counts.view", "risk.read"],
  PCOMP: [...base, "risk.read"],
  // Not PAYMENT.READ: finance and reconciliation work from ledger, payout and settlement data.
  PRECON: [...base, "metrics.counts.view", "metrics.amounts.view", "payouts.read", "ledger.read"],
  PFIN: [...base, "metrics.counts.view", "metrics.amounts.view", "payouts.read", "ledger.read"],
  PPSP: [...base, "health.view"],
  PIAM: [...base],
  PSEC: [...base, "health.view"],
  // "System health, non-sensitive operational controls; no routine content access".
  PSRE: [...base, "health.view"],
};

/**
 * Side-rail areas per persona, from the persona list of each screen in the
 * Business Requirements (ZP-BRW-002 … 014), translated to 02-02 codes:
 * PAY-OPS→POR, PAY-FIN→PFIN, PAY-COMP→PCOMP, PAY-RISK→PRISK, PAY-SEC→PSEC,
 * MER-OWNER→MOWN, MER-OPS→MOPS, MER-FIN→MFIN, MER-DEV→MDEV. BR codes with no
 * 02-02 equivalent (PAY-PROD, QA, PAY-QA, CTO, AUD-RO) are not mapped
 * (OPEN_QUESTIONS Q12). Two additions come from 02-02 itself and are marked.
 */
const AREA_PERSONAS: Record<(typeof AREAS)[number], readonly Persona[]> = {
  "area.merchants": ["MOWN", "PCOMP", "PRISK", "POR"], // 002, 003
  "area.payment_operations": ["MDEV", "MOPS", "POR", "MFIN"], // 004, 005
  "area.routing": ["POR", "PCOMP"], // 006
  "area.partners": ["POR", "PSEC", "PCOMP", "PPSP"], // 007; PPSP: 02-02 "Partner Operations / PSP Liaison"
  "area.refunds_disputes": ["MOPS", "POR", "MFIN"], // 008
  "area.finance": ["PFIN", "MFIN", "POR", "PRISK", "PRECON"], // 009, 011; PRECON: 02-02 "Reconciliation Analyst"
  "area.payouts": ["MFIN", "PFIN", "PCOMP"], // 010
  "area.risk_compliance": ["PCOMP", "PRISK", "PSEC"], // 012
  "area.developers": ["MDEV", "MOPS", "MFIN", "MOWN"], // 004, 013
  "area.audits": ["PSEC", "PCOMP", "MVIEW"], // 02-02: audit/access review (PSEC), compliance (PCOMP), "auditor/viewer" (MVIEW)
  "area.qa_release": ["PCOMP", "PFIN"], // 014
  // 02-02 WF-002 (MOWN, PIAM) and TENANT.ROLE.REVOKE (MOWN, PIAM, PSEC).
  "area.access": ["MOWN", "PIAM", "PSEC"],
  // 03-05 §10.1: health, counts and redacted tenant metadata only.
  "area.platform": ["SUPER_ADMIN"],
  // 02-02 SUPPORT.ACCESS.JIT.REQUEST (PSUP), .APPROVE (PSEC); WF-011 (PSRE, PSEC).
  "area.exceptional": ["PSUP", "PSRE", "PSEC"],
};

function buildCatalog(): Record<Persona, readonly Permission[]> {
  const out = {} as Record<Persona, readonly Permission[]>;
  for (const p of PERSONAS) {
    out[p] = [...DATA_PERMISSIONS[p], ...AREAS.filter((a) => AREA_PERSONAS[a].includes(p))];
  }
  return out;
}

export const PERSONA_PERMISSIONS = buildCatalog();

export function permissionsFor(personas: readonly Persona[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const p of personas) for (const perm of PERSONA_PERMISSIONS[p]) out.add(perm);
  return out;
}
