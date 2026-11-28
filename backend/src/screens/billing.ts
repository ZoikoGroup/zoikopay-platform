/**
 * Stripe-parity billing tools (ZP-STR-001 … 009): coupons, shipping rates,
 * pricing tables, features, test clocks, migrations, usage meters, retry rules
 * and retention offers, for the TEST environment.
 *
 * DEVELOPMENT FIXTURES ONLY (ADR 0003): in-memory records, audited, never sent
 * to a billing service or a PSP. Who owns billing records (Zoiko Pay or Zoiko
 * Billing) is still open, so these screens stay TEST-only.
 */
import { MERCHANTS } from "../database/fixtures.js";
import type { Persona } from "../authorization/permissions.js";
import type { Merchant } from "../types/domain.js";
import { DAY, count, iso, money, people, scope } from "./fixtureKit.js";
import type { ActionRule, CreateRule, ScreenDef, ScreenRecord } from "./types.js";

const AREA = "area.payment_operations" as const;
const COMMERCE: Persona[] = ["MOPS", "MFIN", "POR"];
const nth = <T>(xs: readonly T[], i: number): T => xs[i % xs.length] as T;
const cur = (m: Merchant) => m.currencies[0] ?? "GBP";
const short = (m: Merchant) => m.id.slice(4);

const rec = (m: Merchant, id: string, status: string, fields: ScreenRecord["fields"], at: number, event: string): ScreenRecord => ({
  id, status, version: 1, ...scope(m), fields: { merchant: m.displayName, ...fields },
  timeline: [{ at: iso(at), event, actor: people.mops.name }], updatedAt: iso(at),
});
const routine = (label: string, from: string[], to: string, extra: Partial<ActionRule> = {}): ActionRule =>
  ({ label, from, to, deciders: COMMERCE, separation: false, reasonRequired: false, stepUp: false, quiet: true, source: "Billing tools (TEST fixture)", ...extra });
const pauseResume = { pause: routine("Pause", ["ACTIVE"], "PAUSED"), resume: routine("Resume", ["PAUSED"], "ACTIVE") };
const make = (label: string, prefix: string, status: string, fields: CreateRule["fields"], build: (v: Record<string, string>, m: Merchant, now: number) => ScreenRecord["fields"]): CreateRule => ({
  label, deciders: COMMERCE, source: `${label} (TEST fixture)`, fields,
  build: ({ values, merchant, now, seq }) => ({ id: `${prefix}_${short(merchant)}_n${seq}`, status, requested: false, event: label,
    fields: { merchant: merchant.displayName, ...build(values, merchant, now) } }),
});
/** Per merchant, a few rows built from a small table of values. */
const seeded = (rows: (m: Merchant, i: number, now: number) => ScreenRecord[]) => ({ now }: { now: number }) => MERCHANTS.flatMap((m, i) => rows(m, i, now));

const coupons: ScreenDef = {
  id: "ZP-STR-001", title: "Coupons", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [
    rec(m, `coupon_${short(m)}_1`, "ACTIVE", { name: nth(["WELCOME20", "READER10", "STUDIO15"], i), discountType: "Percentage discount", value: nth(["20%", "10%", "15%"], i), duration: "Once" }, now - (30 + i) * DAY, "Coupon created"),
    rec(m, `coupon_${short(m)}_2`, i % 2 ? "EXPIRED" : "ACTIVE", { name: nth(["SPRING5", "SUMMER10", "LOYAL25"], i), discountType: "Fixed amount discount", value: `${cur(m)} ${nth([5, 10, 25], i)}.00`, duration: nth(["Once", "Forever", "Multiple months"], i) }, now - (60 + i) * DAY, "Coupon created"),
  ]),
  summary: (rows) => [{ label: "Active", value: count(rows, "ACTIVE") }, { label: "Expired", value: count(rows, "EXPIRED") }],
  actions: { expire: routine("Expire coupon", ["ACTIVE"], "EXPIRED") },
  create: make("Create coupon", "coupon", "ACTIVE", [
    { key: "name", label: "Code", type: "text", required: true },
    { key: "discountType", label: "Type", type: "select", required: true, options: ["Percentage discount", "Fixed amount discount"] },
    { key: "value", label: "Percent or amount", type: "number", required: true },
    { key: "duration", label: "Duration", type: "select", required: true, options: ["Once", "Multiple months", "Forever"] },
  ], (v, m) => ({ name: (v.name ?? "").toUpperCase(), discountType: v.discountType ?? "", value: v.discountType === "Percentage discount" ? `${v.value}%` : `${cur(m)} ${v.value}.00`, duration: v.duration ?? "" })),
};

