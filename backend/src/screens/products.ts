/**
 * Stripe-parity payment products and other products (ZP-STR-015 … 019,
 * 028 … 031): checkout sessions, card readers, agent connections, saved-wallet
 * customers, standalone 3DS, identity checks, business profiles, climate
 * contributions and company formation, for the TEST environment.
 *
 * DEVELOPMENT FIXTURES ONLY (ADR 0003). The console never creates or changes a
 * payment (backend/src/database/dataSource.ts: "it does not create payments"):
 * a completed checkout session or a simulated card tap is recorded on its own
 * screen only and does not appear as a payment in Transactions.
 */
import { MERCHANTS } from "../database/fixtures.js";
import type { Persona } from "../authorization/permissions.js";
import type { Merchant } from "../types/domain.js";
import { DAY, HOUR, count, iso, money, people, rng, scope } from "./fixtureKit.js";
import type { ActionRule, CreateRule, ScreenDef, ScreenRecord } from "./types.js";

const AREA = "area.payment_operations" as const;
const MAKERS: Persona[] = ["MOPS", "MFIN", "POR"];
const nth = <T>(xs: readonly T[], i: number): T => xs[i % xs.length] as T;
const cur = (m: Merchant) => m.currencies[0] ?? "GBP";
const short = (m: Merchant) => m.id.slice(4);
const NOT_A_PAYMENT = "TEST fixture: no payment is created and no money moves.";

const rec = (m: Merchant, id: string, status: string, fields: ScreenRecord["fields"], at: number, event: string): ScreenRecord => ({
  id, status, version: 1, ...scope(m), fields: { merchant: m.displayName, ...fields },
  timeline: [{ at: iso(at), event, actor: people.mops.name }], updatedAt: iso(at),
});
const routine = (label: string, from: string[], to: string, extra: Partial<ActionRule> = {}): ActionRule =>
  ({ label, from, to, deciders: MAKERS, separation: false, reasonRequired: false, stepUp: false, quiet: true, source: NOT_A_PAYMENT, ...extra });
