/**
 * Console screens ZP-BRW-001 … 014 (Business Requirements 01-05 §07).
 *
 * For each screen: the fields its wireframe lists, the statuses it needs, and
 * the actions with the rule the spec states ("requester cannot final-approve",
 * "reason mandatory for refusal", "step-up / dual control", …).
 *
 * DEVELOPMENT FIXTURES: every record is fictional TEST data. Nothing here
 * moves money or calls a provider; decisions only change these mock records
 * and are audited.
 */
import { LEGAL_ENTITIES, MERCHANTS } from "../database/fixtures.js";
import { devUserId } from "../integrations/directory.js";
import type { Merchant } from "../types/domain.js";
import type { Money, ScreenDef, ScreenRecord } from "./types.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const iso = (ms: number) => new Date(ms).toISOString();
const money = (minor: number | bigint | string, currency: string): Money => ({ minor: String(minor), currency });
const people = {
  ops: { sub: devUserId(2), name: "Rowan Hale" },
  finA: { sub: devUserId(3), name: "Jordan Pike" },
  finB: { sub: devUserId(4), name: "Sam Okafor" },
  risk: { sub: devUserId(5), name: "Morgan Reyes" },
  sec: { sub: devUserId(7), name: "Riley Ward" },
  owner: { sub: devUserId(10), name: "Harper Vale" },
  mops: { sub: devUserId(11), name: "Emery Holt" },
  comp: { sub: devUserId(13), name: "Kai Brennan" },
};
const scope = (m: Merchant) => ({ tenantId: m.tenantId, merchantId: m.id, legalEntityId: m.legalEntityId, environment: "TEST" as const });
const count = (rows: ScreenRecord[], ...statuses: string[]) => String(rows.filter((r) => statuses.includes(r.status)).length);
const country = (cell: string) => (cell === "cell_uk_01" ? "United Kingdom" : "European Union");

