import { Banknote, Building2, CircleAlert, ShieldCheck, Undo2, Wallet } from "lucide-react";
import { useState } from "react";
import { Card } from "../components/Card";
import { ActivityChart, Breakdown } from "../components/charts";
import { KpiCard } from "../components/KpiCard";
import { PaymentDrawer, PaymentsTable } from "../components/payments";
import { Segmented } from "../components/Segmented";
import { EmptyState, ErrorState, NoPermission, Skeleton, SourceBadge, StaleIndicator } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { WorldMap } from "../components/WorldMap";
import { useApi } from "../hooks/useApi";
import { useSession } from "../hooks/useSession";
import { api } from "../services/api";
import { formatCount, formatRelative, formatTime, humanize } from "../services/format";
import type { Period, RecentActivityItem } from "../types/api";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const ACTIVITY_ICON: Record<RecentActivityItem["kind"], typeof Wallet> = {
  payment_settled: Wallet, merchant_application: Building2, refund_review: Undo2, payout_completed: Banknote,
  risk_alert: CircleAlert, approval: ShieldCheck,
};

export function OverviewPage() {
  const { me, can, selection } = useSession();
  const [period, setPeriod] = useState<Period>("7d");
  const [openPayment, setOpenPayment] = useState<string>();
  const params = { period, currency: selection.currency, merchantId: selection.merchantId || undefined };
  const pkey = JSON.stringify(params);

  const kpis = useApi((s) => api.kpis(params, s), `kpi${pkey}`);
  const activity = useApi(can("metrics.counts.view") ? (s) => api.activity(params, s) : null, `act${pkey}`);
  const recent = useApi((s) => api.recentActivity(s), "recent");
  const health = useApi(can("health.view") ? (s) => api.systemHealth(s) : null, "health", { refreshMs: 30_000 });
  if (!me) return null;

  const firstName = me.displayName.split(" ")[0];
  const k = Object.fromEntries((kpis.data?.kpis ?? []).map((x) => [x.key, x]));
  const succeeded = activity.data?.buckets.reduce((s, b) => s + b.succeeded, 0) ?? 0;
  const failed = activity.data?.buckets.reduce((s, b) => s + b.failed, 0) ?? 0;
  const healthy = health.data?.services.filter((s) => s.ok).length ?? 0;
  const periodWord = period === "24h" ? "24 hours" : period === "7d" ? "7 days" : "30 days";

  return (
    <div className="stack" style={{ gap: "var(--s-5)" }}>
      <section className="card welcome" aria-labelledby="welcome-h">
        <WorldMap />
        <div className="welcome-text">
          <span className="eyebrow">Global payment operations · {me.environment}</span>
          <h1 id="welcome-h">{greeting()}, {firstName}</h1>
          <p className="muted">
            {k.succeeded?.value != null
              ? <>{formatCount(k.succeeded.value)} payments succeeded in the last {periodWord}</>
              : <>Signed in as {me.personas.join(", ") || "no role"}</>}
            {k.pending_approvals?.value != null && <> · {k.pending_approvals.value} payouts awaiting approval</>}
            {health.data && <> · {healthy} of {health.data.services.length} services healthy</>}
          </p>
          <div className="row" style={{ marginTop: 4 }}>
            <SourceBadge source={kpis.meta?.source} />
            <span className="subtle" style={{ fontSize: "var(--fs-2xs)" }}>Amounts and counts are development fixtures for TEST. Health is measured live.</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="kpi-h" className="stack" style={{ gap: 12 }}>
        <div className="row-between">
          <h2 id="kpi-h">Key indicators</h2>
          <div className="row">
            <StaleIndicator stale={kpis.stale} loadedAt={kpis.loadedAt} onRefresh={kpis.refetch} />
            <Segmented<Period> label="Period" value={period} onChange={setPeriod}
              options={[{ value: "24h", label: "24H" }, { value: "7d", label: "7D" }, { value: "30d", label: "30D" }]} />
          </div>
        </div>
        {kpis.error ? (
          <div className="card"><ErrorState error={kpis.error} onRetry={kpis.refetch} /></div>
        ) : (
          <div className="kpi-grid">
            {kpis.data
              ? kpis.data.kpis.map((x) => <KpiCard key={x.key} kpi={x} period={period} asOf={kpis.meta?.asOf} source={kpis.meta?.source} />)
              : Array.from({ length: 6 }, (_, i) => <div key={i} className="card kpi"><Skeleton width="50%" /><Skeleton height={30} width="70%" /><Skeleton height={28} /></div>)}
          </div>
        )}
      </section>

      <div className="grid grid-12">
        <Card className="span-8" id="activity" title="Payment activity" eyebrow={`Last ${periodWord} · ${selection.currency}`}
          actions={<><SourceBadge source={activity.meta?.source} /><StaleIndicator stale={activity.stale} loadedAt={activity.loadedAt} onRefresh={activity.refetch} /></>}>
          {!can("metrics.counts.view") ? (
            <NoPermission>Payment activity is aggregate operating data that your role does not include.</NoPermission>
          ) : activity.error ? (
            <ErrorState error={activity.error} onRetry={activity.refetch} />
          ) : !activity.data ? (
            <Skeleton height={220} />
          ) : (
            <div className="stack" style={{ gap: 20 }}>
              <ActivityChart buckets={activity.data.buckets} period={period} currency={activity.data.currency} amountsVisible={activity.data.amountsVisible} />
              <div className="detail-grid" style={{ alignItems: "end" }}>
                <div className="stack" style={{ gap: 4 }}>
                  <span className="eyebrow">Transactions</span>
                  <span className="kpi-value" style={{ fontSize: "var(--fs-xl)" }}>{formatCount(activity.data.buckets.reduce((s, b) => s + b.count, 0))}</span>
                </div>
                <Breakdown succeeded={succeeded} failed={failed} />
              </div>
              {!activity.data.amountsVisible && <p className="subtle" style={{ fontSize: "var(--fs-xs)" }}>Volume is hidden: money amounts are not part of your role.</p>}
            </div>
          )}
        </Card>

        <Card className="span-4" id="health" title="System health" eyebrow={health.data?.lastCheck ? `Last check ${formatTime(health.data.lastCheck)}` : "Live probes"}
          actions={can("health.view") ? <SourceBadge source={health.meta?.source} /> : undefined} flush>
          {!can("health.view") ? (
            <NoPermission>System health is visible to operations, security and administration roles.</NoPermission>
          ) : health.error ? (
            <ErrorState error={health.error} onRetry={health.refetch} />
          ) : !health.data ? (
            <div style={{ padding: 20 }}><Skeleton height={140} /></div>
          ) : (
            <ul className="list-plain">
              {[
                { label: "API services", rows: health.data.services.filter((s) => s.category === "api") },
                { label: "Payment connectors", rows: health.data.services.filter((s) => s.category === "connector") },
                { label: "Core services", rows: health.data.services.filter((s) => s.category === "core") },
                { label: "Identity", rows: health.data.services.filter((s) => s.category === "identity") },
              ].map((g) => {
                const ok = g.rows.length > 0 && g.rows.every((r) => r.ok);
                const avail = g.rows.flatMap((r) => (r.availability ? [r.availability.percent] : []));
                return (
                  <li key={g.label} className="list-row" style={{ alignItems: "center" }}>
                    <span className="grow">{g.label}<span className="cell-sub subtle" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{g.rows.map((r) => r.name).join(", ") || "none configured"}</span></span>
                    {avail.length > 0 && <span className="num subtle" style={{ fontSize: "var(--fs-xs)" }}>{Math.min(...avail)}%</span>}
                    <StatusBadge status={g.rows.length === 0 ? "unknown" : ok ? "ok" : "degraded"} label={g.rows.length === 0 ? "Unknown" : ok ? "Operational" : "Degraded"} />
                  </li>
                );
              })}
              <li className="list-row" style={{ alignItems: "center" }}>
                <span className="grow">Database<span className="cell-sub subtle" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>as reported by {health.data.database.reportedBy.length} services</span></span>
                <StatusBadge status={health.data.database.status === "ok" ? "ok" : health.data.database.status} label={humanize(health.data.database.status === "ok" ? "operational" : health.data.database.status)} />
              </li>
            </ul>
          )}
        </Card>

        <Card className="span-8" id="transactions" title="Recent transactions" eyebrow="Select a row for details and evidence" flush>
          {can("payments.read")
            ? <PaymentsTable compact onOpen={setOpenPayment} selectedId={openPayment} />
            : <NoPermission>Transaction records are limited to merchant roles and Pay Operations (02-02 PAYMENT.READ).</NoPermission>}
        </Card>

        <Card className="span-4" id="recent" title="Recent activity" flush actions={<SourceBadge source={recent.meta?.source} />}>
          {recent.error ? (
            <ErrorState error={recent.error} onRetry={recent.refetch} />
          ) : !recent.data ? (
            <div style={{ padding: 20 }}><Skeleton height={200} /></div>
          ) : recent.data.length === 0 ? (
            <EmptyState title="No activity to show">Merchant activity is only shown to roles that can read payments.</EmptyState>
          ) : (
            <ul className="list-plain" aria-label="Recent activity">
              {recent.data.map((a) => {
                const Icon = ACTIVITY_ICON[a.kind];
                const body = (
                  <>
                    <span className="icon-ring"><Icon size={14} aria-hidden="true" /></span>
                    <span className="grow">
                      <span style={{ display: "block", fontSize: "var(--fs-sm)" }}>{a.title}</span>
                      <span className="mono subtle" style={{ fontSize: "var(--fs-2xs)" }}>{a.resource.id}</span>
                    </span>
                    <span className="subtle num" style={{ fontSize: "var(--fs-2xs)", whiteSpace: "nowrap" }}>{formatRelative(a.at)}</span>
                  </>
                );
                return (
                  <li key={a.id}>
                    {a.resource.type === "payment" ? (
                      <button className="list-row list-row-btn" onClick={() => setOpenPayment(a.resource.id)} aria-label={`${a.title}: open payment ${a.resource.id}`}>{body}</button>
                    ) : (
                      <div className="list-row">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {openPayment && <PaymentDrawer id={openPayment} onClose={() => setOpenPayment(undefined)} />}
    </div>
  );
}
