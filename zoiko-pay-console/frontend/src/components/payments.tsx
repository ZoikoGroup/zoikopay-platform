import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useDebounced } from "../hooks/ui";
import { useSession } from "../hooks/useSession";
import { api, type PaymentQuery } from "../services/api";
import { formatDateTime, formatDateTimeFull, humanize, shortId } from "../services/format";
import { INTENT_STATUSES, type EvidenceEvent, type Payment } from "../types/api";
import { Money } from "./Money";
import { Drawer } from "./Overlay";
import { ErrorState, EmptyState, SourceBadge, StaleIndicator, TableSkeleton } from "./States";
import { StatusBadge, StatusGlyph } from "./StatusBadge";

const PROVENANCE_LABEL: Record<EvidenceEvent["provenance"], string> = {
  provider_confirmed: "Provider confirmed",
  internal_record: "Internal record",
  pending_evidence: "Pending evidence",
};

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="table-foot" aria-label="Pagination">
      <span className="num">{from}–{to} of {total.toLocaleString("en-GB")}</span>
      <div className="row">
        <button className="icon-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
        <span className="num">Page {page} of {pages}</span>
        <button className="icon-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
      </div>
    </nav>
  );
}

function SortHeader({ label, active, order, onClick, align }: { label: string; active: boolean; order: "asc" | "desc"; onClick: () => void; align?: "right" }) {
  return (
    <th className={align} aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button className="sort" onClick={onClick}>
        {label}
        {active ? (order === "asc" ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />) : null}
      </button>
    </th>
  );
}

/**
 * Payments table with search, status filter, sorting and pagination. Scope
 * (merchant, legal entity) comes from the header selection; the server applies
 * the caller's real scope regardless.
 */