// ---------------------------------------------------------------- ZP-BRW-002
const merchantApplications: ScreenDef = {
  id: "ZP-BRW-002", title: "Merchant Application & KYB Review", area: "area.merchants", scoped: true,
  generate: ({ now }) => {
    const r = rng(2002);
    const statuses = ["SUBMITTED", "IN_REVIEW", "IN_REVIEW", "INFO_REQUESTED", "APPROVED", "REJECTED"];
    return MERCHANTS.map((m, i) => {
      const status = statuses[i % statuses.length]!;
      const at = now - (i + 1) * 7 * HOUR;
      return {
        id: `app_${m.id.slice(4)}`, status, version: 1, ...scope(m),
        requestedBySub: people.owner.sub, requestedByName: people.owner.name,
        fields: {
          merchant: m.displayName, legalEntity: m.legalEntityId, country: country(m.legalEntityId),
          progress: `${[40, 70, 70, 55, 100, 100][i % 6]}%`,
          requestedMethods: ["card", ...(r() > 0.5 ? ["bank_transfer"] : [])],
          beneficialOwners: `${1 + Math.floor(r() * 3)} owners (redacted)`,
          documents: `${3 + Math.floor(r() * 4)} evidence references`,
          riskFindings: status === "INFO_REQUESTED" ? "Proof of address older than 3 months" : r() > 0.6 ? "PEP screening: no match" : "None",
          missingProof: status === "INFO_REQUESTED" ? "Updated proof of address" : "None",
          capabilityNotice: "No account capability until approved partner + legal cell + merchant terms",
        },
        timeline: [
          { at: iso(at), event: "Application submitted", actor: people.owner.name },
          ...(status !== "SUBMITTED" ? [{ at: iso(at + HOUR), event: "Review started", actor: people.comp.name }] : []),
        ],
        updatedAt: iso(at + HOUR),
      };
    });
  },
  summary: (rows) => [
    { label: "Awaiting review", value: count(rows, "SUBMITTED", "IN_REVIEW") },
    { label: "Information requested", value: count(rows, "INFO_REQUESTED") },
    { label: "Approved", value: count(rows, "APPROVED") },
    { label: "Rejected", value: count(rows, "REJECTED") },
  ],
  actions: {
    approve: { label: "Approve", from: ["SUBMITTED", "IN_REVIEW"], to: "APPROVED", deciders: ["PCOMP", "PRISK"], separation: true, reasonRequired: false, stepUp: false,
      source: "ZP-BRW-002 reviewer pane: approve/request/reject with reason" },
    request_info: { label: "Request information", from: ["SUBMITTED", "IN_REVIEW"], to: "INFO_REQUESTED", deciders: ["PCOMP", "PRISK"], separation: true, reasonRequired: true, stepUp: false,
      source: "ZP-BRW-002 reviewer pane" },
    reject: { label: "Reject", from: ["SUBMITTED", "IN_REVIEW", "INFO_REQUESTED"], to: "REJECTED", deciders: ["PCOMP", "PRISK"], separation: true, reasonRequired: true, stepUp: false,
      source: "ZP-BRW-002: decision reason mandatory for refusal" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-003
const capabilities: ScreenDef = {
  id: "ZP-BRW-003", title: "Merchant Capabilities & Legal Cell Activation", area: "area.merchants", scoped: true,
  generate: ({ now }) => {
    const out: ScreenRecord[] = [];
    const statuses = ["ACTIVE", "PROPOSED", "DISABLED", "BLOCKED", "EXPIRED", "ACTIVE"];
    MERCHANTS.forEach((m, i) => {
      for (const [j, method] of ["card", "bank_transfer"].entries()) {
        const status = method === "bank_transfer" && i % 2 === 0 ? "DISABLED" : statuses[(i + j) % statuses.length]!;
        out.push({
          id: `cap_${m.id.slice(4)}_${method}`, status, version: 1, ...scope(m),
          requestedBySub: people.ops.sub, requestedByName: people.ops.name,
          fields: {
            merchant: m.displayName, entity: m.legalEntityId, market: country(m.legalEntityId), method, currency: m.currencies[0]!, psp: "mockpsp",
            effectiveFrom: iso(now - 30 * DAY).slice(0, 10), effectiveTo: iso(now + (status === "EXPIRED" ? -DAY : 335 * DAY)).slice(0, 10),
            authoritySource: "Partner agreement PA-2026-0" + (i + 1), contractRef: `CT-${m.id.slice(4).toUpperCase()}`, riskOwner: people.risk.name,
            reasonCode: { ACTIVE: "All scoped approvals current", PROPOSED: "Awaiting independent activation", DISABLED: "Default OFF: never requested",
              BLOCKED: "Sanctions screening hold", EXPIRED: "Effective window ended" }[status] ?? "",
            approvals: { Legal: status === "ACTIVE" ? "Signed" : "Pending", Risk: status === "ACTIVE" ? "Signed" : "Pending", Partner: "Signed", Security: "Signed", Finance: status === "ACTIVE" ? "Signed" : "Pending" },
          },
          timeline: [{ at: iso(now - 20 * DAY), event: status === "DISABLED" ? "Created with default OFF" : "Change requested", actor: people.ops.name }],
          updatedAt: iso(now - 2 * DAY),
        });
      }
    });
    return out;
  },
  summary: (rows) => [
    { label: "Active", value: count(rows, "ACTIVE") },
    { label: "Proposed", value: count(rows, "PROPOSED") },
    { label: "Disabled (default OFF)", value: count(rows, "DISABLED") },
    { label: "Blocked / expired", value: String(Number(count(rows, "BLOCKED")) + Number(count(rows, "EXPIRED"))) },
  ],
  actions: {
    activate: { label: "Activate", from: ["PROPOSED"], to: "ACTIVE", deciders: ["PCOMP", "PRISK", "PSEC", "PFIN", "PPSP"], separation: true, reasonRequired: false, stepUp: true,
      source: "ZP-BRW-003: reviewer separation, requester cannot final-approve" },
    block: { label: "Block", from: ["ACTIVE", "PROPOSED"], to: "BLOCKED", deciders: ["PCOMP", "PRISK", "PSEC"], separation: false, reasonRequired: true, stepUp: false,
      source: "ZP-BRW-003: reason codes for BLOCKED" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-006
const routing: ScreenDef = {
  id: "ZP-BRW-006", title: "Routing Policy Studio & Simulation", area: "area.routing", scoped: false,
  generate: ({ now }) => {
    const rows: [string, string, string, typeof people.ops][] = [
      ["rp_uk_cards", "ACTIVE", "cell_uk_01", people.ops], ["rp_uk_cards", "IN_REVIEW", "cell_uk_01", people.ops],
      ["rp_eu_cards", "ACTIVE", "cell_eu_01", people.comp], ["rp_eu_highvalue", "DRAFT", "cell_eu_01", people.ops],
      ["rp_uk_legacy", "RETIRED", "cell_uk_01", people.comp],
    ];
    return rows.map(([pid, status, cell, author], i) => ({
      id: `${pid}_v${status === "IN_REVIEW" ? 2 : 1}`, status, version: 1, legalEntityId: cell, environment: "TEST",
      requestedBySub: author.sub, requestedByName: author.name,
      fields: {
        policy: pid, policyVersion: status === "IN_REVIEW" ? "v2" : "v1", legalCell: cell, changeTicket: `CHG-${4100 + i}`, author: author.name,
        rules: [`method = card`, `amount ≤ ${cell === "cell_uk_01" ? "£5,000.00" : "€5,000.00"}`, `merchant tier ∈ {standard, plus}`, `provider ∈ {mockpsp}`],
        providers: ["mockpsp"], canaryScope: status === "IN_REVIEW" ? "5% of TEST traffic, 7 days" : "—",
        simulation: status === "DRAFT" ? "Not run" : "Deterministic: 1,000 sample intents → mockpsp 100%, 0 unroutable",
        rollbackRef: status === "IN_REVIEW" ? `${pid}_v1` : "—",
      },
      timeline: [{ at: iso(now - (10 - i) * DAY), event: `Policy ${status === "DRAFT" ? "drafted" : "submitted"}`, actor: author.name }],
      updatedAt: iso(now - (9 - i) * DAY),
    }));
  },
  summary: (rows) => [
    { label: "Active", value: count(rows, "ACTIVE") },
    { label: "In review", value: count(rows, "IN_REVIEW") },
    { label: "Drafts", value: count(rows, "DRAFT") },
  ],
  actions: {
    submit: { label: "Submit for review", from: ["DRAFT"], to: "IN_REVIEW", deciders: ["POR", "PCOMP"], separation: false, reasonRequired: false, stepUp: false,
      guard: (r) => (r.fields.simulation === "Not run" ? "Run a simulation before submitting (simulation trace required)." : null),
      source: "ZP-BRW-006: simulation trace deterministic and exportable" },
    simulate: { label: "Run simulation", from: ["DRAFT", "IN_REVIEW"], to: "", deciders: ["POR", "PCOMP"], separation: false, reasonRequired: false, stepUp: false,
      source: "ZP-BRW-006: simulate eligible paths" },
    promote: { label: "Approve promotion", from: ["IN_REVIEW"], to: "ACTIVE", deciders: ["POR", "PCOMP"], separation: true, reasonRequired: false, stepUp: true,
      source: "ZP-BRW-006: activation approvals maker/checker" },
    reject: { label: "Reject", from: ["IN_REVIEW"], to: "DRAFT", deciders: ["POR", "PCOMP"], separation: true, reasonRequired: true, stepUp: false,
      source: "ZP-BRW-006 approval panel" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-007
const connectors: ScreenDef = {
  id: "ZP-BRW-007", title: "Provider Capability & Connector Console", area: "area.partners", scoped: false,
  generate: ({ now }) => {
    const list: [string, string, string, string][] = [
      ["conn_mockpsp_uk", "mockpsp", "cell_uk_01", "CERTIFIED"], ["conn_mockpsp_eu", "mockpsp", "cell_eu_01", "CERTIFIED"],
      ["conn_northbank_uk", "Northbank Acquiring (fixture)", "cell_uk_01", "PENDING"], ["conn_eurolink_eu", "EuroLink Payments (fixture)", "cell_eu_01", "EXPIRED"],
    ];
    return list.map(([id, provider, cell, status], i) => ({
      id, status, version: 1, legalEntityId: cell, environment: "TEST",
      requestedBySub: people.ops.sub, requestedByName: people.ops.name,
      fields: {
        provider, entity: cell, market: country(cell), env: "TEST", health: provider === "mockpsp" ? "live" : "not connected",
        accountFingerprint: `acct_…${(4821 + i * 137).toString(16)}`, webhookKeyRef: `whk_ref_${i + 1} (opaque)`,
        evidenceExpiry: iso(now + (status === "EXPIRED" ? -3 * DAY : 120 * DAY)).slice(0, 10),
        contractExpiry: iso(now + (status === "EXPIRED" ? -3 * DAY : 300 * DAY)).slice(0, 10),
        features: {
          authorize: "SUPPORTED", capture: "SUPPORTED", void: provider === "mockpsp" ? "TESTED" : "SIGNED",
          refund: "SUPPORTED", "3ds": provider === "mockpsp" ? "TESTED" : "DISABLED", recurring: "DISABLED",
        },
        certification: status === "CERTIFIED" ? "Contract tests passed · partner signed · statement format agreed" : status === "PENDING" ? "Contract tests passed · awaiting partner sign-off" : "Evidence expired",
        issues: status === "EXPIRED" ? ["Contract expired: critical scope blocked"] : [],
      },
      timeline: [{ at: iso(now - 40 * DAY), event: "Connector registered", actor: people.ops.name }],
      updatedAt: iso(now - 5 * DAY),
    }));
  },
  summary: (rows) => [
    { label: "Certified", value: count(rows, "CERTIFIED") },
    { label: "Pending certification", value: count(rows, "PENDING") },
    { label: "Expired", value: count(rows, "EXPIRED") },
  ],
  actions: {
    certify: { label: "Certify", from: ["PENDING"], to: "CERTIFIED", deciders: ["POR", "PSEC", "PCOMP"], separation: true, reasonRequired: false, stepUp: true,
      source: "ZP-BRW-007 certification: contract tests + partner signoff" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-008
const refunds: ScreenDef = {
  id: "ZP-BRW-008", title: "Refunds, Voids & Dispute Operations", area: "area.refunds_disputes", scoped: true,
  generate: ({ now, base }) => {
    const ok = base.payments.filter((p) => p.status === "SUCCEEDED").slice(0, 14);
    const auth = base.payments.filter((p) => p.status === "REQUIRES_CAPTURE").slice(0, 3);
    const out: ScreenRecord[] = [];
    ok.forEach((p, i) => {
      const type = i % 5 === 4 ? "DISPUTE" : "REFUND";
      const captured = BigInt(p.amountMinor);
      const refunded = i % 3 === 0 ? captured / 4n : 0n;
      const amount = type === "DISPUTE" ? captured : (captured - refunded) / 2n;
      const status = type === "DISPUTE" ? (i % 2 ? "EVIDENCE_DUE" : "OPEN") : ["REQUESTED", "REQUESTED", "APPROVED", "SUCCEEDED", "REJECTED"][i % 5]!;
      const by = i % 2 ? people.mops : people.owner;
      out.push({
        id: `${type === "DISPUTE" ? "dp" : "re"}_${p.id.slice(3, 23)}`, status, version: 1,
        tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST",
        requestedBySub: by.sub, requestedByName: by.name,
        fields: {
          caseType: type, paymentId: p.id, merchant: MERCHANTS.find((m) => m.id === p.merchantId)?.displayName ?? p.merchantId,
          captured: money(captured, p.currency), refunded: money(refunded, p.currency), availableToRefund: money(captured - refunded, p.currency),
          amount: money(amount, p.currency), reasonCode: type === "DISPUTE" ? "fraudulent (partner code 10.4)" : pick(rng(i + 8), ["requested_by_customer", "duplicate", "product_unavailable"]),
          deadline: iso(now + (3 + i) * DAY).slice(0, 10), pspStatus: status === "SUCCEEDED" ? "Provider confirmed" : "Not submitted",
          ledgerNote: "Ledger adjustments posted by BC-05 (not connected)",
        },
        timeline: [{ at: iso(Date.parse(p.updatedAt) + HOUR), event: `${type === "DISPUTE" ? "Dispute opened by partner" : "Refund requested"}`, actor: type === "DISPUTE" ? "mockpsp" : by.name }],
        updatedAt: iso(Date.parse(p.updatedAt) + HOUR),
      });
    });
    auth.forEach((p, i) => out.push({
      id: `vd_${p.id.slice(3, 23)}`, status: "REQUESTED", version: 1,
      tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST",
      requestedBySub: people.mops.sub, requestedByName: people.mops.name,
      fields: {
        caseType: "VOID", paymentId: p.id, merchant: MERCHANTS.find((m) => m.id === p.merchantId)?.displayName ?? p.merchantId,
        captured: money(0, p.currency), refunded: money(0, p.currency), availableToRefund: money(0, p.currency), amount: money(p.amountMinor, p.currency),
        reasonCode: "requested_by_customer", deadline: iso(now + (2 + i) * DAY).slice(0, 10), pspStatus: "Authorization held", ledgerNote: "No capture, no ledger effect",
      },
      timeline: [{ at: iso(Date.parse(p.updatedAt) + HOUR), event: "Pre-capture void requested", actor: people.mops.name }],
      updatedAt: iso(Date.parse(p.updatedAt) + HOUR),
    }));
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  summary: (rows) => [
    { label: "Awaiting approval", value: count(rows, "REQUESTED") },
    { label: "Disputes open", value: count(rows, "OPEN", "EVIDENCE_DUE") },
    { label: "Succeeded", value: count(rows, "SUCCEEDED") },
  ],
  actions: {
    approve: { label: "Approve", from: ["REQUESTED"], to: "APPROVED", deciders: ["POR"], separation: true, reasonRequired: false, stepUp: true,
      guard: (r) => {
        const amt = r.fields.amount as Money;
        const avail = r.fields.availableToRefund as Money;
        return r.fields.caseType === "REFUND" && BigInt(amt.minor) > BigInt(avail.minor) ? "Refund amount exceeds the evidenced remaining refundable amount." : null;
      },
      source: "ZP-BRW-008: step-up / dual control; amount ≤ remaining refundable" },
    reject: { label: "Reject", from: ["REQUESTED"], to: "REJECTED", deciders: ["POR"], separation: true, reasonRequired: true, stepUp: false, source: "ZP-BRW-008 review panel" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-009
const settlement: ScreenDef = {
  id: "ZP-BRW-009", title: "Settlement & Four-Way Reconciliation", area: "area.finance", scoped: true,
  generate: ({ now }) => {
    const out: ScreenRecord[] = [];
    MERCHANTS.forEach((m, i) => {
      for (let d = 1; d <= 3; d++) {
        const r = rng(9000 + i * 10 + d);
        const gross = BigInt(Math.round(400_000 + r() * 2_400_000));
        const ded = gross / 40n;
        const net = gross - ded;
        const residual = d === 1 && i % 3 === 0 ? BigInt(Math.round(r() * 5_000)) : 0n;
        const status = d === 1 ? (residual ? "EXCEPTIONS" : "READY_TO_CLOSE") : "CLOSED";
        const cur = m.currencies[0]!;
        out.push({
          id: `rec_${m.id.slice(4)}_${d}`, status, version: 1, ...scope(m),
          requestedBySub: people.finA.sub, requestedByName: people.finA.name,
          fields: {
            entity: m.legalEntityId, merchant: m.displayName, account: `stl_acct_…${(i + 11) * 7}`, settlementCurrency: cur,
            statementDate: iso(now - d * DAY).slice(0, 10), importedAt: iso(now - d * DAY + 6 * HOUR),
            gross: money(gross, cur), deductions: money(ded, cur), expectedNet: money(net, cur), bankReceived: money(net - residual, cur), residual: money(residual, cur),
            exceptions: residual ? [`TIMING: bank credit pending (${residual} minor units) · owner ${people.finA.name} · age 1 d`] : [],
            closeThreshold: `0 ${cur}`, nextRun: iso(now + 6 * HOUR),
          },
          timeline: [{ at: iso(now - d * DAY + 6 * HOUR), event: "Statement imported and matched", actor: people.finA.name }],
          updatedAt: iso(now - d * DAY + 6 * HOUR),
        });
      }
    });
    return out;
  },
  summary: (rows) => [
    { label: "Ready to close", value: count(rows, "READY_TO_CLOSE") },
    { label: "With exceptions", value: count(rows, "EXCEPTIONS") },
    { label: "Closed", value: count(rows, "CLOSED") },
  ],
  actions: {
    close: { label: "Approve period close", from: ["READY_TO_CLOSE"], to: "CLOSED", deciders: ["PFIN"], separation: true, reasonRequired: false, stepUp: true,
      guard: (r) => ((r.fields.residual as Money).minor !== "0" ? "Residual is above the close threshold." : null),
      source: "ZP-BRW-009: close authority independent Finance, never document author alone" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-010
const payouts: ScreenDef = {
  id: "ZP-BRW-010", title: "Payout Eligibility & Approval Queue", area: "area.payouts", scoped: true,
  generate: ({ base }) => base.payouts.map((p, i) => {
    const amount = BigInt(p.amountMinor);
    return {
      id: p.id, status: p.status, version: 1, tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST",
      requestedBySub: p.makerSub, requestedByName: p.makerName,
      fields: {
        merchant: MERCHANTS.find((m) => m.id === p.merchantId)?.displayName ?? p.merchantId, region: country(p.legalEntityId), partner: "mockpsp",
        amount: money(amount, p.currency), beneficiary: p.beneficiaryLabel, approvalStatus: p.approvalStatus,
        bankConfirmedAvailable: money(amount * 3n, p.currency), reserve: money(amount / 10n, p.currency), hold: money(i === 3 ? amount : 0n, p.currency),
        approvalDeadline: p.approvalDeadline,
        gates: Object.fromEntries(p.gates.map((g) => [g.name, g.state])),
        finality: { "Partner accepted": p.status === "PROVIDER_ACCEPTED" || p.status === "SUCCEEDED" ? "Yes" : "No", "Bank confirmed": p.status === "SUCCEEDED" ? "Yes" : "No" },
        notice: "Payout status is not proof of recipient bank-credit or final settlement.",
      },
      timeline: [{ at: p.createdAt, event: "Payout prepared", actor: p.makerName }, ...(p.decidedAt ? [{ at: p.decidedAt, event: `Approval ${p.approvalStatus.toLowerCase()}`, actor: p.checkerName ?? "" }] : [])],
      updatedAt: p.updatedAt,
    };
  }),
  summary: (rows) => [
    { label: "Awaiting approval", value: count(rows, "REQUIRES_APPROVAL") },
    { label: "Ready (not dispatched)", value: count(rows, "READY") },
    { label: "Outcome unknown", value: count(rows, "OUTCOME_UNKNOWN") },
  ],
  actions: {
    approve: { label: "Approve", from: ["REQUIRES_APPROVAL"], to: "READY", deciders: ["PFIN"], separation: true, reasonRequired: false, stepUp: true,
      guard: (r) => {
        if (Date.parse(String(r.fields.approvalDeadline)) <= Date.now()) return "The approval deadline has passed.";
        const gates = r.fields.gates as Record<string, string>;
        const held = (r.fields.hold as Money).minor !== "0";
        return held ? "Funds are on hold for this payout." : gates.funds === "PENDING" ? "The funds gate has not passed." : null;
      },
      source: "ZP-BRW-010 / 04-05 §8: distinct maker and checker, step-up",
      effect: (f) => ({ ...f, approvalStatus: "APPROVED", gates: { ...(f.gates as Record<string, string>), maker_checker: "PASSED" } }) },
    reject: { label: "Reject", from: ["REQUIRES_APPROVAL"], to: "CANCELED", deciders: ["PFIN"], separation: true, reasonRequired: true, stepUp: false,
      source: "04-05 §7: canceled before dispatch",
      effect: (f) => ({ ...f, approvalStatus: "REJECTED" }) },
  },
};

// ---------------------------------------------------------------- ZP-BRW-011
const investigations: ScreenDef = {
  id: "ZP-BRW-011", title: "Unknown Outcome & Break Investigation Center", area: "area.finance", scoped: true,
  generate: ({ now, base }) => {
    const reasons = ["AUTH_UNKNOWN", "REFUND_UNKNOWN", "WEBHOOK_CONFLICT", "CASH_BREAK", "PAYOUT_UNKNOWN"];
    return base.payments.filter((p) => p.status === "PROCESSING").slice(0, 10).map((p, i) => {
      const status = ["OPEN", "INQUIRY_SENT", "OPEN", "RESOLVED"][i % 4]!;
      return {
        id: `case_${p.id.slice(3, 23)}`, status, version: 1, tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST",
        requestedBySub: people.ops.sub, requestedByName: people.ops.name,
        fields: {
          reason: reasons[i % reasons.length]!, priority: i < 3 ? "P0" : "P1", paymentId: p.id, provider: p.connector,
          merchant: MERCHANTS.find((m) => m.id === p.merchantId)?.displayName ?? p.merchantId, amount: money(p.amountMinor, p.currency),
          age: `${Math.max(1, Math.round((now - Date.parse(p.createdAt)) / HOUR))} h`,
          blockedNextAction: "Capture, refund and retry blocked until resolved",
          inquiryCadence: "Every 15 min, max 8, then escalate", disposition: status === "RESOLVED" ? "Reconciled against provider statement" : "—",
        },
        timeline: [
          { at: p.createdAt, event: "Provider call timed out; outcome unknown", actor: p.connector },
          ...(status !== "OPEN" ? [{ at: iso(Date.parse(p.createdAt) + 30 * 60_000), event: "Status inquiry sent", actor: people.ops.name }] : []),
        ],
        updatedAt: p.updatedAt,
      };
    });
  },
  summary: (rows) => [
    { label: "P0 open", value: String(rows.filter((r) => r.fields.priority === "P0" && r.status !== "RESOLVED").length) },
    { label: "Inquiry sent", value: count(rows, "INQUIRY_SENT") },
    { label: "Resolved", value: count(rows, "RESOLVED") },
  ],
  actions: {
    inquire: { label: "Send provider inquiry", from: ["OPEN"], to: "INQUIRY_SENT", deciders: ["POR", "PFIN", "PRISK"], separation: false, reasonRequired: false, stepUp: false,
      source: "ZP-BRW-011: bounded inquiry cadence" },
    resolve: { label: "Resolve with evidence", from: ["OPEN", "INQUIRY_SENT"], to: "RESOLVED", deciders: ["POR", "PFIN", "PRISK"], separation: true, reasonRequired: true, stepUp: false,
      source: "ZP-BRW-011: disposition proof + verified reviewer; never manufacture success" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-012
const regulatory: ScreenDef = {
  id: "ZP-BRW-012", title: "Compliance & Market Enablement Workbench", area: "area.risk_compliance", scoped: false,
  generate: ({ now }) => {
    const cells: [string, string, string, string, string][] = [
      ["rc_uk_card_gbp", "cell_uk_01", "card", "GBP", "ENABLED"], ["rc_uk_bank_gbp", "cell_uk_01", "bank_transfer", "GBP", "PENDING_CHANGE"],
      ["rc_eu_card_eur", "cell_eu_01", "card", "EUR", "ENABLED"], ["rc_eu_card_usd", "cell_eu_01", "card", "USD", "SUSPENDED"],
    ];
    return cells.map(([id, cell, method, cur, status], i) => ({
      id, status, version: 1, legalEntityId: cell, environment: "TEST",
      requestedBySub: people.comp.sub, requestedByName: people.comp.name,
      fields: {
        legalEntity: LEGAL_ENTITIES.find((l) => l.id === cell)?.name ?? cell, country: country(cell), method, psp: "mockpsp", segment: "standard", currency: cur,
        authoritySource: `Regulated partner licence ${cell === "cell_uk_01" ? "FRN-fixture-001" : "EU-EMI-fixture-002"} · effective 2026-01-01`,
        dataResidency: cell === "cell_uk_01" ? "UK; retention class R7" : "EU; retention class R7",
        contractRight: `Features: authorize, capture, refund (${method})`,
        evidence: { License: "Current", Agreement: status === "SUSPENDED" ? "Expired" : "Current", "KYB/AML": "Current", "Privacy/residency": "Current" },
        gaps: status === "SUSPENDED" ? ["Partner agreement expired · owner Legal · due " + iso(now + 7 * DAY).slice(0, 10)] : status === "PENDING_CHANGE" ? ["Awaiting Finance approval"] : [],
        approvals: { Legal: "Signed", Risk: "Signed", Finance: status === "PENDING_CHANGE" ? "Pending" : "Signed", Security: "Signed" },
      },
      timeline: [{ at: iso(now - (15 + i) * DAY), event: "Cell reviewed", actor: people.comp.name }],
      updatedAt: iso(now - (3 + i) * DAY),
    }));
  },
  summary: (rows) => [
    { label: "Enabled cells", value: count(rows, "ENABLED") },
    { label: "Pending change", value: count(rows, "PENDING_CHANGE") },
    { label: "Suspended", value: count(rows, "SUSPENDED") },
  ],
  actions: {
    approve_change: { label: "Approve change", from: ["PENDING_CHANGE"], to: "ENABLED", deciders: ["PCOMP", "PRISK", "PFIN", "PSEC"], separation: true, reasonRequired: false, stepUp: true,
      source: "ZP-BRW-012: Legal + Risk + Finance + Security approvals" },
    suspend: { label: "Suspend cell", from: ["ENABLED", "PENDING_CHANGE"], to: "SUSPENDED", deciders: ["PCOMP", "PRISK"], separation: false, reasonRequired: true, stepUp: true,
      source: "ZP-BRW-012 action footer: suspend cell" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-013
const developerHub: ScreenDef = {
  id: "ZP-BRW-013", title: "Merchant Developer Hub & Reporting", area: "area.developers", scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => [
    {
      id: `key_${m.id.slice(4)}`, status: i % 4 === 3 ? "EXPIRED" : "ACTIVE", version: 1, ...scope(m),
      fields: { kind: "API key", merchant: m.displayName, name: "Server key", value: `sk_test_••••${(7311 + i * 91).toString().slice(-4)}`,
        scopes: ["payment_intents:write", "payments:read"], expires: iso(now + (i % 4 === 3 ? -DAY : 90 * DAY)).slice(0, 10), apiVersion: "2026-11-01" },
      timeline: [{ at: iso(now - 30 * DAY), event: "Key created (shown once)", actor: people.mops.name }], updatedAt: iso(now - 30 * DAY),
    },
    {
      id: `whe_${m.id.slice(4)}`, status: i % 3 === 2 ? "FAILING" : "ACTIVE", version: 1, ...scope(m),
      fields: { kind: "Webhook endpoint", merchant: m.displayName, name: "Payments events", value: `https://hooks.${m.id.slice(4).replace(/_/g, "-")}.example/zoiko`,
        scopes: ["payment.captured", "payment.failed", "refund.succeeded"], expires: "—", apiVersion: "2026-11-01" },
      timeline: [{ at: iso(now - 20 * DAY), event: "Endpoint verified (HTTPS, host ownership)", actor: people.mops.name }], updatedAt: iso(now - 2 * HOUR),
    },
    {
      id: `rpt_${m.id.slice(4)}`, status: "AVAILABLE", version: 1, ...scope(m),
      fields: { kind: "Report", merchant: m.displayName, name: "Payments report, last 30 days", value: `As of ${iso(now - 6 * HOUR)}; lineage: fixture dataset`,
        scopes: ["transactions", "refunds", "fees", "settlement status"], expires: "—", apiVersion: "—" },
      timeline: [{ at: iso(now - 6 * HOUR), event: "Report generated", actor: "reporting job" }], updatedAt: iso(now - 6 * HOUR),
    },
  ]),
  summary: (rows) => [
    { label: "Active keys", value: String(rows.filter((r) => r.fields.kind === "API key" && r.status === "ACTIVE").length) },
    { label: "Webhooks failing", value: String(rows.filter((r) => r.fields.kind === "Webhook endpoint" && r.status === "FAILING").length) },
    { label: "Reports", value: String(rows.filter((r) => r.fields.kind === "Report").length) },
  ],
  actions: {},
};

// ---------------------------------------------------------------- ZP-BRW-014
const GATES = ["G0 Authority and funds flow", "G1 Scope and architecture", "G2 Provider and security scope", "G3 Financial correctness",
  "G4 Integration and reconciliation", "G5 Security, resilience and operations", "G6 Merchant pilot launch", "G7 Expansion"];
const releases: ScreenDef = {
  id: "ZP-BRW-014", title: "Acceptance & Release Gate Control Room", area: "area.qa_release", scoped: false,
  generate: ({ now }) => [
    ["rel_2026_11_a", "0.1.0-rc1", "PENDING_DECISION", 8], ["rel_2026_11_b", "0.1.0-rc2", "PENDING_DECISION", 3], ["rel_2026_10_a", "0.0.9", "NO_GO", 2],
  ].map(([id, version, status, passed], i) => ({
    id: String(id), status: String(status), version: 1, legalEntityId: "cell_uk_01", environment: "TEST",
    requestedBySub: people.ops.sub, requestedByName: people.ops.name,
    fields: {
      candidate: String(version), legalCell: "cell_uk_01", cohort: "Pilot cohort A (fixture)", psp: "mockpsp", env: "TEST",
      changeWindow: iso(now + (i + 1) * 2 * DAY).slice(0, 10),
      gates: Object.fromEntries(GATES.map((g, gi) => [g, gi < Number(passed) ? "PASSED" : gi === Number(passed) ? "BLOCKED" : "PENDING"])),
      blockers: Number(passed) >= 8 ? [] : [`P0 open: ${GATES[Number(passed)]} evidence missing`],
      evidencePointer: `s3://zp-evidence/${id}/manifest.json · sha256:${(0xabc123 + i).toString(16)}…`,
      rollbackPlan: "Redeploy previous release; feature flags off",
    },
    timeline: [{ at: iso(now - (i + 2) * DAY), event: "Release candidate frozen", actor: people.ops.name }],
    updatedAt: iso(now - (i + 1) * DAY),
  })),
  summary: (rows) => [
    { label: "Awaiting decision", value: count(rows, "PENDING_DECISION") },
    { label: "Go", value: count(rows, "GO") },
    { label: "No-Go", value: count(rows, "NO_GO") },
  ],
  actions: {
    go: { label: "Sign GO", from: ["PENDING_DECISION"], to: "GO", deciders: ["PCOMP", "PFIN"], separation: true, reasonRequired: false, stepUp: true,
      guard: (r) => (Object.values(r.fields.gates as Record<string, string>).every((g) => g === "PASSED") ? null : "Every gate G0–G7 must pass; waivers are forbidden for P0 stop-ship."),
      source: "ZP-BRW-014: independent signatures; no waiver for P0" },
    no_go: { label: "Sign NO-GO", from: ["PENDING_DECISION"], to: "NO_GO", deciders: ["PCOMP", "PFIN"], separation: true, reasonRequired: true, stepUp: false,
      source: "ZP-BRW-014 decision footer" },
  },
};

// ---------------------------------------------------------------- ZP-BRW-001
const requirements: ScreenDef = {
  id: "ZP-BRW-001", title: "Business Requirement & Use-Case Control Center", area: "area.qa_release", scoped: false,
  generate: ({ now }) => {
    const domains = ["Payments", "Merchants", "Finance", "Security", "Compliance"];
    const tiers = ["P0", "P0", "P1", "P2"];
    return Array.from({ length: 16 }, (_, i) => {
      const status = ["IMPLEMENTED", "IN_PROGRESS", "DESIGNED", "IN_PROGRESS", "BLOCKED"][i % 5]!;
      return {
        id: `BR-${String(i + 1).padStart(3, "0")}`, status, version: 1, environment: "TEST" as const,
        requestedBySub: people.comp.sub, requestedByName: people.comp.name,
        fields: {
          domain: domains[i % domains.length]!, tier: tiers[i % tiers.length]!, gate: `G${i % 8}`, owner: pick(rng(i), [people.ops.name, people.finA.name, people.comp.name]),
          useCases: [`UC-${String(i * 2 + 1).padStart(3, "0")}`, `UC-${String(i * 2 + 2).padStart(3, "0")}`],
          implementationEvidence: status === "IMPLEMENTED" ? `commit sha … · TEST · verified by CI` : "None yet (design evidence only)",
          approval: status === "IMPLEMENTED" ? "Signed" : "Pending",
        },
        timeline: [{ at: iso(now - (20 - i) * DAY), event: "Requirement registered", actor: people.comp.name }],
        updatedAt: iso(now - (10 - (i % 10)) * DAY),
      };
    });
  },
  summary: (rows) => [
    { label: "Requirements", value: String(rows.length) },
    { label: "Implemented", value: count(rows, "IMPLEMENTED") },
    { label: "Blocked", value: count(rows, "BLOCKED") },
  ],
  actions: {},
};

// ------------------------------------------------- ZP-COM-001 … 006 (Stripe parity)
// Customers, products, payment links, subscriptions, invoices and tax rates:
// the Stripe dashboard areas that the §07 rail does not cover. Read-only
// fixtures until a billing service owns them (OPEN_QUESTIONS: Zoiko Pay vs
// Zoiko Billing ownership). Emails are masked, as for payments.
const CATALOG: Record<string, [string, number][]> = {
  ten_northwind: [["Trail Jacket", 12_900], ["Summit Pack", 8_450], ["Outfitters Club (monthly)", 1_500]],
  ten_alder: [["Reader Plus (monthly)", 999], ["Gift Card", 2_500], ["Travel Insurance Add-on", 4_200]],
  ten_kestrel: [["Studio Pro (monthly)", 2_900], ["Studio Team (yearly)", 29_000], ["Brand Workshop", 45_000]],
};
const FIRST = ["Ava", "Liam", "Mia", "Noah", "Zara", "Omar", "Ella", "Theo", "Isla", "Ravi"];
const LAST = ["Clarke", "Moreau", "Novak", "Okoye", "Silva", "Brandt", "Kaur", "Rossi"];
const products = (m: Merchant) => (CATALOG[m.tenantId] ?? []).map(([name, minor], j) => ({ name, minor, j, recurring: /monthly|yearly/.test(name) }));
const customersOf = (m: Merchant, i: number) => Array.from({ length: 4 }, (_, k) => {
  const r = rng(11_000 + i * 10 + k);
  const first = pick(r, FIRST), last = pick(r, LAST);
  return { id: `cus_${m.id.slice(4)}_${k + 1}`, name: `${first} ${last}`, email: `${first[0]!.toLowerCase()}••••@example.com`, k };
});

const customers: ScreenDef = {
  id: "ZP-COM-001", title: "Customers", area: "area.payment_operations", scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => customersOf(m, i).map((c) => {
    const r = rng(12_000 + i * 10 + c.k);
    const payments = 1 + Math.floor(r() * 12);
    const status = (i + c.k) % 7 === 3 ? "DELINQUENT" : "ACTIVE";
    const created = now - (5 + c.k * 9 + i) * DAY;
    return {
      id: c.id, status, version: 1, ...scope(m),
      fields: { name: c.name, email: c.email, merchant: m.displayName, country: country(m.legalEntityId), currency: m.currencies[0]!,
        payments, totalSpent: money(payments * Math.round(1_000 + r() * 9_000), m.currencies[0]!), created: iso(created).slice(0, 10),
        note: status === "DELINQUENT" ? "Has an overdue invoice" : "—" },
      timeline: [{ at: iso(created), event: "Customer created", actor: "checkout" }],
      updatedAt: iso(created + 2 * DAY),
    };
  })),
  summary: (rows) => [
    { label: "Customers", value: String(rows.length) },
    { label: "Active", value: count(rows, "ACTIVE") },
    { label: "Delinquent", value: count(rows, "DELINQUENT") },
  ],
  actions: {},
};

const catalogue: ScreenDef = {
  id: "ZP-COM-002", title: "Product Catalogue", area: "area.payment_operations", scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => products(m).map((p) => {
    const cur = m.currencies[0]!;
    const created = now - (40 - i * 3 - p.j) * DAY;
    return {
      id: `prod_${m.id.slice(4)}_${p.j + 1}`, status: (i + p.j) % 5 === 4 ? "ARCHIVED" : "ACTIVE", version: 1, ...scope(m),
      fields: { name: p.name, merchant: m.displayName, price: money(p.minor, cur), pricing: p.recurring ? "2 prices (monthly, yearly)" : "1 price (one-off)",
        billing: p.recurring ? (p.name.includes("yearly") ? "Recurring · yearly" : "Recurring · monthly") : "One-off",
        taxCode: p.recurring ? "txcd_10103001 (SaaS)" : "txcd_99999999 (General goods)", created: iso(created).slice(0, 10) },
      timeline: [{ at: iso(created), event: "Product created", actor: people.owner.name }],
      updatedAt: iso(created + DAY),
    };
  })),
  summary: (rows) => [
    { label: "Products", value: String(rows.length) },
    { label: "Active", value: count(rows, "ACTIVE") },
    { label: "Archived", value: count(rows, "ARCHIVED") },
  ],
  actions: {},
};

const paymentLinks: ScreenDef = {
  id: "ZP-COM-003", title: "Payment Links", area: "area.payment_operations", scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => products(m).filter((p) => !p.recurring || p.j === 2).map((p) => {
    const r = rng(13_000 + i * 10 + p.j);
    const cur = m.currencies[0]!;
    const paid = Math.floor(r() * 25);
    const created = now - (20 - p.j * 4) * DAY;
    return {
      id: `plink_${m.id.slice(4)}_${p.j + 1}`, status: (i + p.j) % 4 === 3 ? "DEACTIVATED" : "ACTIVE", version: 1, ...scope(m),
      fields: { url: `https://pay.zoiko.test/l/${m.id.slice(4, 10)}${p.j + 1}${(1000 + i * 37).toString(36)}`, product: p.name, merchant: m.displayName,
        price: money(p.minor, cur), payments: paid, collected: money(paid * p.minor, cur), created: iso(created).slice(0, 10) },
      timeline: [{ at: iso(created), event: "Payment link created", actor: people.mops.name }],
      updatedAt: iso(created + 3 * HOUR),
    };
  })),
  summary: (rows) => [
    { label: "Links", value: String(rows.length) },
    { label: "Active", value: count(rows, "ACTIVE") },
    { label: "Deactivated", value: count(rows, "DEACTIVATED") },
  ],
  actions: {},
};

const subscriptions: ScreenDef = {
  id: "ZP-COM-004", title: "Subscriptions", area: "area.payment_operations", scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => {
    const plans = products(m).filter((p) => p.recurring);
    return customersOf(m, i).slice(0, 3).map((c) => {
      const plan = plans[c.k % plans.length]!;
      const yearly = plan.name.includes("yearly");
      const status = ["ACTIVE", "ACTIVE", "TRIALING", "PAST_DUE", "CANCELED"][(i + c.k) % 5]!;
      const started = now - (10 + c.k * 20 + i * 3) * DAY;
      return {
        id: `sub_${m.id.slice(4)}_${c.k + 1}`, status, version: 1, ...scope(m),
        fields: { customer: c.name, product: plan.name, merchant: m.displayName, amount: money(plan.minor, m.currencies[0]!), interval: yearly ? "Yearly" : "Monthly",
          started: iso(started).slice(0, 10), currentPeriodEnd: status === "CANCELED" ? "—" : iso(now + ((c.k + i) % 27 + 1) * DAY).slice(0, 10),
          collection: "Charge automatically", note: status === "PAST_DUE" ? "Latest invoice failed; retry scheduled" : status === "TRIALING" ? "Trial ends in 7 days" : "—" },
        timeline: [{ at: iso(started), event: status === "TRIALING" ? "Trial started" : "Subscription started", actor: "checkout" }],
        updatedAt: iso(started + DAY),
      };
    });
  }),
  summary: (rows) => [
    { label: "Active", value: count(rows, "ACTIVE") },
    { label: "Trialing", value: count(rows, "TRIALING") },
    { label: "Past due", value: count(rows, "PAST_DUE") },
    { label: "Canceled", value: count(rows, "CANCELED") },
  ],
  actions: {},
};

const invoices: ScreenDef = {
  id: "ZP-COM-005", title: "Invoices", area: "area.payment_operations", scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => customersOf(m, i).map((c) => {
    const r = rng(15_000 + i * 10 + c.k);
    const cur = m.currencies[0]!;
    const due = BigInt(Math.round(2_000 + r() * 40_000));
    const status = ["PAID", "OPEN", "PAID", "DRAFT", "VOID", "UNCOLLECTIBLE", "OPEN"][(i * 4 + c.k) % 7]!;
    const issued = now - (3 + c.k * 6 + i) * DAY;
    return {
      id: `in_${m.id.slice(4)}_${c.k + 1}`, status, version: 1, ...scope(m),
      fields: { number: `${m.id.slice(4, 8).toUpperCase()}-${String(1001 + i * 10 + c.k)}`, customer: c.name, email: c.email, merchant: m.displayName,
        amountDue: money(due, cur), amountPaid: money(status === "PAID" ? due : 0n, cur), issued: status === "DRAFT" ? "—" : iso(issued).slice(0, 10),
        dueDate: iso(issued + 14 * DAY).slice(0, 10), source: c.k % 2 ? "Subscription" : "One-off invoice" },
      timeline: [{ at: iso(issued), event: status === "DRAFT" ? "Draft created" : "Invoice finalised and sent", actor: people.owner.name }],
      updatedAt: iso(issued + (status === "PAID" ? 2 * DAY : HOUR)),
    };
  })),
  summary: (rows) => [
    { label: "Open", value: count(rows, "OPEN") },
    { label: "Paid", value: count(rows, "PAID") },
    { label: "Draft", value: count(rows, "DRAFT") },
    { label: "Void / uncollectible", value: count(rows, "VOID", "UNCOLLECTIBLE") },
  ],
  actions: {},
};

const taxRates: ScreenDef = {
  id: "ZP-COM-006", title: "Tax Rates", area: "area.payment_operations", scoped: false,
  generate: ({ now }) => [
    ["txr_uk_vat_std", "cell_uk_01", "United Kingdom", "VAT", "20%", "ACTIVE"], ["txr_uk_vat_red", "cell_uk_01", "United Kingdom", "VAT (reduced)", "5%", "ACTIVE"],
    ["txr_de_vat", "cell_eu_01", "Germany", "MwSt", "19%", "ACTIVE"], ["txr_fr_vat", "cell_eu_01", "France", "TVA", "20%", "ACTIVE"],
    ["txr_ie_vat", "cell_eu_01", "Ireland", "VAT", "23%", "ACTIVE"], ["txr_nl_vat_old", "cell_eu_01", "Netherlands", "BTW", "21%", "ARCHIVED"],
  ].map(([id, cell, jurisdiction, name, rate, status], i) => ({
    id: id!, status: status!, version: 1, legalEntityId: cell, environment: "TEST" as const,
    fields: { name: name!, jurisdiction: jurisdiction!, rate: rate!, inclusive: i % 2 === 0 ? "Inclusive" : "Exclusive", legalEntity: cell!,
      appliesTo: "Products and invoices of merchants in this legal cell", source: "Fixture rate table (not tax advice)" },
    timeline: [{ at: iso(now - (60 - i) * DAY), event: "Tax rate created", actor: people.finA.name }],
    updatedAt: iso(now - (60 - i) * DAY),
  })),
  summary: (rows) => [
    { label: "Active rates", value: count(rows, "ACTIVE") },
    { label: "Archived", value: count(rows, "ARCHIVED") },
  ],
  actions: {},
};

export const SCREEN_DEFS: ScreenDef[] = [
  requirements, merchantApplications, capabilities, routing, connectors, refunds, settlement, payouts, investigations, regulatory, developerHub, releases,
  customers, catalogue, paymentLinks, subscriptions, invoices, taxRates,
];
