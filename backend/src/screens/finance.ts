/**
 * Stripe-parity finance screens (ZP-STR-0nn): money movement, treasury and
 * reporting tools, for the TEST environment.
 *
 * DEVELOPMENT FIXTURES ONLY. Nothing here is a ledger, a balance of record, a
 * bank instruction or a provider call. The operational ledger (BC-05, spec
 * 09-02) is gated on G0 legal ownership and G1 Finance policy (09-02 §20), so
 * these screens act on in-memory TEST records only, like every other console
 * screen (ADR 0003). Money requests follow maker-checker: the person who raised
 * a request cannot approve it, and approval needs a fresh password.
 */
import { MERCHANTS } from "../database/fixtures.js";
import type { Persona } from "../authorization/permissions.js";
import type { Merchant } from "../types/domain.js";
import { DAY, HOUR, count, iso, money, people, pick, rng, scope } from "./fixtureKit.js";
import type { ActionRule, CreateRule, ScreenDef, ScreenRecord } from "./types.js";

const AREA = "area.finance" as const;
/** Who may raise a money request (02-02: merchant finance, finance controller, reconciliation). */
const MAKERS: Persona[] = ["MFIN", "PFIN", "PRECON"];
/** Who may approve one (never the requester). */
const CHECKERS: Persona[] = ["PFIN", "MFIN"];
const NOTICE = "TEST fixture: approving changes this record only. No bank, provider or ledger is called and no money moves.";

/** xs[i] wrapped around, typed without a non-null assertion. */
const nth = <T>(xs: readonly T[], i: number): T => xs[i % xs.length] as T;
const cur = (m: Merchant) => m.currencies[0] ?? "GBP";
const short = (m: Merchant) => m.id.slice(4);
const rec = (m: Merchant, id: string, status: string, fields: ScreenRecord["fields"], at: number, event: string, actor = people.finA.name,
  requester?: { sub: string; name: string }): ScreenRecord => ({
  id, status, version: 1, ...scope(m),
  ...(requester ? { requestedBySub: requester.sub, requestedByName: requester.name } : {}),
  fields: { merchant: m.displayName, ...fields },
  timeline: [{ at: iso(at), event, actor }],
  updatedAt: iso(at),
});

/** Approve / reject / cancel for a money request (maker-checker, password re-entry). */
function approval(to: string, what: string): Record<string, ActionRule> {
  return {
    approve: { label: "Approve", from: ["REQUIRES_APPROVAL"], to, deciders: CHECKERS, separation: true, reasonRequired: false, stepUp: true,
      source: `${what}: requester cannot approve; password re-entry. ${NOTICE}`, effect: (f) => ({ ...f, notice: NOTICE }) },
    reject: { label: "Reject", from: ["REQUIRES_APPROVAL"], to: "REJECTED", deciders: CHECKERS, separation: true, reasonRequired: true, stepUp: false,
      source: `${what}: reason mandatory for refusal` },
    cancel: { label: "Cancel request", from: ["REQUIRES_APPROVAL"], to: "CANCELED", deciders: MAKERS, separation: false, reasonRequired: true, stepUp: false, quiet: true,
      source: `${what}: the requester may withdraw it before approval` },
  };
}
const toggle = (name: string, label: string, from: string, to: string, deciders: Persona[] = CHECKERS): Record<string, ActionRule> => ({
  [name]: { label, from: [from], to, deciders, separation: false, reasonRequired: false, stepUp: false, quiet: true, source: "TEST fixture setting" },
});
/** A create rule whose record waits for a second person. */
const request = (label: string, prefix: string, fields: CreateRule["fields"], build: (v: Record<string, string>, m: Merchant) => ScreenRecord["fields"],
  status = "REQUIRES_APPROVAL"): CreateRule => ({
  label, deciders: MAKERS, source: `${label}: raised for approval by a second person. ${NOTICE}`, fields,
  build: ({ values, merchant, seq }) => ({ id: `${prefix}_${short(merchant)}_n${seq}`, status, fields: { merchant: merchant.displayName, ...build(values, merchant) },
    event: status === "REQUIRES_APPROVAL" ? `${label} requested` : `${label}`, requested: status === "REQUIRES_APPROVAL" }),
});

