import { useId, useMemo, useState } from "react";
import { formatCount, formatDateTime, formatDay, formatMoney, formatTime } from "../services/format";
import type { ActivityBucket, Period } from "../types/api";

/** Minimal monochrome sparkline. Decorative: values are stated in text next to it. */
export function Sparkline({ values, height = 32 }: { values: number[]; height?: number }) {
  const id = useId();
  if (values.length < 2) return <div style={{ height }} aria-hidden="true" />;
  const w = 120;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, height - 2 - ((v - min) / (max - min || 1)) * (height - 4)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height }} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d}L${w},${height}L0,${height}Z`} fill={`url(#${id}-g)`} />
      <path d={d} fill="none" stroke="#fff" strokeWidth="1.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

const bucketLabel = (b: ActivityBucket, period: Period) => (period === "24h" ? formatTime(b.start) : formatDay(b.start));

/**
 * Payment activity: volume line (selected currency, when the role may see
 * amounts) over transaction-count bars. Keyboard: focus the chart, then use
 * ← → to move between buckets. A data table is available for screen readers.
 */
export function ActivityChart({ buckets, period, currency, amountsVisible }: {
  buckets: ActivityBucket[];
  period: Period;
  currency: string;
  amountsVisible: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const W = 720;
  const H = 220;
  const pad = { t: 12, r: 8, b: 26, l: 8 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const { maxCount, maxVol, volPath, areaPath, xs } = useMemo(() => {
    const maxCount = Math.max(1, ...buckets.map((b) => b.count));
    // Converted to Number only to place points on screen; labels use exact strings.
    const vols = buckets.map((b) => (b.volumeMinor ? Number(b.volumeMinor) : 0));
    const maxVol = Math.max(1, ...vols);
    const step = iw / Math.max(1, buckets.length);
    const xs = buckets.map((_, i) => pad.l + step * i + step / 2);
    const ys = vols.map((v) => pad.t + ih - (v / maxVol) * ih * 0.92);
    const volPath = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${(ys[i] ?? 0).toFixed(1)}`).join("");
    const areaPath = `${volPath}L${xs.at(-1)},${pad.t + ih}L${xs[0]},${pad.t + ih}Z`;
    return { maxCount, maxVol, volPath, areaPath, xs };
  }, [buckets, iw, ih, pad.l, pad.t]);

  const step = iw / Math.max(1, buckets.length);
  const barW = Math.max(2, step * 0.56);
  const labelEvery = Math.ceil(buckets.length / 8);
  const a = active !== null ? buckets[active] : undefined;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-between">
        <div className="chart-legend" aria-hidden="true">
          {amountsVisible && <span className="legend-key"><span className="swatch-line" /> Volume ({currency}, succeeded)</span>}
          <span className="legend-key"><span className="swatch-bar" /> Transactions</span>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {asTable ? (
        <div className="table-wrap" style={{ maxHeight: 260 }}>
          <table className="table">
            <caption className="sr-only">Payment activity by {period === "24h" ? "hour" : "day"}</caption>
            <thead><tr><th>Period start</th><th className="right">Transactions</th><th className="right">Succeeded</th><th className="right">Failed</th>{amountsVisible && <th className="right">Volume</th>}</tr></thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.start}>
                  <td>{formatDateTime(b.start)}</td>
                  <td className="right num">{formatCount(b.count)}</td>
                  <td className="right num">{formatCount(b.succeeded)}</td>
                  <td className="right num">{formatCount(b.failed)}</td>
                  {amountsVisible && <td className="right num">{b.volumeMinor ? formatMoney(b.volumeMinor, currency) : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className="chart"
          tabIndex={0}
          role="img"
          aria-label={`Payment activity chart, ${buckets.length} ${period === "24h" ? "hours" : "days"}. Use left and right arrow keys to read each value.`}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setActive((i) => Math.min(buckets.length - 1, (i ?? -1) + 1));
            else if (e.key === "ArrowLeft") setActive((i) => Math.max(0, (i ?? buckets.length) - 1));
            else if (e.key === "Escape") setActive(null);
          }}
          onBlur={() => setActive(null)}
          onMouseLeave={() => setActive(null)}
        >
          <svg viewBox={`0 0 ${W} ${H}`} style={{ height: "auto", aspectRatio: `${W} / ${H}` }}>
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + ih * (1 - f)} y2={pad.t + ih * (1 - f)} stroke="var(--chart-grid)" />
            ))}
            {buckets.map((b, i) => {
              const h = (b.count / maxCount) * ih * 0.55;
              return (
                <rect key={b.start} x={(xs[i] ?? 0) - barW / 2} y={pad.t + ih - h} width={barW} height={h} rx={1.5}
                  fill={active === i ? "rgba(255,255,255,.42)" : "var(--chart-bar)"} />
              );
            })}
            {amountsVisible && maxVol > 1 && (
              <>
                <path d={areaPath} fill="var(--chart-area)" />
                <path d={volPath} fill="none" stroke="var(--chart-line)" strokeWidth={1.6} strokeLinejoin="round" />
              </>
            )}
            {buckets.map((b, i) => i % labelEvery === 0 && (
              <text key={b.start} x={xs[i]} y={H - 8} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,.58)">{bucketLabel(b, period)}</text>
            ))}
            {active !== null && <line x1={xs[active]} x2={xs[active]} y1={pad.t} y2={pad.t + ih} stroke="rgba(255,255,255,.5)" strokeDasharray="2 3" />}
            {buckets.map((b, i) => (
              <rect key={`hit-${b.start}`} x={pad.l + step * i} y={0} width={step} height={H} fill="transparent" onMouseEnter={() => setActive(i)} />
            ))}
          </svg>
          {a && active !== null && (
            <div className="chart-tooltip" style={{ left: `${((xs[active] ?? 0) / W) * 100}%`, top: 8 }} role="status" aria-live="polite">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{formatDateTime(a.start)}</div>
              {amountsVisible && a.volumeMinor && <div className="t-row"><span>Volume</span><strong>{formatMoney(a.volumeMinor, currency)}</strong></div>}
              <div className="t-row"><span>Transactions</span><strong>{formatCount(a.count)}</strong></div>
              <div className="t-row"><span>Succeeded / failed</span><strong>{a.succeeded} / {a.failed}</strong></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Succeeded vs failed share, solid vs hatched (no colour). */
export function Breakdown({ succeeded, failed }: { succeeded: number; failed: number }) {
  const total = succeeded + failed;
  const pct = total ? Math.round((succeeded / total) * 1000) / 10 : 0;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row-between" style={{ fontSize: "var(--fs-xs)" }}>
        <span className="legend-key"><span className="swatch-bar" style={{ background: "#fff" }} /> Succeeded <strong className="num">{formatCount(succeeded)}</strong></span>
        <span className="legend-key"><span className="swatch-hatch" /> Failed <strong className="num">{formatCount(failed)}</strong></span>
      </div>
      <div className="breakdown-bar" role="img" aria-label={`${pct}% succeeded of ${total} payments with a final outcome`}>
        <div className="seg-solid" style={{ width: `${pct}%` }} />
        <div className="seg-hatch" style={{ flex: 1 }} />
      </div>
    </div>
  );
}
