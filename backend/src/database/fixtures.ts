import type {
  ActivityEvent, AttemptStatus, EvidenceEvent, IntentStatus, LegalEntity, Merchant, Payment, Payout,
  SettlementBatch,
} from "../types/domain.js";
/**
 * DEVELOPMENT FIXTURES. Deterministic, fictional data for the TEST environment
 * only. They stand in for Go business APIs that do not exist yet and are always
 * labelled `source: "fixture"` in API responses. Nothing here is production data.
 */

/**
 * Keycloak user ID of a local realm user (deploy/compose/keycloak/zoikopay-realm.json
 * fixes them). Used only to name the fictional people who made fixture
 * records; it grants nothing. Roles come from merchant.memberships (Q39).
 */
export const localUserId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Fixed synthetic tenant and merchant IDs in the real `ten_`/`mer_` UUIDv7
 * format (merchant.tenants / merchant.merchants CHECKs), so the grants that
 * `make seed-local` writes to merchant.memberships cover these fixture
 * records (OPEN_QUESTIONS Q39). scripts/seed-local.sql must use the same IDs;
 * test/seed.test.ts checks that.
 */
export const FIXTURE_IDS = {
  tenants: {
    northwind: "ten_019a0000000170008000000000000001",
    alder: "ten_019a0000000270008000000000000002",
    kestrel: "ten_019a0000000370008000000000000003",
  },
  merchants: {
    northwindUk: "mer_019a0000010170008000000000000101",
    northwindEu: "mer_019a0000010270008000000000000102",
    alderBooks: "mer_019a0000020170008000000000000201",
    alderTravel: "mer_019a0000020270008000000000000202",
    kestrelUk: "mer_019a0000030170008000000000000301",
    kestrelEu: "mer_019a0000030270008000000000000302",
  },
} as const;
const T = FIXTURE_IDS.tenants;
const M = FIXTURE_IDS.merchants;

/** Fixture tenants (organisations): ID and display name only. */
export const TENANTS: { id: string; name: string }[] = [
  { id: T.northwind, name: "Northwind" },
  { id: T.alder, name: "Alder" },
  { id: T.kestrel, name: "Kestrel" },
];

// Small seeded PRNG so every run produces the same dataset.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LEGAL_ENTITIES: LegalEntity[] = [
  { id: "cell_uk_01", name: "Zoiko Pay UK (fixture)", jurisdiction: "United Kingdom", baseCurrency: "GBP" },
  { id: "cell_eu_01", name: "Zoiko Pay Europe (fixture)", jurisdiction: "European Union", baseCurrency: "EUR" },
];

export const MERCHANTS: Merchant[] = [
  { id: M.northwindUk, tenantId: T.northwind, legalEntityId: "cell_uk_01", displayName: "Northwind Outfitters UK", currencies: ["GBP"], environment: "TEST" },
  { id: M.northwindEu, tenantId: T.northwind, legalEntityId: "cell_eu_01", displayName: "Northwind Outfitters EU", currencies: ["EUR"], environment: "TEST" },
  { id: M.alderBooks, tenantId: T.alder, legalEntityId: "cell_uk_01", displayName: "Alder Books", currencies: ["GBP", "USD"], environment: "TEST" },
  { id: M.alderTravel, tenantId: T.alder, legalEntityId: "cell_eu_01", displayName: "Alder Travel", currencies: ["EUR", "USD"], environment: "TEST" },
  { id: M.kestrelUk, tenantId: T.kestrel, legalEntityId: "cell_uk_01", displayName: "Kestrel Studio UK", currencies: ["GBP"], environment: "TEST" },
  { id: M.kestrelEu, tenantId: T.kestrel, legalEntityId: "cell_eu_01", displayName: "Kestrel Studio EU", currencies: ["EUR"], environment: "TEST" },
];