const make = (label: string, prefix: string, status: string, fields: CreateRule["fields"], build: (v: Record<string, string>, m: Merchant) => ScreenRecord["fields"],
  check?: CreateRule["check"]): CreateRule => ({
  label, deciders: MAKERS, source: `${label}. ${NOT_A_PAYMENT}`, fields, ...(check ? { check } : {}),
  build: ({ values, merchant, seq }) => ({ id: `${prefix}_${short(merchant)}_n${seq}`, status, requested: false, event: label,
    fields: { merchant: merchant.displayName, ...build(values, merchant) } }),
});
const seeded = (rows: (m: Merchant, i: number, now: number) => ScreenRecord[]) => ({ now }: { now: number }) => MERCHANTS.flatMap((m, i) => rows(m, i, now));
const httpsOrEmpty = (key: string): CreateRule["check"] => ({ values }) =>
  (!values[key] || /^https:\/\/[^\s/$.?#][^\s]{2,190}$/i.test(values[key] ?? "") ? null : "Use an https:// address.");
const maskEmail = (email: string) => `${email.slice(0, 1).toLowerCase()}••••@${(email.split("@")[1] ?? "").toLowerCase()}`;

// ------------------------------------------------------------ payment products
const checkout: ScreenDef = {
  id: "ZP-STR-015", title: "Checkout", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [
    rec(m, `cs_${short(m)}_1`, "COMPLETE", { mode: "Payment", amount: money(4_200 + i * 1_150, cur(m)), successUrl: `https://${short(m).replace(/_/g, "-")}.example/thanks` }, now - (i + 1) * 5 * HOUR, "Session completed (TEST)"),
    rec(m, `cs_${short(m)}_2`, i % 3 === 0 ? "EXPIRED" : "OPEN", { mode: nth(["Subscription", "Payment", "Setup"], i), amount: money(2_900, cur(m)), successUrl: `https://${short(m).replace(/_/g, "-")}.example/done` }, now - (i + 2) * HOUR, "Session created"),
  ]),
  summary: (rows) => [{ label: "Open", value: count(rows, "OPEN") }, { label: "Completed", value: count(rows, "COMPLETE") }, { label: "Expired", value: count(rows, "EXPIRED") }],
  actions: {
    simulate_payment: routine("Simulate customer payment", ["OPEN"], "COMPLETE", { effect: (f) => ({ ...f, notice: `Completed with a test card. ${NOT_A_PAYMENT}` }) }),
    expire: routine("Expire session", ["OPEN"], "EXPIRED"),
  },
  create: make("Create checkout session", "cs", "OPEN", [
    { key: "mode", label: "Mode", type: "select", required: true, options: ["Payment", "Subscription", "Setup"] },
    { key: "amount", label: "Amount", type: "money", required: true },
    { key: "successUrl", label: "Success URL", type: "text", hint: "https:// address the customer returns to" },
  ], (v, m) => ({ mode: v.mode ?? "", amount: money(v.amount ?? "0", cur(m)), successUrl: v.successUrl || "—" }), httpsOrEmpty("successUrl")),
};

const terminal: ScreenDef = {
  id: "ZP-STR-016", title: "Terminal", area: AREA, scoped: true,
  generate: seeded((m, i, now) => i > 3 ? [] : [
    rec(m, `tmr_${short(m)}_1`, "ONLINE", { label: "Front counter", device: "Countertop reader", location: `${m.displayName} store` }, now - (60 + i) * DAY, "Reader registered"),
    ...(i % 2 ? [] : [rec(m, `tmr_${short(m)}_2`, "OFFLINE", { label: "Pop-up stand", device: "Mobile reader", location: "Weekend market" }, now - (20 + i) * DAY, "Reader registered")]),
  ]),
  summary: (rows) => [{ label: "Online", value: count(rows, "ONLINE") }, { label: "Offline", value: count(rows, "OFFLINE") }],
  actions: {
    tap: routine("Simulate a card tap", ["ONLINE"], "ONLINE", {
      effect: (f) => ({ ...f, notice: `Last tap: test card approved at ${new Date().toISOString().slice(11, 16)} UTC. ${NOT_A_PAYMENT}` }) }),
    bring_online: routine("Bring online", ["OFFLINE"], "ONLINE"),
    take_offline: routine("Take offline", ["ONLINE"], "OFFLINE"),
  },
  create: make("Register reader", "tmr", "OFFLINE", [
    { key: "label", label: "Label", type: "text", required: true },
    { key: "device", label: "Device", type: "select", required: true, options: ["Countertop reader", "Mobile reader", "Simulated reader (TEST)"] },
    { key: "location", label: "Location", type: "text", required: true },
  ], (v) => ({ label: v.label ?? "", device: v.device ?? "", location: v.location ?? "" })),
};

const agentic: ScreenDef = {
  id: "ZP-STR-017", title: "Agentic Commerce", area: AREA, scoped: true,
  generate: seeded((m, i, now) => i % 2 ? [] : [rec(m, `agt_${short(m)}`, i === 0 ? "ENABLED" : "DISABLED", { agent: nth(["Shopping assistant", "Reading companion", "Studio helper"], i / 2), limit: money(25_000, cur(m)), scope: "Whole catalogue" }, now - (10 + i) * DAY, "Agent connected")]),
  summary: (rows) => [{ label: "Enabled", value: count(rows, "ENABLED") }, { label: "Disabled", value: count(rows, "DISABLED") }],
  actions: { disable: routine("Disable", ["ENABLED"], "DISABLED"), enable: routine("Enable", ["DISABLED"], "ENABLED") },
  create: make("Connect agent", "agt", "DISABLED", [
    { key: "agent", label: "Agent name", type: "text", required: true },
    { key: "limit", label: "Spending limit per order", type: "money", required: true },
    { key: "scope", label: "Scope", type: "select", required: true, options: ["Whole catalogue", "Selected products"] },
  ], (v, m) => ({ agent: v.agent ?? "", limit: money(v.limit ?? "0", cur(m)), scope: v.scope ?? "" })),
};

const link: ScreenDef = {
  id: "ZP-STR-018", title: "Link", area: AREA, scoped: true,
  generate: seeded((m, i, now) => Array.from({ length: 2 }, (_, k) => {
    const r = rng(41_000 + i * 10 + k);
    return rec(m, `lnk_${short(m)}_${k + 1}`, "ACTIVE", { customer: `${nth(["a", "m", "t", "z"], i + k)}••••@example.com`, methods: String(1 + Math.floor(r() * 3)) }, now - (k * 9 + i + 3) * DAY, "Customer saved details");
  })),
  summary: (rows) => [{ label: "Customers using Link", value: count(rows, "ACTIVE") }],
  actions: { remove: routine("Remove saved details", ["ACTIVE"], "REMOVED", { reasonRequired: true }) },
};

const threeDs: ScreenDef = {
  id: "ZP-STR-019", title: "Standalone 3DS", area: AREA, scoped: true,
  generate: seeded((m, i, now) => Array.from({ length: 2 }, (_, k) => {
    const ok = (i + k) % 3 !== 2;
    return rec(m, `3ds_${short(m)}_${k + 1}`, ok ? "AUTHENTICATED" : "FAILED", { card: `${nth(["VISA", "MC", "AMEX"], i + k)} •• ${String(4242 + i * 101 + k).slice(-4)}`, amount: money(12_900 + k * 3_300, cur(m)), outcome: ok ? "Authenticated" : "Customer did not finish" }, now - (k + i + 1) * DAY, "3DS authentication");
  })),
  summary: (rows) => [{ label: "Authenticated", value: count(rows, "AUTHENTICATED") }, { label: "Failed", value: count(rows, "FAILED") }],
  actions: {},
};

// ------------------------------------------------------------ more products
const identity: ScreenDef = {
  id: "ZP-STR-028", title: "Identity", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [rec(m, `vs_${short(m)}`, nth(["VERIFIED", "REQUIRES_INPUT", "PROCESSING"], i), { type: nth(["Document and selfie", "Identity document", "ID number"], i), reference: `user_${1040 + i}` }, now - (i + 1) * DAY, "Verification session created")]),
  summary: (rows) => [{ label: "Verified", value: count(rows, "VERIFIED") }, { label: "Needs input", value: count(rows, "REQUIRES_INPUT") }, { label: "Processing", value: count(rows, "PROCESSING") }],
  actions: {
    verify: routine("Simulate verified", ["REQUIRES_INPUT", "PROCESSING"], "VERIFIED", { source: "TEST fixture: no document is checked." }),
    cancel: routine("Cancel session", ["REQUIRES_INPUT", "PROCESSING"], "CANCELED"),
  },
  create: make("Create verification", "vs", "REQUIRES_INPUT", [
    { key: "type", label: "Check", type: "select", required: true, options: ["Identity document", "Document and selfie", "ID number"] },
    { key: "reference", label: "Your reference", type: "text", required: true },
  ], (v) => ({ type: v.type ?? "", reference: v.reference ?? "" })),
};