// ---------------------------------------------------------- Money movement
const topups: ScreenDef = {
  id: "ZP-STR-010", title: "Top-ups (Add Funds)", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => [
    rec(m, `tu_${short(m)}_1`, "SUCCEEDED", { amount: money(250_000 + i * 50_000, cur(m)), source: "Bank transfer (TEST)", description: "Refund reserve" }, now - (12 + i) * DAY, "Top-up completed", people.finB.name, people.finA),
    rec(m, `tu_${short(m)}_2`, i % 2 ? "REQUIRES_APPROVAL" : "REJECTED", { amount: money(80_000 + i * 15_000, cur(m)), source: "Linked account (TEST)", description: "Dispute buffer" }, now - (i + 1) * HOUR * 5, "Top-up requested", people.finA.name, people.finA),
  ]),
  summary: (rows) => [{ label: "Awaiting approval", value: count(rows, "REQUIRES_APPROVAL") }, { label: "Completed", value: count(rows, "SUCCEEDED") }, { label: "Rejected / canceled", value: count(rows, "REJECTED", "CANCELED") }],
  actions: approval("SUCCEEDED", "Top-up"),
  create: request("Add funds", "tu", [
    { key: "amount", label: "Amount", type: "money", required: true },
    { key: "source", label: "From", type: "select", required: true, options: ["Bank transfer (TEST)", "Linked account (TEST)"] },
    { key: "description", label: "Description", type: "text" },
  ], (v, m) => ({ amount: money(v.amount ?? "0", cur(m)), source: v.source ?? "", description: v.description || "Top-up" })),
};

const transfers: ScreenDef = {
  id: "ZP-STR-011", title: "Transfers", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => {
    const other = nth(MERCHANTS, i + 1);
    return [
      rec(m, `tr_${short(m)}_1`, "PAID", { amount: money(84_520 + i * 3_100, cur(m)), destination: other.displayName, description: "Marketplace share" }, now - (6 + i) * DAY, "Transfer paid (TEST)", people.finB.name, people.finA),
      ...(i % 3 === 0 ? [rec(m, `tr_${short(m)}_2`, "REQUIRES_APPROVAL", { amount: money(31_000, cur(m)), destination: other.displayName, description: "Internal transfer" }, now - 3 * HOUR, "Transfer requested", people.mfin.name, people.mfin)] : []),
    ];
  }),
  summary: (rows) => [{ label: "Awaiting approval", value: count(rows, "REQUIRES_APPROVAL") }, { label: "Paid", value: count(rows, "PAID") }],
  actions: approval("PAID", "Transfer"),
  create: request("Transfer", "tr", [
    { key: "amount", label: "Amount", type: "money", required: true },
    { key: "destination", label: "Destination", type: "select", required: true, options: MERCHANTS.map((m) => m.displayName) },
    { key: "description", label: "Description", type: "text" },
  ], (v, m) => ({ amount: money(v.amount ?? "0", cur(m)), destination: v.destination ?? "", description: v.description || "Transfer" })),
};

const collectedFees: ScreenDef = {
  id: "ZP-STR-012", title: "Collected Fees", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => Array.from({ length: 3 }, (_, k) => {
    const r = rng(31_000 + i * 10 + k);
    return rec(m, `fee_${short(m)}_${k + 1}`, k === 2 && i % 2 ? "REFUNDED" : "COLLECTED",
      { payment: `pi_test_${short(m).slice(0, 6)}${k}${Math.floor(r() * 9000 + 1000)}`, amount: money(Math.round(120 + r() * 880), cur(m)) },
      now - (k * 2 + i + 1) * DAY, "Fee collected (TEST)", "fee engine");
  })),
  summary: (rows) => [{ label: "Fees", value: String(rows.length) }, { label: "Collected", value: count(rows, "COLLECTED") }, { label: "Refunded", value: count(rows, "REFUNDED") }],
  actions: {},
};

const settlementCurrencies: ScreenDef = {
  id: "ZP-STR-013", title: "Settlement Currencies", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => m.currencies.map((c, k) =>
    rec(m, `sc_${short(m)}_${c.toLowerCase()}`, k === 0 ? "ACTIVE" : i % 2 ? "PENDING_VERIFICATION" : "ACTIVE",
      { currency: c, account: `${pick(rng(32_000 + i), ["Northwind Bank", "Harbour Bank", "Kestrel Savings"])} ••${String(4400 + i * 77 + k).slice(-4)}` },
      now - (40 - i) * DAY, k === 0 ? "Default settlement currency" : "Currency added", people.finA.name, people.finA))),
  summary: (rows) => [{ label: "Active", value: count(rows, "ACTIVE") }, { label: "Pending verification", value: count(rows, "PENDING_VERIFICATION") }],
  actions: {
    verify: { label: "Mark verified", from: ["PENDING_VERIFICATION"], to: "ACTIVE", deciders: CHECKERS, separation: true, reasonRequired: false, stepUp: true,
      source: `Bank account verification: the requester cannot verify their own account. ${NOTICE}` },
  },
  create: request("Add settlement currency", "sc", [
    { key: "currency", label: "Currency", type: "select", required: true, options: ["GBP", "EUR", "USD"] },
    { key: "account", label: "Bank account (last 4 digits)", type: "number", required: true },
  ], (v) => ({ currency: v.currency ?? "", account: `Bank account ••${(v.account ?? "").slice(-4)}` }), "PENDING_VERIFICATION"),
};