const STATUS_WEIGHTS: [IntentStatus, number][] = [
  ["SUCCEEDED", 78], ["FAILED", 8], ["PROCESSING", 3], ["REQUIRES_CAPTURE", 3], ["CANCELED", 3],
  ["REQUIRES_CUSTOMER_ACTION", 2], ["EXPIRED", 1], ["PARTIALLY_CAPTURED", 1], ["REQUIRES_CONFIRMATION", 1],
];
const ATTEMPT_FOR: Record<IntentStatus, AttemptStatus> = {
  REQUIRES_PAYMENT_METHOD: "RESERVED", REQUIRES_CONFIRMATION: "RESERVED", REQUIRES_CUSTOMER_ACTION: "ACTION_REQUIRED",
  PROCESSING: "UNKNOWN", REQUIRES_CAPTURE: "AUTHORIZED", PARTIALLY_CAPTURED: "SUCCEEDED", SUCCEEDED: "SUCCEEDED",
  FAILED: "DECLINED", CANCELED: "NO_EFFECT", EXPIRED: "NO_EFFECT",
};
const BRANDS = ["visa", "mastercard", "amex"];

function pick<T>(rand: () => number, weighted: [T, number][]): T {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of weighted) {
    if ((r -= w) < 0) return v;
  }
  return weighted[0]![0];
}

function hexId(rand: () => number, ms: number): string {
  // UUIDv7-shaped: 48-bit timestamp then random bits (ADR 0001 §6), without dashes.
  const ts = Math.floor(ms).toString(16).padStart(12, "0");
  let rest = "7";
  while (rest.length < 20) rest += Math.floor(rand() * 16).toString(16);
  return ts + rest;
}

function timeline(rand: () => number, p: Omit<Payment, "timeline">, createdMs: number): EvidenceEvent[] {
  const at = (offsetSec: number) => new Date(createdMs + offsetSec * 1000).toISOString();
  const op = `op_${hexId(rand, createdMs)}`;
  const ev: EvidenceEvent[] = [
    { at: at(0), type: "intent.created", status: "REQUIRES_PAYMENT_METHOD", source: "gateway", provenance: "internal_record" },
    { at: at(4), type: "intent.confirmed", status: "PROCESSING", source: "gateway", provenance: "internal_record", operationId: op },
  ];
  switch (p.status) {
    case "SUCCEEDED":
      ev.push({ at: at(9), type: "provider.authorized", status: "REQUIRES_CAPTURE", source: p.connector, provenance: "provider_confirmed", operationId: op });
      ev.push({ at: at(12), type: "provider.captured", status: "SUCCEEDED", source: p.connector, provenance: "provider_confirmed", operationId: op,
        note: "Not proof of bank settlement (06-01)." });
      break;
    case "FAILED":
      ev.push({ at: at(8), type: "provider.declined", status: "FAILED", source: p.connector, provenance: "provider_confirmed", operationId: op });
      break;
    case "PROCESSING":
      ev.push({ at: at(30), type: "provider.timeout", status: "PROCESSING", source: p.connector, provenance: "pending_evidence", operationId: op,
        note: "Outcome unknown: awaiting provider inquiry. Not a failure (06-01)." });
      break;
    case "REQUIRES_CAPTURE":
      ev.push({ at: at(9), type: "provider.authorized", status: "REQUIRES_CAPTURE", source: p.connector, provenance: "provider_confirmed", operationId: op });
      break;
    case "PARTIALLY_CAPTURED":
      ev.push({ at: at(9), type: "provider.authorized", status: "REQUIRES_CAPTURE", source: p.connector, provenance: "provider_confirmed", operationId: op });
      ev.push({ at: at(600), type: "provider.partial_capture", status: "PARTIALLY_CAPTURED", source: p.connector, provenance: "provider_confirmed", operationId: op });
      break;
    case "REQUIRES_CUSTOMER_ACTION":
      ev.push({ at: at(6), type: "provider.action_required", status: "REQUIRES_CUSTOMER_ACTION", source: p.connector, provenance: "provider_confirmed", operationId: op });
      break;
    case "CANCELED":
      ev.push({ at: at(120), type: "intent.canceled", status: "CANCELED", source: "gateway", provenance: "internal_record" });
      break;
    case "EXPIRED":
      ev.push({ at: at(3600), type: "intent.expired", status: "EXPIRED", source: "execution", provenance: "internal_record" });
      break;
    default:
      break;
  }
  return ev;
}