const profiles: ScreenDef = {
  id: "ZP-STR-029", title: "Profiles", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [rec(m, `prof_${short(m)}`, i % 3 === 1 ? "UNVERIFIED" : "VERIFIED", { publicName: m.displayName, supportEmail: `s••••@${short(m).split("_")[0]}.example`, website: `https://${short(m).replace(/_/g, "-")}.example` }, now - (90 - i) * DAY, "Profile created")]),
  summary: (rows) => [{ label: "Verified", value: count(rows, "VERIFIED") }, { label: "Unverified", value: count(rows, "UNVERIFIED") }],
  actions: { verify: routine("Mark verified", ["UNVERIFIED"], "VERIFIED") },
  create: make("Create profile", "prof", "UNVERIFIED", [
    { key: "publicName", label: "Public business name", type: "text", required: true },
    { key: "supportEmail", label: "Support email", type: "email", required: true },
    { key: "website", label: "Website", type: "text", hint: "https:// address" },
  ], (v) => ({ publicName: v.publicName ?? "", supportEmail: maskEmail(v.supportEmail ?? ""), website: v.website || "—" }), httpsOrEmpty("website")),
};

const climate: ScreenDef = {
  id: "ZP-STR-030", title: "Climate", area: AREA, scoped: true,
  generate: seeded((m, i, now) => [rec(m, `clim_${short(m)}`, i % 2 ? "PAUSED" : "ACTIVE", { share: nth(["1%", "0.5%", "2%"], i) }, now - (70 - i) * DAY, "Contribution set")]),
  summary: (rows) => [{ label: "Contributing", value: count(rows, "ACTIVE") }, { label: "Paused", value: count(rows, "PAUSED") }],
  actions: { pause: routine("Pause", ["ACTIVE"], "PAUSED"), resume: routine("Resume", ["PAUSED"], "ACTIVE") },
  create: make("Set contribution", "clim", "ACTIVE", [
    { key: "share", label: "Share of revenue", type: "select", required: true, options: ["0.5%", "1%", "2%"] },
  ], (v) => ({ share: v.share ?? "" })),
};

const atlas: ScreenDef = {
  id: "ZP-STR-031", title: "Atlas", area: AREA, scoped: true,
  generate: seeded((m, i, now) => i > 1 ? [] : [rec(m, `atl_${short(m)}`, i === 0 ? "INCORPORATED" : "DRAFT", { company: `${m.displayName.split(" ")[0]} Labs Ltd`, jurisdiction: i === 0 ? "United Kingdom" : "Ireland" }, now - (30 - i * 20) * DAY, "Company started")]),
  summary: (rows) => [{ label: "Draft", value: count(rows, "DRAFT") }, { label: "Filed", value: count(rows, "FILED") }, { label: "Incorporated", value: count(rows, "INCORPORATED") }],
  actions: {
    file: routine("File company", ["DRAFT"], "FILED", { source: "TEST fixture: nothing is filed with any registry." }),
    incorporate: routine("Mark incorporated", ["FILED"], "INCORPORATED"),
  },
  create: make("Start a company", "atl", "DRAFT", [
    { key: "company", label: "Company name", type: "text", required: true },
    { key: "jurisdiction", label: "Jurisdiction", type: "select", required: true, options: ["United Kingdom", "Ireland", "United States (Delaware)"] },
  ], (v) => ({ company: v.company ?? "", jurisdiction: v.jurisdiction ?? "" })),
};

export const PRODUCT_SCREENS: ScreenDef[] = [checkout, terminal, agentic, link, threeDs, identity, profiles, climate, atlas];
