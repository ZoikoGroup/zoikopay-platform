/**
 * Money helpers. Amounts are base-10 strings of integer minor units
 * (ADR 0001 §3) and are only ever combined with BigInt, never floats.
 * Amounts in different currencies are never added together.
 */
const MINOR = /^-?\d{1,30}$/;

export function isMinorString(s: string): boolean {
  return MINOR.test(s);
}

export function sumMinor(values: Iterable<string>): string {
  let total = 0n;
  for (const v of values) {
    if (!isMinorString(v)) throw new Error(`invalid minor amount: ${v}`);
    total += BigInt(v);
  }
  return total.toString();
}

export function compareMinor(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
