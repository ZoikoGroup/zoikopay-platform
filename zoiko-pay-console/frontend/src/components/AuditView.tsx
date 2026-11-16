import { Link2, Link2Off } from "lucide-react";
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { api } from "../services/api";
import { formatDateTimeFull } from "../services/format";
import { EmptyState, ErrorState, StaleIndicator, TableSkeleton } from "./States";
import { StatusBadge } from "./StatusBadge";

/** Audit evidence: privileged actions, decisions and every denial, hash-chained. */
export function AuditView() {
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const q = { action: action || undefined, outcome: outcome || undefined, limit: 300 };
  const res = useApi((s) => api.audit(q, s), JSON.stringify(q), { refreshMs: 30_000 });
  const v = res.data?.verification;
  return (
    <div className="stack">
      {v && (
        <div className="banner" data-tone={v.valid ? undefined : "strong"} role="status">
          {v.valid ? <Link2 size={16} aria-hidden="true" /> : <Link2Off size={16} aria-hidden="true" />}
          <span><strong>{v.valid ? "Hash chain verified." : `Hash chain broken at entry ${v.brokenAt}.`}</strong> {v.checked} entries checked.
            Development limitation: held in the backend's memory; durable evidence storage belongs to BC-08.</span>
        </div>
      )}
      <div className="card">
        <div className="filters">
          <select className="select" aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            <option value="auth.">Sign-in and password confirmation</option>
            <option value="screen.">Screen decisions and reads</option>
            <option value="sandbox.">Sandbox requests</option>
            <option value="payments.">Payment reads</option>
            <option value="session.">Environment changes</option>
          </select>
          <select className="select" aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All outcomes</option>
            {["SUCCEEDED", "ALLOWED", "DENIED", "FAILED"].map((o) => <option key={o}>{o}</option>)}
          </select>
          <span style={{ marginLeft: "auto" }}><StaleIndicator stale={res.stale} loadedAt={res.loadedAt} onRefresh={res.refetch} /></span>
        </div>
        {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !res.data ? <TableSkeleton /> : res.data.items.length === 0 ? (
          <EmptyState title="No entries">Sign-ins, decisions and denied requests appear here.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Audit entries, newest first</caption>
              <thead><tr><th className="right">#</th><th>Time</th><th>Actor</th><th>Action</th><th>Outcome</th><th>Resource</th><th>Detail</th><th>Hash</th></tr></thead>
              <tbody>
                {res.data.items.map((e) => (
                  <tr key={e.seq}>
                    <td className="right num subtle">{e.seq}</td>
                    <td className="num">{formatDateTimeFull(e.at)}</td>
                    <td className="mono">{e.actorUsername}</td>
                    <td className="mono">{e.action}</td>
                    <td><StatusBadge status={e.outcome} /></td>
                    <td className="mono">{e.resource ? e.resource.id.slice(0, 24) : "—"}</td>
                    <td className="mono subtle" style={{ fontSize: "var(--fs-2xs)", whiteSpace: "normal", maxWidth: 300 }}>
                      {e.detail ? Object.entries(e.detail).map(([k, val]) => `${k}=${val}`).join(" ") : "—"}
                    </td>
                    <td className="mono subtle" title={e.hash}>{e.hash.slice(0, 10)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