export interface FixtureDataset {
  generatedAt: string;
  payments: Payment[];
  payouts: Payout[];
  settlementBatches: SettlementBatch[];
  activity: ActivityEvent[];
}

const AMOUNT_RANGES: Record<string, [number, number]> = { GBP: [499, 189_00], EUR: [599, 219_00], USD: [699, 249_00] };

export function generateFixtures(now = Date.now(), seed = 20261110): FixtureDataset {
  const rand = mulberry32(seed);
  const payments: Payment[] = [];
  const DAY = 86_400_000;

  for (let i = 0; i < 1400; i++) {
    const merchant = MERCHANTS[Math.floor(rand() * MERCHANTS.length)]!;
    const currency = merchant.currencies[Math.floor(rand() * merchant.currencies.length)]!;
    // Skew toward recent hours so 24h and 7d views have shape.
    const ageMs = Math.pow(rand(), 1.6) * 30 * DAY;
    const createdMs = now - ageMs;
    const [lo, hi] = AMOUNT_RANGES[currency]!;
    const amount = Math.round(lo + Math.pow(rand(), 2.2) * (hi - lo));
    const status = pick(rand, STATUS_WEIGHTS);
    const riskScore = Math.round(rand() * 100);
    const outcome = riskScore > 97 ? "blocked" : riskScore > 90 ? "review" : "pass";
    const base: Omit<Payment, "timeline"> = {
      id: `pi_${hexId(rand, createdMs)}`,
      tenantId: merchant.tenantId,
      merchantId: merchant.id,
      legalEntityId: merchant.legalEntityId,
      environment: "TEST",
      amountMinor: String(amount),
      currency,
      status: outcome === "blocked" ? "FAILED" : status,
      attemptStatus: ATTEMPT_FOR[outcome === "blocked" ? "FAILED" : status],
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(createdMs + 12_000).toISOString(),
      method: { type: "card", brand: BRANDS[Math.floor(rand() * BRANDS.length)]!, last4: String(1000 + Math.floor(rand() * 9000)) },
      customerEmail: `customer${i}@example.test`,
      risk: { score: riskScore, outcome },
      connector: "mockpsp",
    };
    payments.push({ ...base, timeline: timeline(rand, base, createdMs) });
  }
  payments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const makers = [
    { sub: localUserId(3), name: "Jordan Pike" }, // fin.controller.a (PFIN)
    { sub: localUserId(4), name: "Sam Okafor" }, // fin.controller.b (PFIN)
  ];
  const payouts: Payout[] = [];
  for (let i = 0; i < 26; i++) {
    const merchant = MERCHANTS[i % MERCHANTS.length]!;
    const currency = merchant.currencies[0]!;
    const createdMs = now - (i < 9 ? rand() * 2 * DAY : (2 + rand() * 20) * DAY);
    const maker = makers[i % 2]!;
    const pending = i < 9;
    const status = pending ? "REQUIRES_APPROVAL" : (["SUCCEEDED", "SUCCEEDED", "PROVIDER_ACCEPTED", "CANCELED", "OUTCOME_UNKNOWN"] as const)[i % 5]!;
    const approved = !pending && status !== "CANCELED";
    const checker = makers[(i + 1) % 2]!;
    payouts.push({
      id: `po_${hexId(rand, createdMs)}`,
      version: 1,
      tenantId: merchant.tenantId,
      merchantId: merchant.id,
      legalEntityId: merchant.legalEntityId,
      environment: "TEST",
      amountMinor: String(Math.round(25_000 + rand() * 4_000_000)),
      currency,
      beneficiaryId: `ben_${hexId(rand, createdMs).slice(-12)}`,
      beneficiaryLabel: `${merchant.displayName} operating account ••${String(10 + Math.floor(rand() * 89))}`,
      purposeCode: "MERCHANT_SETTLEMENT",
      status,
      approvalStatus: pending ? "PENDING" : approved ? "APPROVED" : "REJECTED",
      externalEvidenceStatus: status === "SUCCEEDED" ? "VERIFIED" : "UNVERIFIED",
      latestOperationId: `op_${hexId(rand, createdMs)}`,
      makerSub: maker.sub,
      makerName: maker.name,
      ...(pending ? {} : { checkerSub: checker.sub, checkerName: checker.name, decidedAt: new Date(createdMs + 3_600_000).toISOString() }),
      approvalDeadline: new Date(createdMs + (i === 8 ? 60_000 : 3 * DAY)).toISOString(),
      gates: [
        { name: "maker_checker", state: pending ? "PENDING" : "PASSED" },
        { name: "funds", state: i === 3 ? "PENDING" : "PASSED" },
        { name: "sanctions", state: "PASSED" },
        { name: "policy", state: "PASSED" },
      ],
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(createdMs).toISOString(),
    });
  }
  payouts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const settlementBatches: SettlementBatch[] = [];
  for (let d = 1; d <= 14; d++) {
    for (const m of MERCHANTS) {
      const r = rand();
      settlementBatches.push({
        id: `stl_${m.id.slice(4)}_${d}`,
        tenantId: m.tenantId, merchantId: m.id, legalEntityId: m.legalEntityId, environment: "TEST",
        currency: m.currencies[0]!,
        date: new Date(now - d * DAY).toISOString().slice(0, 10),
        status: d <= 1 ? "AWAITING_EVIDENCE" : r > 0.95 ? "EXCEPTION" : "RECONCILED",
      });
    }
  }

  const activity: ActivityEvent[] = [];
  const succeeded = payments.filter((p) => p.status === "SUCCEEDED").slice(0, 6);
  succeeded.forEach((p, i) =>
    activity.push({ id: `act_pay_${i}`, at: p.updatedAt, kind: "payment_settled", title: "Payment captured",
      resource: { type: "payment", id: p.id }, tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST" }));
  payments.filter((p) => p.risk.outcome !== "pass").slice(0, 4).forEach((p, i) =>
    activity.push({ id: `act_risk_${i}`, at: p.createdAt, kind: "risk_alert", title: p.risk.outcome === "blocked" ? "Payment blocked by risk screening" : "Payment flagged for risk review",
      resource: { type: "payment", id: p.id }, tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST" }));
  payouts.filter((p) => p.status === "SUCCEEDED").slice(0, 3).forEach((p, i) =>
    activity.push({ id: `act_po_${i}`, at: p.decidedAt ?? p.createdAt, kind: "payout_completed", title: "Payout succeeded",
      resource: { type: "payout", id: p.id }, tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST" }));
  MERCHANTS.slice(0, 2).forEach((m, i) =>
    activity.push({ id: `act_app_${i}`, at: new Date(now - (i + 1) * 5 * 3_600_000).toISOString(), kind: "merchant_application", title: "Merchant capability application received",
      resource: { type: "merchant", id: m.id }, tenantId: m.tenantId, merchantId: m.id, legalEntityId: m.legalEntityId, environment: "TEST" }));
  payments.filter((p) => p.status === "SUCCEEDED").slice(10, 12).forEach((p, i) =>
    activity.push({ id: `act_ref_${i}`, at: new Date(Math.min(now, Date.parse(p.updatedAt) + 7_200_000)).toISOString(), kind: "refund_review", title: "Refund request under review",
      resource: { type: "refund", id: `re_${p.id.slice(3)}` }, tenantId: p.tenantId, merchantId: p.merchantId, legalEntityId: p.legalEntityId, environment: "TEST" }));
  activity.sort((a, b) => b.at.localeCompare(a.at));

  return { generatedAt: new Date(now).toISOString(), payments, payouts, settlementBatches, activity };
}
