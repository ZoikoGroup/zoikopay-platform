/**
 * Shared helpers for the console screen fixtures (registry.ts, finance.ts).
 * DEVELOPMENT FIXTURES only: deterministic, fictional TEST data.
 */
import { devUserId } from "../integrations/directory.js";
import type { Merchant } from "../types/domain.js";
import type { Money, ScreenRecord } from "./types.js";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** Small seeded PRNG so every run produces the same dataset. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
export const iso = (ms: number) => new Date(ms).toISOString();
export const money = (minor: number | bigint | string, currency: string): Money => ({ minor: String(minor), currency });
export const people = {
  ops: { sub: devUserId(2), name: "Rowan Hale" },
  finA: { sub: devUserId(3), name: "Jordan Pike" },
  finB: { sub: devUserId(4), name: "Sam Okafor" },
  risk: { sub: devUserId(5), name: "Morgan Reyes" },
  sec: { sub: devUserId(7), name: "Riley Ward" },
  owner: { sub: devUserId(10), name: "Harper Vale" },
  mops: { sub: devUserId(11), name: "Emery Holt" },
  comp: { sub: devUserId(13), name: "Kai Brennan" },
  mfin: { sub: devUserId(14), name: "Ari Lowe" },
  recon: { sub: devUserId(16), name: "Tali Ross" },
};
export const scope = (m: Merchant) => ({ tenantId: m.tenantId, merchantId: m.id, legalEntityId: m.legalEntityId, environment: "TEST" as const });
export const count = (rows: ScreenRecord[], ...statuses: string[]) => String(rows.filter((r) => statuses.includes(r.status)).length);
export const country = (cell: string) => (cell === "cell_uk_01" ? "United Kingdom" : "European Union");

/**
 * "12.50" → "1250" for a two-decimal currency. Exact string arithmetic, no
 * floats (ADR 0001). Null for anything that is not a positive amount with at
 * most two decimals and at most 13 integer digits.
 */
export function toMinor(major: string): string | null {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(major.trim());
  const whole = m?.[1];
  if (!m || !whole) return null;
  const minor = BigInt(whole) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return minor > 0n ? minor.toString() : null;
}
