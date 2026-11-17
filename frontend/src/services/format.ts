/**
 * Display formatting. Money arrives as integer minor units in a string
 * (ADR 0001 §3). It is converted to a decimal *string* and handed to
 * Intl.NumberFormat, which formats decimal strings exactly, so no amount ever
 * passes through a floating-point number.
 */

const LOCALE = "en-GB";

export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "123456", "GBP" → "1234.56" (exact). */
export function minorToDecimalString(amountMinor: string, currency: string): string {
  if (!/^-?\d+$/.test(amountMinor)) throw new Error(`invalid minor amount: ${amountMinor}`);
  const exp = currencyExponent(currency);
  const neg = amountMinor.startsWith("-");
  const digits = (neg ? amountMinor.slice(1) : amountMinor).replace(/^0+(?=\d)/, "");
  if (exp === 0) return (neg ? "-" : "") + digits;
  const padded = digits.padStart(exp + 1, "0");
  return `${neg ? "-" : ""}${padded.slice(0, -exp)}.${padded.slice(-exp)}`;
}

export function formatMoney(amountMinor: string, currency: string, opts: { compact?: boolean; withCode?: boolean } = {}): string {
  const decimal = minorToDecimalString(amountMinor, currency);
  const nf = new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    currencyDisplay: opts.withCode ? "code" : "narrowSymbol",
    ...(opts.compact ? { notation: "compact", maximumFractionDigits: 1 } : {}),
  });
  // Intl.NumberFormat accepts exact decimal strings (ES2023).
  return nf.format(decimal as unknown as number);
}

export function formatCount(value: string | number): string {
  return new Intl.NumberFormat(LOCALE).format(typeof value === "string" ? (BigInt(value) as unknown as number) : value);
}

const dt = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const dtFull = new Intl.DateTimeFormat(LOCALE, {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short",
});
const timeOnly = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
const dayOnly = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "short" });

export const formatDateTime = (iso: string) => dt.format(new Date(iso));
export const formatDateTimeFull = (iso: string) => dtFull.format(new Date(iso));
export const formatTime = (iso: string) => timeOnly.format(new Date(iso));
export const formatDay = (iso: string) => dayOnly.format(new Date(iso));

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86_400), "day");
}

/** "SUCCEEDED" → "Succeeded", "REQUIRES_CUSTOMER_ACTION" → "Requires customer action". */
export function humanize(code: string): string {
  const s = code.replaceAll("_", " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function shortId(id: string, keep = 10): string {
  const [prefix, rest = ""] = id.split(/_(.*)/s);
  return rest.length > keep ? `${prefix}_${rest.slice(0, keep)}…` : id;
}

/** Percentage change between two decimal-string counts or percentages, one decimal. */
export function percentChange(current: string, previous: string): string | null {
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  const v = ((c - p) / p) * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}

/** Change for money values, computed with BigInt (basis points). */
export function percentChangeMinor(current: string, previous: string): string | null {
  const c = BigInt(current);
  const p = BigInt(previous);
  if (p === 0n) return null;
  const bp = ((c - p) * 10_000n) / p; // basis points, truncated
  const neg = bp < 0n;
  const abs = neg ? -bp : bp;
  return `${neg ? "−" : "+"}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0").slice(0, 1)}%`;
}
