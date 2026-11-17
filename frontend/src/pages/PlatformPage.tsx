import { Card, PageHead } from "../components/Card";
import { ErrorState, Skeleton, SourceBadge, StaleIndicator } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useApi } from "../hooks/useApi";
import { api } from "../services/api";
import { formatCount, formatTime, humanize } from "../services/format";

/** What 03-05 §10.1 and related specs forbid this role. Shown so nobody mistakes this page for a back door. */
const LIMITS: { text: string; ref: string }[] = [
  { text: "Read merchant transactions or customer personal data", ref: "03-05 §10.1" },
  { text: "See payment-provider secrets or keys", ref: "03-05 §10.1" },
  { text: "Move money, approve payouts or edit the ledger", ref: "03-05 §10.1, 04-05" },
  { text: "Bypass tenant, legal-entity or environment boundaries", ref: "02-02 §0.3" },
  { text: "Override legal or regulatory holds", ref: "07-02" },
  { text: "Force a payment status or approve their own change", ref: "04-02 CT-010, 02-02" },
];

/** Super Admin coordination page: health, counts and redacted tenant metadata (03-05 §10.1). */
export function PlatformPage() {
  const summary = useApi((s) => api.platformSummary(s), "platform-summary", { refreshMs: 60_000 });
  const health = useApi((s) => api.systemHealth(s), "platform-health", { refreshMs: 30_000 });
  const d = summary.data;
  const services = health.data?.services ?? [];
  const healthy = services.filter((s) => s.ok).length;

  return (
    <>
      <PageHead
        title="Super Admin"
        screen={<><span className="chip">03-05 §10.1</span><span className="chip">Super Admin</span><span className="chip">Read-only</span></>}
        description="Coordinate the platform: service health, counts and organisation identifiers. This role cannot see transactions, customers, money amounts or secrets."
        actions={<><SourceBadge source={summary.meta?.source} /><StaleIndicator stale={summary.stale} loadedAt={summary.loadedAt} onRefresh={summary.refetch} /></>}
      />

      {/* Counts can be refused (LIVE has no data source) while live health still loads, so the error replaces only the counts. */}
      <div className="stack" style={{ gap: "var(--s-4)" }}>
          {summary.error ? (
            <div className="card"><ErrorState error={summary.error} onRetry={summary.refetch} /></div>
          ) : (
          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }} aria-label="Platform totals">
            {[
              { label: "Organisations", value: d?.totals.organisations },
              { label: "Merchants", value: d?.totals.merchants },
              { label: "Payments (count)", value: d?.totals.payments },
              { label: "Waiting for a decision", value: d?.totals.awaitingDecision },
              { label: "People with a role", value: d?.totals.people },
            ].map((k) => (
              <div key={k.label} className="card kpi" style={{ minHeight: 0 }}>
                <span className="eyebrow">{k.label}</span>
                {k.value === undefined ? <Skeleton height={28} width={60} /> : <span className="kpi-value num">{formatCount(k.value)}</span>}
              </div>
            ))}
          </div>
          )}

          <div className="grid grid-12">
            <Card className="span-8" id="services" title="Service health"
              eyebrow={health.data?.lastCheck ? `Last check ${formatTime(health.data.lastCheck)} · every ${health.data.intervalSeconds}s` : "Live probes"}
              actions={health.data && <span className="badge">{healthy} of {services.length} healthy</span>} flush>
              {health.error ? <ErrorState error={health.error} onRetry={health.refetch} /> : !health.data ? <div style={{ padding: 20 }}><Skeleton height={180} /></div> : (
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">Service health, measured live by the console backend</caption>
                    <thead><tr><th>Service</th><th>Type</th><th>Status</th><th>Checks</th><th className="right">Response</th><th className="right">Availability</th></tr></thead>
                    <tbody>
                      {services.map((s) => (
                        <tr key={s.name}>
                          <td className="mono">{s.name}</td>
                          <td>{humanize(s.category)}</td>
                          <td><StatusBadge status={s.ok ? "ok" : "degraded"} label={s.ok ? "Operational" : humanize(s.status)} /></td>
                          <td className="subtle">{Object.entries(s.checks).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"}</td>
                          <td className="right num">{s.latencyMs === null ? "—" : `${s.latencyMs} ms`}</td>
                          <td className="right num">{s.availability ? `${s.availability.percent}%` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="span-4" id="limits" title="This role cannot" eyebrow="Enforced by the server" flush>
              <ul className="list-plain">
                {LIMITS.map((l) => (
                  <li key={l.text} className="list-row">
                    <span className="grow">{l.text}<span className="cell-sub subtle" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{l.ref}</span></span>
                  </li>
                ))}
                <li className="list-row"><span className="grow subtle" style={{ fontSize: "var(--fs-xs)" }}>Deeper access goes through exceptional access (03-05 §10.2): Support or SRE request it for a ticket, Security approves, it is time-limited, masked and reviewed. Super Admin sees only the counts below.</span></li>
              </ul>
            </Card>

            {!summary.error && (<>
            <Card className="span-6" id="cells" title="Legal cells" eyebrow="Counts per cell" flush>
              {!d ? <div style={{ padding: 20 }}><Skeleton height={100} /></div> : (
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">Organisations, merchants and payments per legal cell</caption>
                    <thead><tr><th>Cell</th><th>Jurisdiction</th><th className="right">Organisations</th><th className="right">Merchants</th><th className="right">Payments</th></tr></thead>
                    <tbody>
                      {d.cells.map((c) => (
                        <tr key={c.id}>
                          <td><span className="mono">{c.id}</span><span className="cell-sub subtle" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{c.name}</span></td>
                          <td>{c.jurisdiction}</td>
                          <td className="right num">{formatCount(c.organisations)}</td>
                          <td className="right num">{formatCount(c.merchants)}</td>
                          <td className="right num">{formatCount(c.payments)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="span-6" id="orgs" title="Organisations" eyebrow="Redacted: identifier, name and cells only" flush>
              {!d ? <div style={{ padding: 20 }}><Skeleton height={100} /></div> : (
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">Organisations, redacted to identifiers</caption>
                    <thead><tr><th>Organisation</th><th>Cells</th><th className="right">Merchants</th><th>Environment</th></tr></thead>
                    <tbody>
                      {d.organisations.map((o) => (
                        <tr key={o.id}>
                          <td>{o.name}<span className="cell-sub subtle mono" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{o.id}</span></td>
                          <td><span className="row" style={{ flexWrap: "wrap", gap: 6 }}>{o.cells.map((c) => <span key={c} className="chip mono">{c}</span>)}</span></td>
                          <td className="right num">{formatCount(o.merchants)}</td>
                          <td>{o.environments.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="span-6" id="awaiting" title="Waiting for a decision" eyebrow="Counts per screen; decisions belong to the named roles" flush>
              {!d ? <div style={{ padding: 20 }}><Skeleton height={100} /></div> : d.awaiting.length === 0 ? (
                <p className="subtle" style={{ padding: 20 }}>Nothing is waiting.</p>
              ) : (
                <ul className="list-plain">
                  {d.awaiting.map((a) => (
                    <li key={a.screenId} className="list-row" style={{ alignItems: "center" }}>
                      <span className="grow">{a.title}<span className="cell-sub subtle mono" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{a.screenId}</span></span>
                      <span className="num">{formatCount(a.count)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="span-6" id="roles" title="People per role" eyebrow="Counts only; names are not shown" flush>
              {!d ? <div style={{ padding: 20 }}><Skeleton height={100} /></div> : (
                <ul className="list-plain">
                  {d.roles.map((r) => (
                    <li key={r.persona} className="list-row" style={{ alignItems: "center" }}>
                      <span className="grow">{r.label}<span className="cell-sub subtle mono" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{r.persona}</span></span>
                      <span className="num">{formatCount(r.count)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="span-12" id="exceptional" title="Exceptional access" eyebrow="Counts only (ADR 0004); tickets and records are visible to Security">
              {!d ? <Skeleton height={60} /> : (
                <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
                  {[
                    { label: "Waiting for approval", value: d.exceptionalAccess.waiting },
                    { label: "Active now", value: d.exceptionalAccess.active },
                    { label: "Review due", value: d.exceptionalAccess.reviewDue },
                    { label: "Review overdue", value: d.exceptionalAccess.reviewOverdue },
                  ].map((k) => (
                    <div key={k.label} style={{ display: "grid", gap: 4 }}>
                      <span className="eyebrow">{k.label}</span>
                      <span className="kpi-value num">{formatCount(k.value)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="span-12" id="signals" title="Security signals" eyebrow={d ? `Last ${d.signals.windowHours} hours · counts from the audit log` : "Audit log"}
              actions={d && <StatusBadge status={d.signals.auditChain.valid ? "ok" : "failed"}
                label={d.signals.auditChain.valid ? `Audit chain intact · ${formatCount(d.signals.auditChain.entries)} entries` : "Audit chain broken"} />}>
              {!d ? <Skeleton height={60} /> : (
                <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
                  {d.signals.items.map((s) => (
                    <div key={s.key} style={{ display: "grid", gap: 4 }}>
                      <span className="eyebrow">{s.label}</span>
                      <span className="kpi-value num">{formatCount(s.count)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            </>)}
          </div>
          {d && <p className="subtle" style={{ fontSize: "var(--fs-2xs)" }}>{d.environmentNote} Health is measured live. Each visit to this page is recorded in the audit log.</p>}
      </div>
    </>
  );
}
