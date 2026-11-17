import { formatMoney } from "../services/format";

/** Amount with its currency always visible (Business Requirements 07). */
export function Money({ minor, currency, compact }: { minor: string; currency: string; compact?: boolean }) {
  return (
    <span className="amount" aria-label={`${formatMoney(minor, currency, { withCode: true })}`}>
      {formatMoney(minor, currency, { compact })}
      <span className="ccy" aria-hidden="true">{currency}</span>
    </span>
  );
}
