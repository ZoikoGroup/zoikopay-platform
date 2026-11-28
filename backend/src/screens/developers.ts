/**
 * Stripe-parity developer workbench (ZP-STR-032 events, 033 request logs,
 * 034 API keys), for the TEST environment.
 *
 * DEVELOPMENT FIXTURES ONLY (ADR 0003). Events and logs are derived from the
 * TEST payment fixtures; nothing is delivered to a real endpoint. Keys are
 * fictional and always shown masked: a secret is never returned in full.
 */
import { MERCHANTS } from "../database/fixtures.js";
import type { Persona } from "../authorization/permissions.js";
import type { Merchant } from "../types/domain.js";
import { DAY, HOUR, count, iso, people, scope } from "./fixtureKit.js";
import type { ActionRule, ScreenDef, ScreenRecord } from "./types.js";

const AREA = "area.developers" as const;
const DEVS: Persona[] = ["MDEV", "MOWN", "MOPS"];
const short = (m: Merchant) => m.id.slice(4);
const routine = (label: string, from: string[], to: string, extra: Partial<ActionRule> = {}): ActionRule =>
  ({ label, from, to, deciders: DEVS, separation: false, reasonRequired: false, stepUp: false, quiet: true, source: "Developer workbench (TEST fixture)", ...extra });
/** A masked token: prefix, dots, last four. Never the full secret. */
const masked = (prefix: string, seed: string) => `${prefix}••••${seed.replace(/[^a-z0-9]/gi, "").slice(-4).padStart(4, "0")}`;

const EVENT_BY_STATUS: Record<string, string> = {
  SUCCEEDED: "payment_intent.succeeded", FAILED: "payment_intent.payment_failed", CANCELED: "payment_intent.canceled",
  REQUIRES_CAPTURE: "payment_intent.amount_capturable_updated", PROCESSING: "payment_intent.processing",
};

const events: ScreenDef = {
  id: "ZP-STR-032", title: "Events", area: AREA, scoped: true,
  generate: ({ base }) => base.payments.filter((p) => p.environment === "TEST").slice(0, 60).map((p, i) => {
    const m = MERCHANTS.find((x) => x.id === p.merchantId);
    const failed = i % 11 === 7;
    return {
      id: `evt_${p.id.slice(3, 23)}`, status: failed ? "FAILED" : "DELIVERED", version: 1, tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST" as const,
      fields: { merchant: m?.displayName ?? p.merchantId, type: EVENT_BY_STATUS[p.status] ?? "payment_intent.created", resource: p.id, delivered: failed ? "500 from endpoint" : "200 OK" },
      timeline: [{ at: p.updatedAt, event: failed ? "Delivery failed; retry scheduled" : "Delivered to endpoint", actor: "event relay (TEST)" }],
      updatedAt: p.updatedAt,
    } satisfies ScreenRecord;
  }),
  summary: (rows) => [{ label: "Delivered", value: count(rows, "DELIVERED") }, { label: "Failed", value: count(rows, "FAILED") }],
  actions: { resend: routine("Resend", ["FAILED"], "DELIVERED", { effect: (f) => ({ ...f, delivered: "200 OK (resent)" }) }) },
};

const logs: ScreenDef = {
  id: "ZP-STR-033", title: "Logs", area: AREA, scoped: true,
  generate: ({ base }) => base.payments.filter((p) => p.environment === "TEST").slice(0, 60).map((p, i) => {
    const m = MERCHANTS.find((x) => x.id === p.merchantId);
    const code = p.status === "FAILED" ? "402" : i % 13 === 5 ? "400" : "200";
    return {
      id: `req_${p.id.slice(3, 19)}`, status: code === "200" ? "SUCCEEDED" : "FAILED", version: 1, tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST" as const,
      fields: { merchant: m?.displayName ?? p.merchantId, method: "POST", path: "/v1/payment_intents", code },
      timeline: [{ at: p.createdAt, event: `POST /v1/payment_intents → ${code}`, actor: "API (TEST)" }],
      updatedAt: p.createdAt,
    } satisfies ScreenRecord;
  }),
  summary: (rows) => [{ label: "Requests", value: String(rows.length) }, { label: "Errors", value: count(rows, "FAILED") }],
  actions: {},
};

const apiKeys: ScreenDef = {
  id: "ZP-STR-034", title: "API Keys", area: AREA, scoped: true,
  generate: ({ now }) => MERCHANTS.flatMap((m, i) => {
    const mk = (id: string, status: string, name: string, token: string, used: number): ScreenRecord => ({
      id, status, version: 1, ...scope(m), fields: { merchant: m.displayName, name, token, lastUsed: iso(now - used).slice(0, 10) },
      timeline: [{ at: iso(now - 30 * DAY), event: "Key created (secret shown once)", actor: people.mops.name }], updatedAt: iso(now - used),
    });
    return [
      mk(`pk_${short(m)}`, "ACTIVE", "Publishable key", `pk_test_${short(m).slice(0, 8)}${(4821 + i * 97) % 10000}`, HOUR),
      mk(`sk_${short(m)}`, "ACTIVE", "Secret key", masked("sk_test_", `${7311 + i * 91}`), 2 * HOUR),
      ...(i % 2 ? [] : [mk(`rk_${short(m)}`, "ACTIVE", "Analytics read-only", masked("rk_test_", `${5520 + i * 13}`), DAY)]),
    ];
  }),
  summary: (rows) => [{ label: "Active keys", value: count(rows, "ACTIVE") }, { label: "Revoked", value: count(rows, "REVOKED") }],
  actions: {
    roll: routine("Roll key", ["ACTIVE"], "ACTIVE", { stepUp: true, quiet: true, source: "Rolling a key stops the old one at once; password re-entry. TEST fixture.",
      guard: (r) => (String(r.fields.name) === "Publishable key" ? "Publishable keys are rolled together with their secret key." : null),
      effect: (f) => ({ ...f, token: masked(String(f.token).split("••••")[0] ?? "sk_test_", String(Date.now())), lastUsed: "—" }) }),
    revoke: routine("Revoke", ["ACTIVE"], "REVOKED", { reasonRequired: true,
      guard: (r) => (String(r.fields.name) === "Restricted key" || String(r.fields.token).startsWith("rk_") ? null : "Only restricted keys can be revoked here.") }),
  },
  create: {
    label: "Create restricted key", deciders: DEVS, source: "Restricted key (TEST fixture): shown masked; a real secret would be shown once.",
    fields: [
      { key: "name", label: "Key name", type: "text", required: true },
      { key: "permissions", label: "Permissions", type: "select", required: true, options: ["Charges: read", "Customers: write", "All resources: read"] },
    ],
    build: ({ values, merchant, now, seq }) => ({
      id: `rk_${short(merchant)}_n${seq}`, status: "ACTIVE", requested: false, event: `Restricted key created (${values.permissions ?? ""})`,
      fields: { merchant: merchant.displayName, name: values.name ?? "", token: masked("rk_test_", `${now}${seq}`), lastUsed: "—" },
    }),
  },
};

export const DEVELOPER_SCREENS: ScreenDef[] = [events, logs, apiKeys];