const payoutSchedule: ScreenDef = {
  id: "ZP-STR-014", title: "Payout Schedule", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.map((m, i) => rec(m, `psch_${short(m)}`, i === 3 ? "REQUIRES_APPROVAL" : "ACTIVE",
    { schedule: nth(["Every day", "Every week (Monday)", "Every month (1st)"], i), delay: nth(["2 business days", "7 days", "14 days"], i), minimum: money(50_000 + i * 10_000, cur(m)) },
    now - (30 + i) * DAY, i === 3 ? "Schedule change requested" : "Schedule active", people.finA.name, people.finA)),
  summary: (rows) => [{ label: "Active schedules", value: count(rows, "ACTIVE") }, { label: "Changes awaiting approval", value: count(rows, "REQUIRES_APPROVAL") }],
  actions: approval("ACTIVE", "Payout schedule change"),
  create: request("Change payout schedule", "psch", [
    { key: "schedule", label: "Pay out", type: "select", required: true, options: ["Every day", "Every week (Monday)", "Every month (1st)", "Manually"] },
    { key: "delay", label: "Delay", type: "select", required: true, options: ["2 business days", "7 days", "14 days"] },
    { key: "minimum", label: "Minimum balance to keep", type: "money" },
  ], (v, m) => ({ schedule: v.schedule ?? "", delay: v.delay ?? "", minimum: money(v.minimum || "0", cur(m)) })),
};

// ---------------------------------------------------------- Treasury & capital
const treasury: ScreenDef = {
  id: "ZP-STR-024", title: "Treasury Accounts", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.slice(0, 4).flatMap((m, i) => [
    rec(m, `fa_${short(m)}_ops`, "OPEN", { nickname: "Operating account", currency: cur(m), balance: money(2_450_000 - i * 210_000, cur(m)) }, now - (90 - i) * DAY, "Account opened (TEST)", people.finB.name, people.finA),
    ...(i === 0 ? [rec(m, `fa_${short(m)}_tax`, "OPEN", { nickname: "Tax reserve", currency: cur(m), balance: money(680_000, cur(m)) }, now - 60 * DAY, "Account opened (TEST)", people.finB.name, people.finA)] : []),
  ]),
  summary: (rows) => [{ label: "Open accounts", value: count(rows, "OPEN") }, { label: "Awaiting approval", value: count(rows, "REQUIRES_APPROVAL") }],
  actions: approval("OPEN", "Financial account"),
  create: request("Open financial account", "fa", [
    { key: "nickname", label: "Nickname", type: "text", required: true },
  ], (v, m) => ({ nickname: v.nickname ?? "", currency: cur(m), balance: money(0, cur(m)) })),
};

const issuing: ScreenDef = {
  id: "ZP-STR-025", title: "Issuing (Cards)", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.slice(0, 3).flatMap((m, i) => [
    rec(m, `ic_${short(m)}_1`, "ACTIVE", { cardholder: nth(["Jordan Pike", "Ari Lowe", "Sam Okafor"], i), type: "Virtual", limit: money(200_000, cur(m)), last4: String(4417 + i * 1311).slice(-4) }, now - (50 - i) * DAY, "Card activated", people.finB.name, people.finA),
    rec(m, `ic_${short(m)}_2`, i === 1 ? "INACTIVE" : "ACTIVE", { cardholder: "Operations team", type: "Physical", limit: money(500_000, cur(m)), last4: String(9021 + i * 733).slice(-4) }, now - (20 - i) * DAY, "Card created", people.finA.name, people.finA),
  ]),
  summary: (rows) => [{ label: "Active cards", value: count(rows, "ACTIVE") }, { label: "Inactive", value: count(rows, "INACTIVE") }, { label: "Canceled", value: count(rows, "CANCELED") }],
  actions: {
    activate: { label: "Activate", from: ["INACTIVE"], to: "ACTIVE", deciders: CHECKERS, separation: true, reasonRequired: false, stepUp: true, source: `Card activation: the requester cannot activate it. ${NOTICE}` },
    ...toggle("freeze", "Freeze", "ACTIVE", "INACTIVE", MAKERS),
    cancel_card: { label: "Cancel card", from: ["ACTIVE", "INACTIVE"], to: "CANCELED", deciders: CHECKERS, separation: false, reasonRequired: true, stepUp: false, quiet: true, source: "Card cancellation: reason mandatory" },
  },
  create: request("Create card", "ic", [
    { key: "cardholder", label: "Cardholder", type: "text", required: true },
    { key: "type", label: "Type", type: "select", required: true, options: ["Virtual", "Physical"] },
    { key: "limit", label: "Monthly spending limit", type: "money", required: true },
  ], (v, m) => ({ cardholder: v.cardholder ?? "", type: v.type ?? "", limit: money(v.limit ?? "0", cur(m)), last4: String(1000 + Math.floor(rng(Number(v.limit ?? 0))() * 9000)) }), "INACTIVE"),
};

