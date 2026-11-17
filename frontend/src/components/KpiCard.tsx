import { Info, Lock } from "lucide-react";
import { formatCount, formatMoney, formatTime, percentChange, percentChangeMinor } from "../services/format";
import type { Kpi, Period } from "../types/api";
import { Sparkline } from "./charts";

const PERIOD_LABEL: Record<Period, string> = { "24h": "previous 24 h", "7d": "previous 7 days", "30d": "previous 30 days" };

function display(k: Kpi): { main: string; unit?: string } {
  if (k.value === null) return { main: "—" };
  switch (k.unit) {
    case "minor":
      return { main: formatMoney(k.value, k.currency ?? "GBP"), unit: k.currency };
    case "percent":
      return { main: k.value, unit: "%" };
    case "count":
      return { main: formatCount(k.value) };
    default:
      return { main: k.value };
  }
}

export function KpiCard({ kpi, period, asOf, source }: { kpi: Kpi; period: Period; asOf?: string; source?: string }) {
  const v = display(kpi);
  const change =
    kpi.value !== null && kpi.previous !== null && kpi.unit !== "text"
      ? kpi.unit === "minor"
        ? percentChangeMinor(kpi.value, kpi.previous)
        : kpi.unit === "percent"
          ? `${(Number(kpi.value) - Number(kpi.previous) >= 0 ? "+" : "−")}${Math.abs(Number(kpi.value) - Number(kpi.previous)).toFixed(1)} pts`
          : percentChange(kpi.value, kpi.previous)
      : null;

  return (
    <article className="card kpi" aria-label={kpi.label}>
      <div className="row-between">
        <span className="eyebrow">{kpi.label}</span>
        {kpi.definition && (
          <span title={kpi.definition} aria-label={`Definition: ${kpi.definition}`} role="img" className="subtle" style={{ display: "inline-flex" }}>
            <Info size={13} />
          </span>
        )}
      </div>

      {kpi.restricted ? (
        <>
          <div className="kpi-value" style={{ color: "var(--text-3)" }}>—</div>
          <div className="kpi-restricted"><Lock size={13} aria-hidden="true" style={{ marginTop: 2 }} /><span>{kpi.restrictedReason ?? "Not permitted for your role."}</span></div>
        </>
      ) : (
        <>
          <div className="kpi-value">
            <span className={kpi.unit === "text" ? undefined : "figure"}>{v.main}</span>
            {v.unit && <span className="unit">{v.unit === "%" ? "%" : v.unit}</span>}
          </div>
          <div className="kpi-delta">
            {kpi.unit === "text" ? (
              <span>{kpi.previous}</span>
            ) : change ? (
              <span><strong className="num">{change}</strong> vs {PERIOD_LABEL[period]}</span>
            ) : (
              <span className="subtle">No comparison available</span>
            )}
          </div>
          {kpi.trend.length > 1 && <Sparkline values={kpi.trend} />}
          <div className="kpi-foot">
            <span>{asOf ? `As of ${formatTime(asOf)}` : ""}</span>
            <span>{source === "fixture" ? "Mock data" : source}</span>
          </div>
        </>
      )}
    </article>
  );
}