export function PaymentsTable({ compact, onOpen, selectedId }: { compact?: boolean; onOpen: (id: string) => void; selectedId?: string }) {
  const { selection } = useSession();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const [sort, setSort] = useState<"createdAt" | "amount">("createdAt");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const dq = useDebounced(q);
  const pageSize = compact ? 8 : 25;

  const query: PaymentQuery = {
    q: dq || undefined,
    status: status ? [status] : undefined,
    merchantId: selection.merchantId || undefined,
    legalEntityId: selection.legalEntityId || undefined,
    from: from ? new Date(`${from}T00:00:00Z`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59Z`).toISOString() : undefined,
    sort, order, page, pageSize,
  };
  const key = JSON.stringify(query);
  const res = useApi((s) => api.payments(query, s), key);

  const toggleSort = (k: "createdAt" | "amount") => {
    if (sort === k) setOrder(order === "asc" ? "desc" : "asc");
    else {
      setSort(k);
      setOrder("desc");
    }
    setPage(1);
  };

  return (
    <div>
      <div className="filters" role="search" aria-label="Filter payments">
        <div className="search">
          <Search size={14} className="lead" aria-hidden="true" />
          <input className="input" placeholder="Search payment ID or merchant" value={q} aria-label="Search payments"
            onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <select className="select" value={status} aria-label="Filter by status" onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {INTENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </select>
        {!compact && (
          <>
            <input className="input" type="date" aria-label="Created from (UTC)" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
            <input className="input" type="date" aria-label="Created to (UTC)" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          </>
        )}
        <div style={{ marginLeft: "auto" }} className="row">
          <SourceBadge source={res.meta?.source} />
          <StaleIndicator stale={res.stale} loadedAt={res.loadedAt} onRefresh={res.refetch} />
        </div>
      </div>

      {res.error ? (
        <ErrorState error={res.error} onRetry={res.refetch} />
      ) : !res.data && res.loading ? (
        <TableSkeleton rows={compact ? 6 : 10} />
      ) : res.data && res.data.items.length === 0 ? (
        <EmptyState title="No payments match">Try a different search or status, or widen the merchant and jurisdiction scope in the header.</EmptyState>
      ) : res.data ? (
        <>
          <div className="table-wrap" aria-busy={res.loading}>
            <table className="table">
              <caption className="sr-only">Payments. Select a row to open its details and evidence.</caption>
              <thead>
                <tr>
                  <SortHeader label="Date & time" active={sort === "createdAt"} order={order} onClick={() => toggleSort("createdAt")} />
                  <th>Transaction ID</th>
                  <th>Merchant</th>
                  <th>Method</th>
                  <SortHeader label="Amount" active={sort === "amount"} order={order} onClick={() => toggleSort("amount")} align="right" />
                  <th>Status</th>
                  {!compact && <th>Env</th>}
                  <th><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {res.data.items.map((p) => (
                  <PaymentRow key={p.id} p={p} compact={compact} selected={p.id === selectedId} onOpen={() => onOpen(p.id)} />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} onPage={setPage} />
        </>
      ) : null}
    </div>
  );
}

function PaymentRow({ p, compact, selected, onOpen }: { p: Payment; compact?: boolean; selected: boolean; onOpen: () => void }) {
  return (
    <tr className="clickable" aria-selected={selected} onClick={onOpen}>
      <td className="num">{formatDateTime(p.createdAt)}</td>
      <td><span className="mono" title={p.id}>{shortId(p.id, compact ? 8 : 12)}</span></td>
      <td>{p.merchantName}</td>
      <td>{p.method ? <span>{p.method.brand.toUpperCase()} <span className="mono subtle">•• {p.method.last4}</span></span> : <span className="subtle" title="Not available for your role">Restricted</span>}</td>
      <td className="right"><Money minor={p.amountMinor} currency={p.currency} /></td>
      <td><StatusBadge status={p.status} /></td>
      {!compact && <td><span className="badge env-badge" data-env={p.environment}>{p.environment}</span></td>}
      <td className="right">
        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onOpen(); }} aria-label={`Investigate payment ${p.id}`}>Investigate</button>
      </td>
    </tr>
  );
}

/** Evidence drawer: one payment's facts and its evidence timeline, each with provenance. */
export function PaymentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const res = useApi((s) => api.payment(id, s), id);
  const p = res.data;
  return (
    <Drawer
      title={<span className="mono">{id}</span>}
      subtitle={p ? `${p.merchantName} · ${p.environment} · ${p.legalEntityId}` : "Loading…"}
      onClose={onClose}
      footer={<><SourceBadge source={res.meta?.source} /><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Close</button></>}
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={res.refetch} />
      ) : !p ? (
        <TableSkeleton rows={8} />
      ) : (
        <>
          <section className="stack" style={{ gap: 12 }} aria-label="Summary">
            <div className="row-between">
              <div className="kpi-value"><Money minor={p.amountMinor} currency={p.currency} /></div>
              <StatusBadge status={p.status} />
            </div>
            <dl className="kv">
              <dt>Intent status</dt><dd><StatusBadge status={p.status} /> <span className="subtle">(06-01)</span></dd>
              <dt>Attempt status</dt><dd className="mono">{p.attemptStatus}</dd>
              <dt>Merchant</dt><dd>{p.merchantName} <span className="mono subtle">{p.merchantId}</span></dd>
              <dt>Legal entity</dt><dd className="mono">{p.legalEntityId}</dd>
              <dt>Connector</dt><dd className="mono">{p.connector}</dd>
              <dt>Payment method</dt><dd>{p.method ? `${p.method.brand.toUpperCase()} •• ${p.method.last4}` : <span className="subtle">Restricted for your role</span>}</dd>
              <dt>Customer</dt><dd className="mono">{p.customerEmailMasked} <span className="subtle">(masked)</span></dd>
              {p.risk && (<><dt>Risk</dt><dd><StatusBadge status={p.risk.outcome} label={`${humanize(p.risk.outcome)} · score ${p.risk.score}`} /></dd></>)}
              <dt>Created</dt><dd className="num">{formatDateTimeFull(p.createdAt)}</dd>
              <dt>Last updated</dt><dd className="num">{formatDateTimeFull(p.updatedAt)}</dd>
            </dl>
          </section>

          <hr className="divider" />

          <section className="stack" style={{ gap: 12 }} aria-labelledby="evidence-h">
            <div className="row-between">
              <h3 id="evidence-h">Evidence timeline</h3>
              <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{p.timeline.length} events</span>
            </div>
            <ol className="timeline">
              {p.timeline.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <span className="node"><StatusGlyph tone={e.provenance === "provider_confirmed" ? "positive" : e.provenance === "pending_evidence" ? "pending" : "neutral"} /></span>
                  <div style={{ display: "grid", gap: 2 }}>
                    <span className="event-title">{humanize(e.type.replace(".", "_"))} → <span className="mono">{e.status}</span></span>
                    <span className="event-meta">
                      <span className="num">{formatDateTimeFull(e.at)}</span>
                      <span>· source <span className="mono">{e.source}</span></span>
                      <span>· {PROVENANCE_LABEL[e.provenance]}</span>
                      {e.operationId && <span>· <span className="mono">{shortId(e.operationId, 8)}</span></span>}
                    </span>
                    {e.note && <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>{e.note}</span>}
                  </div>
                </li>
              ))}
            </ol>
            <div className="banner" data-tone="dashed" role="note">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>Provider settlement, bank and ledger states (ZP-BRW-005) are not shown: the reconciliation and ledger services (BC-05, BC-06) do not exist yet. A succeeded payment is not proof of bank settlement.</span>
            </div>
          </section>
        </>
      )}
    </Drawer>
  );
}