const shipping: ScreenDef = {
  id: "ZP-STR-002", title: "Shipping Rates", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [
    rec(m, `shr_${short(m)}_std`, "ACTIVE", { name: "Standard (3–5 days)", amount: money(495, cur(m)), delivery: "3–5 business days", taxBehavior: "Inclusive" }, now - (40 + i) * DAY, "Shipping rate created"),
    rec(m, `shr_${short(m)}_exp`, i % 3 === 2 ? "ARCHIVED" : "ACTIVE", { name: "Express (next day)", amount: money(995, cur(m)), delivery: "1 business day", taxBehavior: "Inclusive" }, now - (20 + i) * DAY, "Shipping rate created"),
  ]),
  summary: (rows) => [{ label: "Active", value: count(rows, "ACTIVE") }, { label: "Archived", value: count(rows, "ARCHIVED") }],
  actions: { archive: routine("Archive", ["ACTIVE"], "ARCHIVED"), unarchive: routine("Unarchive", ["ARCHIVED"], "ACTIVE") },
  create: make("Create shipping rate", "shr", "ACTIVE", [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "amount", label: "Amount", type: "money", required: true },
    { key: "delivery", label: "Delivery estimate", type: "text" },
    { key: "taxBehavior", label: "Tax", type: "select", options: ["Inclusive", "Exclusive", "Unspecified"] },
  ], (v, m) => ({ name: v.name ?? "", amount: money(v.amount ?? "0", cur(m)), delivery: v.delivery || "—", taxBehavior: v.taxBehavior || "Unspecified" })),
};

const pricingTables: ScreenDef = {
  id: "ZP-STR-003", title: "Pricing Tables", area: AREA, scoped: true,
  generate: seeded((m, i, now) => i % 2 ? [] : [rec(m, `prctbl_${short(m)}`, i === 0 ? "ACTIVE" : "DRAFT", { name: "Website pricing", products: "Starter, Growth, Scale", interval: "Monthly" }, now - (15 + i) * DAY, "Pricing table created")]),
  summary: (rows) => [{ label: "Published", value: count(rows, "ACTIVE") }, { label: "Draft", value: count(rows, "DRAFT") }],
  actions: { publish: routine("Publish", ["DRAFT"], "ACTIVE"), unpublish: routine("Unpublish", ["ACTIVE"], "DRAFT") },
  create: make("Create pricing table", "prctbl", "DRAFT", [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "products", label: "Products (comma-separated)", type: "text", required: true },
    { key: "interval", label: "Default interval", type: "select", options: ["Monthly", "Yearly"] },
  ], (v) => ({ name: v.name ?? "", products: v.products ?? "", interval: v.interval || "Monthly" })),
};

const features: ScreenDef = {
  id: "ZP-STR-004", title: "Features", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [
    rec(m, `feat_${short(m)}_support`, "ACTIVE", { name: "Priority support", lookupKey: "priority_support", products: "Top plan" }, now - (50 + i) * DAY, "Feature created"),
    rec(m, `feat_${short(m)}_sso`, "ACTIVE", { name: "Single sign-on", lookupKey: "sso", products: "Team plans" }, now - (45 + i) * DAY, "Feature created"),
  ]),
  summary: (rows) => [{ label: "Features", value: String(rows.length) }],
  actions: { retire: routine("Retire feature", ["ACTIVE"], "RETIRED") },
  create: make("Create feature", "feat", "ACTIVE", [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "lookupKey", label: "Lookup key", type: "text", required: true, hint: "For example premium_support" },
    { key: "products", label: "Attached products", type: "text" },
  ], (v) => ({ name: v.name ?? "", lookupKey: v.lookupKey ?? "", products: v.products || "—" })),
};

/** "2026-11-28" + 30 days, as a date string. */
const plus30 = (date: unknown) => { const t = Date.parse(String(date)); return Number.isFinite(t) ? iso(t + 30 * DAY).slice(0, 10) : String(date); };
const clocks: ScreenDef = {
  id: "ZP-STR-005", title: "Simulations (Test Clocks)", area: AREA, scoped: true,
  generate: seeded((m, i, now) => i > 2 ? [] : [rec(m, `clock_${short(m)}`, "READY", { name: nth(["Renewal test", "Trial ends", "Dunning run"], i), frozenTime: iso(now).slice(0, 10) }, now - i * DAY, "Test clock created")]),
  summary: (rows) => [{ label: "Clocks", value: String(rows.length) }],
  actions: { advance: routine("Advance 1 month", ["READY"], "READY", { effect: (f) => ({ ...f, frozenTime: plus30(f.frozenTime) }) }) },
  create: make("Create test clock", "clock", "READY", [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "frozenTime", label: "Start the clock at", type: "date", required: true },
  ], (v) => ({ name: v.name ?? "", frozenTime: v.frozenTime ?? "" })),
};