const capital: ScreenDef = {
  id: "ZP-STR-026", title: "Capital", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.slice(0, 3).map((m, i) => rec(m, `offer_${short(m)}`, i === 2 ? "EXPIRED" : "OFFERED",
    { amount: money(4_500_000 - i * 1_000_000, cur(m)), fee: money(405_000 - i * 90_000, cur(m)), expires: iso(now + (21 - i * 25) * DAY).slice(0, 10) },
    now - (5 + i) * DAY, "Financing offer issued (TEST)", "capital model")),
  summary: (rows) => [{ label: "Open offers", value: count(rows, "OFFERED") }, { label: "Accepted", value: count(rows, "ACCEPTED") }],
  actions: {
    accept: { label: "Accept offer", from: ["OFFERED"], to: "ACCEPTED", deciders: CHECKERS, separation: false, reasonRequired: false, stepUp: true, source: `Financing acceptance needs a password. ${NOTICE}` },
    ...toggle("decline", "Decline offer", "OFFERED", "DECLINED"),
  },
};

const financialConnections: ScreenDef = {
  id: "ZP-STR-027", title: "Financial Connections", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.map((m, i) => rec(m, `fca_${short(m)}`, i === 5 ? "DISCONNECTED" : "ACTIVE",
    { institution: nth(["Northwind Bank", "Harbour Bank", "Kestrel Savings"], i), last4: String(6789 - i * 311).slice(-4) }, now - (100 - i * 7) * DAY, "Bank account linked (TEST)", people.finA.name, people.finA)),
  summary: (rows) => [{ label: "Linked", value: count(rows, "ACTIVE") }, { label: "Disconnected", value: count(rows, "DISCONNECTED") }],
  actions: {
    disconnect: { label: "Disconnect", from: ["ACTIVE"], to: "DISCONNECTED", deciders: MAKERS, separation: false, reasonRequired: true, stepUp: false, quiet: true, source: "Unlinking a bank account: reason mandatory" },
  },
  create: request("Link bank account", "fca", [
    { key: "institution", label: "Bank name", type: "text", required: true },
    { key: "last4", label: "Account (last 4 digits)", type: "number", required: true },
  ], (v) => ({ institution: v.institution ?? "", last4: (v.last4 ?? "").slice(-4) }), "PENDING_VERIFICATION"),
};

// ---------------------------------------------------------- Reporting tools
const customMetrics: ScreenDef = {
  id: "ZP-STR-020", title: "Custom Metrics", area: AREA, scoped: true,
  generate: ({ now, base }) => MERCHANTS.map((m, i) => {
    const mine = base.payments.filter((p) => p.merchantId === m.id && p.environment === "TEST");
    const ok = mine.filter((p) => p.status === "SUCCEEDED");
    const avg = ok.length ? ok.reduce((t, p) => t + BigInt(p.amountMinor), 0n) / BigInt(ok.length) : 0n;
    return rec(m, `cm_${short(m)}`, "ACTIVE", { name: i % 2 ? "Success rate" : "Average order value", formula: i % 2 ? "succeeded ÷ all payments" : "succeeded volume ÷ succeeded payments",
      value: i % 2 ? `${mine.length ? ((ok.length / mine.length) * 100).toFixed(1) : "0.0"}%` : `${cur(m)} ${(Number(avg) / 100).toFixed(2)}` }, now - (14 + i) * DAY, "Metric created", people.recon.name);
  }),
  summary: (rows) => [{ label: "Metrics", value: String(rows.length) }],
  actions: {},
  create: request("Create metric", "cm", [
    { key: "name", label: "Metric name", type: "text", required: true },
    { key: "formula", label: "Formula", type: "select", required: true, options: ["refunds ÷ payments", "succeeded ÷ all payments", "volume ÷ payments"] },
  ], (v) => ({ name: v.name ?? "", formula: v.formula ?? "", value: "Calculated nightly (TEST)" }), "ACTIVE"),
};