const migrations: ScreenDef = {
  id: "ZP-STR-006", title: "Subscription Migrations", area: AREA, scoped: true,
  generate: seeded((m, i, now) => i > 1 ? [] : [rec(m, `mig_${short(m)}`, i === 0 ? "COMPLETED" : "PROCESSING", { source: i === 0 ? "CSV file" : "Another billing provider", count: String(48 + i * 64) }, now - (50 - i * 40) * DAY, "Migration started")]),
  summary: (rows) => [{ label: "Completed", value: count(rows, "COMPLETED") }, { label: "Processing", value: count(rows, "PROCESSING") }],
  actions: { complete: routine("Mark completed", ["PROCESSING"], "COMPLETED") },
  create: make("Start migration", "mig", "PROCESSING", [
    { key: "source", label: "From", type: "select", required: true, options: ["CSV file", "Another billing provider"] },
    { key: "count", label: "Number of subscriptions", type: "number", required: true },
  ], (v) => ({ source: v.source ?? "", count: v.count ?? "0" })),
};

const meters: ScreenDef = {
  id: "ZP-STR-007", title: "Usage-based Billing", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [
    rec(m, `mtr_${short(m)}_api`, "ACTIVE", { name: "API requests", eventName: "api_request", aggregation: "Sum" }, now - (25 + i) * DAY, "Meter created"),
    ...(i % 2 ? [] : [rec(m, `mtr_${short(m)}_seats`, "ACTIVE", { name: "Active seats", eventName: "seat_active", aggregation: "Last value" }, now - (12 + i) * DAY, "Meter created")]),
  ]),
  summary: (rows) => [{ label: "Active meters", value: count(rows, "ACTIVE") }, { label: "Inactive", value: count(rows, "INACTIVE") }],
  actions: { deactivate: routine("Deactivate", ["ACTIVE"], "INACTIVE"), reactivate: routine("Reactivate", ["INACTIVE"], "ACTIVE") },
  create: make("Create meter", "mtr", "ACTIVE", [
    { key: "name", label: "Meter name", type: "text", required: true },
    { key: "eventName", label: "Event name", type: "text", required: true, hint: "For example api_requests" },
    { key: "aggregation", label: "Aggregation", type: "select", required: true, options: ["Sum", "Count", "Last value"] },
  ], (v) => ({ name: v.name ?? "", eventName: v.eventName ?? "", aggregation: v.aggregation ?? "" })),
};

const retryRules: ScreenDef = {
  id: "ZP-STR-008", title: "Revenue Recovery", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [rec(m, `rr_${short(m)}`, i % 3 === 1 ? "PAUSED" : "ACTIVE", { name: "Smart retries", retries: String(nth([8, 4, 6], i)), window: nth(["2 weeks", "1 week", "3 weeks"], i), finalAction: nth(["Cancel subscription", "Leave past due", "Mark unpaid"], i) }, now - (35 + i) * DAY, "Retry rule created")]),
  summary: (rows) => [{ label: "Active rules", value: count(rows, "ACTIVE") }, { label: "Paused", value: count(rows, "PAUSED") }],
  actions: pauseResume,
  create: make("Create retry rule", "rr", "ACTIVE", [
    { key: "name", label: "Rule name", type: "text", required: true },
    { key: "retries", label: "Number of retries", type: "number", required: true },
    { key: "window", label: "Retry window", type: "select", required: true, options: ["1 week", "2 weeks", "3 weeks", "1 month"] },
    { key: "finalAction", label: "If all retries fail", type: "select", required: true, options: ["Cancel subscription", "Mark unpaid", "Leave past due"] },
  ], (v) => ({ name: v.name ?? "", retries: v.retries ?? "", window: v.window ?? "", finalAction: v.finalAction ?? "" })),
};

const retention: ScreenDef = {
  id: "ZP-STR-009", title: "Retention", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [rec(m, `ret_${short(m)}`, i % 2 ? "PAUSED" : "ACTIVE", { name: nth(["Stay for 25% off", "One month on us"], i), discount: nth(["25% for 3 months", "1 month free"], i), appliesTo: "All plans" }, now - (18 + i) * DAY, "Offer created")]),
  summary: (rows) => [{ label: "Active offers", value: count(rows, "ACTIVE") }, { label: "Paused", value: count(rows, "PAUSED") }],
  actions: pauseResume,
  create: make("Create retention offer", "ret", "ACTIVE", [
    { key: "name", label: "Offer name", type: "text", required: true },
    { key: "discount", label: "Discount", type: "select", required: true, options: ["10% for 3 months", "25% for 3 months", "1 month free"] },
    { key: "appliesTo", label: "Applies to", type: "text", hint: "Plan or product" },
  ], (v) => ({ name: v.name ?? "", discount: v.discount ?? "", appliesTo: v.appliesTo || "All plans" })),
};

export const BILLING_SCREENS: ScreenDef[] = [coupons, shipping, pricingTables, features, clocks, migrations, meters, retryRules, retention];