const savedQueries: ScreenDef = {
  id: "ZP-STR-021", title: "Sigma (Saved Queries)", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.slice(0, 3).map((m, i) => rec(m, `sq_${short(m)}`, i === 0 ? "SCHEDULED" : "SAVED",
    { name: nth(["Gross volume by month", "Customers with failed payments", "Payments by card brand"], i), schedule: i === 0 ? "Monthly" : "Not scheduled", sql: nth(["SELECT month, sum(amount) FROM charges …", "SELECT email, count(*) FROM charges …", "SELECT brand, count(*) FROM charges …"], i) },
    now - (9 + i) * DAY, "Query saved", people.recon.name)),
  summary: (rows) => [{ label: "Saved", value: count(rows, "SAVED") }, { label: "Scheduled", value: count(rows, "SCHEDULED") }],
  actions: { ...toggle("schedule_daily", "Schedule daily", "SAVED", "SCHEDULED", MAKERS), ...toggle("unschedule", "Unschedule", "SCHEDULED", "SAVED", MAKERS) },
  create: request("Save query", "sq", [
    { key: "name", label: "Query name", type: "text", required: true },
    { key: "sql", label: "SQL", type: "text", required: true, hint: "Saved only. This console does not run SQL." },
    { key: "schedule", label: "Schedule", type: "select", options: ["Not scheduled", "Daily", "Weekly", "Monthly"] },
  ], (v) => ({ name: v.name ?? "", sql: v.sql ?? "", schedule: v.schedule || "Not scheduled" }), "SAVED"),
};

const revenueRecognition: ScreenDef = {
  id: "ZP-STR-022", title: "Revenue Recognition", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.slice(0, 3).flatMap((m, i) => [2, 1, 0].map((back) => {
    const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back);
    const period = d.toISOString().slice(0, 7);
    const billed = 1_800_000 + i * 220_000 + (2 - back) * 95_000;
    return rec(m, `rev_${short(m)}_${period.replace("-", "")}`, back === 0 ? "OPEN" : "CLOSED",
      { period, recognised: money(Math.round(billed * 0.86), cur(m)), deferred: money(billed - Math.round(billed * 0.86), cur(m)) },
      now - back * 30 * DAY, back === 0 ? "Period open" : "Period closed", people.finB.name);
  })),
  summary: (rows) => [{ label: "Open periods", value: count(rows, "OPEN") }, { label: "Closed", value: count(rows, "CLOSED") }],
  actions: {
    close_period: { label: "Close period", from: ["OPEN"], to: "CLOSED", deciders: ["PFIN"], separation: false, reasonRequired: false, stepUp: true, source: `Period close needs a Finance Controller and a password. ${NOTICE}` },
  },
};

const dataPipelines: ScreenDef = {
  id: "ZP-STR-023", title: "Data Management", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.slice(0, 4).map((m, i) => rec(m, `dp_${short(m)}`, i % 2 ? "PAUSED" : "ACTIVE",
    { name: i % 2 ? "Finance CSV drop" : "Nightly warehouse sync", destination: i % 2 ? "Cloud storage (CSV)" : "Data warehouse", frequency: i % 2 ? "Weekly" : "Daily" },
    now - (21 + i) * DAY, "Pipeline created", people.recon.name)),
  summary: (rows) => [{ label: "Active", value: count(rows, "ACTIVE") }, { label: "Paused", value: count(rows, "PAUSED") }],
  actions: { ...toggle("pause", "Pause", "ACTIVE", "PAUSED", MAKERS), ...toggle("resume", "Resume", "PAUSED", "ACTIVE", MAKERS) },
  create: request("Add data pipeline", "dp", [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "destination", label: "Destination", type: "select", required: true, options: ["Data warehouse", "Cloud storage (CSV)", "Import from file"] },
    { key: "frequency", label: "Frequency", type: "select", options: ["Every 6 hours", "Daily", "Weekly"] },
  ], (v) => ({ name: v.name ?? "", destination: v.destination ?? "", frequency: v.frequency || "Daily" }), "PAUSED"),
};

export const FINANCE_SCREENS: ScreenDef[] = [
  topups, transfers, collectedFees, settlementCurrencies, payoutSchedule,
  customMetrics, savedQueries, revenueRecognition, dataPipelines,
  treasury, issuing, capital, financialConnections,
];
