import { KeyRound, Search, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { ReauthDialog } from "../components/ActionDialogs";
import { PageHead } from "../components/Card";
import { Money } from "../components/Money";
import { Dialog, Drawer } from "../components/Overlay";
import { EmptyState, ErrorState, SourceBadge, StaleIndicator, TableSkeleton } from "../components/States";
import { StatusBadge, StatusGlyph } from "../components/StatusBadge";
import { useApi } from "../hooks/useApi";
import { PHONE_QUERY, useDebounced, useMediaQuery, useNow } from "../hooks/ui";
import { useSession } from "../hooks/useSession";
import { api } from "../services/api";
import { formatDateTime, formatDateTimeFull, humanize } from "../services/format";
import { ApiError } from "../services/http";
import type { XaActionView, XaGrant, XaKind, XaOptions } from "../types/api";

/** Notification links use the 02-02 screen ids; both open this page. */
const SCREEN_IDS = new Set(["ZP-PER-WF-007", "ZP-PER-WF-011"]);
const KIND_LABEL: Record<XaKind, string> = { support: "Support ticket", breakglass: "Break-glass" };
const FIELD_LABEL: Record<string, string> = { customer_email: "Customer email", card_details: "Card details" };
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Unexpected error"));

function ErrorBanner({ error }: { error?: ApiError }) {
  if (!error || error.code === "STEP_UP_REQUIRED") return null;
  return <div className="banner" data-tone="strong" role="alert"><span><strong>{error.title}.</strong> {error.detail}</span></div>;
}

/** "42 min left" for an active grant. */
function TimeLeft({ until }: { until: string }) {
  const now = useNow(15_000);
  const mins = Math.max(0, Math.ceil((Date.parse(until) - now) / 60_000));
  return <span className="badge badge-solid num">{mins > 0 ? `${mins} min left` : "Ended"}</span>;
}

function XaActionDialog({ grant, action, onClose, onDone }: { grant: XaGrant; action: XaActionView; onClose: () => void; onDone: () => void }) {
  const { me } = useSession();
  const now = useNow(5_000);
  const phone = useMediaQuery(PHONE_QUERY);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<"in_policy" | "escalate">("in_policy");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [reauth, setReauth] = useState(false);
  const stepUpValid = !!me?.stepUpValidUntil && Date.parse(me.stepUpValidUntil) > now;
  const needsStepUp = action.stepUp && !stepUpValid;
  // Two-person decisions are not taken at phone width; the holder may still close or revoke their own access.
  const blockedOnPhone = phone && (action.name === "approve" || action.name === "review");
  const reasonOk = !action.reasonRequired || reason.trim().length >= 10;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.xaAction(grant.id, action.name, {
        version: grant.version, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(action.name === "review" ? { outcome } : {}),
      });
      onDone();
    } catch (e) {
      const err = asError(e);
      if (err.code === "STEP_UP_REQUIRED") setReauth(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (reauth) return <ReauthDialog onClose={() => setReauth(false)} onDone={() => setReauth(false)} />;

  return (
    <Dialog
      title={action.label}
      description={`${grant.ticketId} · ${grant.id} · version ${grant.version}.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {needsStepUp && !blockedOnPhone ? (
            <button className="btn btn-primary" onClick={() => setReauth(true)} data-autofocus><KeyRound size={14} aria-hidden="true" /> Confirm password to continue</button>
          ) : (
            <button className="btn btn-primary" disabled={blockedOnPhone || !confirmed || !reasonOk || busy} onClick={submit} data-autofocus>
              {busy ? "Submitting…" : action.label}
            </button>
          )}
        </>
      }
    >
      {blockedOnPhone ? (
        <div className="banner" data-tone="strong" role="alert"><span>Approvals and reviews are disabled at phone width. Use a larger screen.</span></div>
      ) : (
        <>
          {action.name === "approve" && (
            <div className="banner" role="note"><span>The holder gets read-only, {grant.scope.unmasked.length ? "partly unmasked" : "masked"} access to {grant.scope.merchants.length} merchant(s) for {grant.durationMinutes} minutes, starting now.</span></div>
          )}
          {action.name === "revoke" && <div className="banner" role="note"><span>The holder loses access on their next click.</span></div>}
          {action.name === "review" && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>Outcome</legend>
              <label className="checkbox"><input type="radio" name="xa-outcome" checked={outcome === "in_policy"} onChange={() => setOutcome("in_policy")} /><span>Within policy: reads match the ticket</span></label>
              <label className="checkbox"><input type="radio" name="xa-outcome" checked={outcome === "escalate"} onChange={() => setOutcome("escalate")} /><span>Escalate: out-of-policy access</span></label>
            </fieldset>
          )}
          {(action.reasonRequired || action.name === "close") && (
            <div className="field" data-invalid={reason.length > 0 && !reasonOk}>
              <label htmlFor="xa-reason">{action.name === "review" ? "Review notes" : action.name === "close" ? "Note (optional)" : "Reason"}{action.reasonRequired ? " (required, at least 10 characters)" : ""}</label>
              <textarea id="xa-reason" className="textarea" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I checked the ticket, scope and {action.name === "review" ? "access log" : "requester"} for this exact version.</span>
          </label>
        </>
      )}
      <ErrorBanner error={error} />
    </Dialog>
  );
}

function RequestDialog({ options, onClose, onDone }: { options: XaOptions; onClose: () => void; onDone: (g: XaGrant) => void }) {
  const [kind, setKind] = useState<XaKind>(options.kinds[0]?.kind ?? "support");
  const [ticketId, setTicketId] = useState("");
  const [consentRef, setConsentRef] = useState("");
  const [purpose, setPurpose] = useState("");
  const [tenant, setTenant] = useState("");
  const [cell, setCell] = useState("");
  const [merchants, setMerchants] = useState<string[]>([]);
  const [unmasked, setUnmasked] = useState<string[]>([]);
  const max = options.kinds.find((k) => k.kind === kind)?.maxMinutes ?? 60;
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const tenants = [...new Set(options.merchants.map((m) => m.tenantId))].sort();
  const cells = [...new Set(options.merchants.filter((m) => m.tenantId === tenant).map((m) => m.legalEntityId))].sort();
  const pick = options.merchants.filter((m) => m.tenantId === tenant && m.legalEntityId === cell);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const valid = /^[A-Za-z]{2,6}-\d{1,8}$/.test(ticketId.trim()) && purpose.trim().length >= 10 && merchants.length > 0 && minutes >= 15 && minutes <= max;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.xaRequest({ kind, ticketId: ticketId.trim().toUpperCase(), ...(consentRef.trim() ? { consentRef: consentRef.trim() } : {}), purpose: purpose.trim(), merchantIds: merchants, unmasked, durationMinutes: minutes });
      onDone(r.data);
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Request exceptional access"
      description="Read-only and masked by default, for named merchants only, for a limited time. Security must approve it; every read is recorded and reviewed."
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="xa-form" disabled={!valid || busy}>{busy ? "Sending…" : "Send to Security"}</button></>}
    >
      <form id="xa-form" className="stack" onSubmit={submit}>
        {options.kinds.length > 1 && (
          <div className="field">
            <label htmlFor="xa-kind">Type</label>
            <select id="xa-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value as XaKind); setMinutes(60); }}>
              {options.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="xa-ticket">{kind === "support" ? "Support ticket" : "Incident"} id</label>
          <input id="xa-ticket" className="input mono" value={ticketId} onChange={(e) => setTicketId(e.target.value)} placeholder={kind === "support" ? "SUP-1042" : "INC-77"} autoComplete="off" data-autofocus />
        </div>
        {kind === "support" && (
          <div className="field">
            <label htmlFor="xa-consent">Merchant consent reference (optional)</label>
            <input id="xa-consent" className="input" value={consentRef} onChange={(e) => setConsentRef(e.target.value)} placeholder="e.g. email from merchant owner, 13 Nov" />
          </div>
        )}
        <div className="field">
          <label htmlFor="xa-purpose">Purpose (at least 10 characters)</label>
          <textarea id="xa-purpose" className="textarea" value={purpose} maxLength={500} onChange={(e) => setPurpose(e.target.value)} />
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 160 }}>
            <label htmlFor="xa-tenant">Organisation</label>
            <select id="xa-tenant" className="select" value={tenant} onChange={(e) => { setTenant(e.target.value); setCell(""); setMerchants([]); }}>
              <option value="">Choose…</option>
              {tenants.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 160 }}>
            <label htmlFor="xa-cell">Legal cell</label>
            <select id="xa-cell" className="select" value={cell} disabled={!tenant} onChange={(e) => { setCell(e.target.value); setMerchants([]); }}>
              <option value="">Choose…</option>
              {cells.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {cell && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>Merchants (one organisation, one cell)</legend>
            {pick.map((m) => (
              <label key={m.id} className="checkbox"><input type="checkbox" checked={merchants.includes(m.id)} onChange={() => setMerchants(toggle(merchants, m.id))} /><span>{m.name} <span className="mono subtle">{m.id}</span></span></label>
            ))}
          </fieldset>
        )}
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Unmask (each needs Security's approval)</legend>
          {options.unmaskable.map((f) => (
            <label key={f} className="checkbox"><input type="checkbox" checked={unmasked.includes(f)} onChange={() => setUnmasked(toggle(unmasked, f))} /><span>{FIELD_LABEL[f] ?? humanize(f)}</span></label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="xa-minutes">Duration in minutes (15 to {max}; starts when approved)</label>
          <input id="xa-minutes" className="input num" type="number" min={15} max={max} step={15} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </div>
      </form>
      <ErrorBanner error={error} />
    </Dialog>
  );
}

/** The read-only window: only the granted merchants' payments, masked as approved. */
function RecordsWindow({ grant, onClose }: { grant: XaGrant; onClose: () => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [open, setOpen] = useState<string>();
  const res = useApi((s) => api.xaPayments(grant.id, { q: dq || undefined }, s), `xa-pay/${grant.id}/${dq}`);
  const detail = useApi(open ? (s) => api.xaPayment(grant.id, open, s) : null, `xa-pay-detail/${grant.id}/${open ?? ""}`);
  return (
    <Drawer
      title={<>Records for {grant.ticketId}</>}
      subtitle={<>{grant.scope.merchants.map((m) => m.name).join(", ")} · read-only · {grant.scope.unmasked.length ? `unmasked: ${grant.scope.unmasked.map((f) => FIELD_LABEL[f] ?? f).join(", ")}` : "masked"}</>}
      onClose={onClose}
      footer={<>{grant.expiresAt && <TimeLeft until={grant.expiresAt} />}<span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>Every view is recorded for review</span><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Close</button></>}
    >
      {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !res.data ? <TableSkeleton rows={6} /> : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="search">
            <Search size={14} className="lead" aria-hidden="true" />
            <input className="input" placeholder="Payment id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search payment id" />
          </div>
          {open && (
            <div className="card" style={{ padding: 12 }}>
              {detail.error ? <ErrorState error={detail.error} /> : !detail.data ? <TableSkeleton rows={3} /> : (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="row-between"><span className="mono">{detail.data.id}</span><button className="btn btn-sm" onClick={() => setOpen(undefined)}>Back to list</button></div>
                  <dl className="kv">
                    <dt>Status</dt><dd><StatusBadge status={detail.data.status} /></dd>
                    <dt>Amount</dt><dd><Money minor={detail.data.amountMinor} currency={detail.data.currency} /></dd>
                    <dt>Customer</dt><dd>{detail.data.customerEmail}</dd>
                    <dt>Card</dt><dd>{detail.data.method.brand} · {detail.data.method.last4}</dd>
                    <dt>Connector</dt><dd>{detail.data.connector}</dd>
                  </dl>
                  <ol className="timeline">
                    {(detail.data.timeline ?? []).map((e, i) => (
                      <li key={`${e.at}-${i}`}><span className="node"><StatusGlyph tone="neutral" /></span>
                        <div style={{ display: "grid", gap: 2 }}><span className="event-title">{humanize(e.type)} · {humanize(e.status)}</span><span className="event-meta"><span className="num">{formatDateTimeFull(e.at)}</span><span>· {e.source}</span></span></div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Payments within this access grant</caption>
              <thead><tr><th>Payment</th><th>Status</th><th className="right">Amount</th><th>Customer</th><th>Created</th></tr></thead>
              <tbody>
                {res.data.items.map((p) => (
                  <tr key={p.id} className="clickable" aria-selected={p.id === open} onClick={() => setOpen(p.id)}>
                    <td className="mono">{p.id.slice(0, 14)}…<span className="cell-sub subtle" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{p.merchantName}</span></td>
                    <td><StatusBadge status={p.status} /></td>
                    <td className="right"><Money minor={p.amountMinor} currency={p.currency} /></td>
                    <td>{p.customerEmail}</td>
                    <td className="num">{formatDateTime(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function GrantDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const res = useApi((s) => api.xaGet(id, s), `xa/${id}`);
  const [pending, setPending] = useState<XaActionView>();
  const [done, setDone] = useState<string>();
  const [viewing, setViewing] = useState(false);
  const g = res.data;
  if (viewing && g) return <RecordsWindow grant={g} onClose={() => { setViewing(false); res.refetch(); }} />;
  return (
    <>
      <Drawer
        title={g ? <span className="mono">{g.ticketId}</span> : "Loading…"}
        subtitle={g ? <>{KIND_LABEL[g.kind]} · {g.id} · version {g.version}</> : undefined}
        onClose={onClose}
        footer={g && (
          <div style={{ display: "grid", gap: 8, width: "100%" }}>
            <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
              {g.isMine && g.status === "ACTIVE" && <button className="btn btn-primary" onClick={() => setViewing(true)}>Open records</button>}
              {g.actions.map((a) => (
                <button key={a.name} className={`btn ${a.name === "approve" ? "btn-primary" : ""}`} disabled={!a.allowed} title={a.blockedReason} onClick={() => setPending(a)}>{a.label}</button>
              ))}
            </div>
            {g.actions.length > 0 && g.actions.every((a) => !a.allowed) && <span className="subtle" style={{ fontSize: "var(--fs-xs)", textAlign: "right" }}>{g.actions[0]?.blockedReason}</span>}
          </div>
        )}
      >
        {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !g ? <TableSkeleton rows={8} /> : (
          <div className="stack" style={{ gap: "var(--s-5)" }}>
            {done && <div className="banner" role="status"><span><strong>{done}.</strong> Recorded in the audit log.</span></div>}
            <div className="row-between">
              <StatusBadge status={g.status} />
              {g.status === "ACTIVE" && g.expiresAt && <TimeLeft until={g.expiresAt} />}
              {g.reviewOverdue && <span className="badge badge-solid">Review overdue</span>}
            </div>
            <dl className="kv">
              <dt>Purpose</dt><dd>“{g.purpose}”</dd>
              {g.consentRef && <><dt>Merchant consent</dt><dd>{g.consentRef}</dd></>}
              <dt>Requested by</dt><dd>{g.requestedByName} ({g.requestedRole}) · {formatDateTime(g.requestedAt)}</dd>
              <dt>Approved by</dt><dd>{g.approvedByName ? `${g.approvedByName} · ${g.approvedAt ? formatDateTime(g.approvedAt) : ""}` : <span className="subtle">Not yet</span>}</dd>
              <dt>Merchants</dt><dd>{g.scope.merchants.map((m) => m.name).join(", ")} <span className="subtle mono">({g.scope.tenantId}, {g.scope.legalEntityId}, {g.scope.environment})</span></dd>
              <dt>Access</dt><dd>{g.scope.resources} · {g.scope.unmasked.length ? `unmasked: ${g.scope.unmasked.map((f) => FIELD_LABEL[f] ?? f).join(", ")}` : "all personal data masked"}</dd>
              <dt>Duration</dt><dd>{g.durationMinutes} min{g.expiresAt ? ` · until ${formatDateTime(g.expiresAt)}` : ""}</dd>
              <dt>Records viewed</dt><dd className="num">{g.readCount}</dd>
              {g.review && <><dt>Review</dt><dd>{g.review.outcome === "in_policy" ? "Within policy" : "Escalated"} · {g.review.byName} · “{g.review.notes}”</dd></>}
            </dl>
            {g.reads && g.reads.length > 0 && (
              <section className="stack" style={{ gap: 8 }}>
                <h3>Access log</h3>
                <ul className="list-plain">
                  {g.reads.map((r, i) => (
                    <li key={`${r.at}-${i}`} className="list-row"><span className="grow mono" style={{ fontSize: "var(--fs-xs)" }}>{r.resource}</span><span className="num subtle" style={{ fontSize: "var(--fs-xs)" }}>{formatDateTimeFull(r.at)}</span></li>
                  ))}
                </ul>
              </section>
            )}
            <section className="stack" style={{ gap: 8 }}>
              <h3>History</h3>
              <ol className="timeline">
                {(g.history ?? []).map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    <span className="node"><StatusGlyph tone={i === (g.history?.length ?? 0) - 1 ? "positive" : "neutral"} /></span>
                    <div style={{ display: "grid", gap: 2 }}>
                      <span className="event-title">{e.event}</span>
                      <span className="event-meta"><span className="num">{formatDateTimeFull(e.at)}</span><span>· {e.actor}</span></span>
                      {e.note && <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>“{e.note}”</span>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </Drawer>
      {g && pending && (
        <XaActionDialog grant={g} action={pending} onClose={() => setPending(undefined)}
          onDone={() => { setDone(pending.label); setPending(undefined); res.refetch(); onChanged(); }} />
      )}
    </>
  );
}

/** Exceptional access (ADR 0004): Support JIT (WF-007) and break-glass (WF-011). */
export function ExceptionalPage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("");
  const [requesting, setRequesting] = useState(false);
  const res = useApi((s) => api.xaList({ status: status || undefined }, s), `xa-list/${status}`, { refreshMs: 30_000 });
  const options = useApi(res.data?.canRequest.length ? (s) => api.xaOptions(s) : null, "xa-options");
  const screen = params.get("screen");
  const open = screen && SCREEN_IDS.has(screen) ? params.get("record") ?? undefined : undefined;
  const setOpen = (id?: string) => setParams((p) => {
    if (id) { p.set("screen", "ZP-PER-WF-007"); p.set("record", id); } else { p.delete("screen"); p.delete("record"); }
    return p;
  });
  const d = res.data;

  return (
    <>
      <PageHead
        title="Exceptional access"
        screen={<><span className="chip">ZP-PER-WF-007</span><span className="chip">ZP-PER-WF-011</span><span className="chip">03-05 §10.2</span></>}
        description="Temporary, read-only, masked access to named merchants' records for a support ticket or an incident. Security approves; it ends on its own; every view is recorded and reviewed by someone else."
        actions={d && d.canRequest.length > 0 && (
          <button className="btn btn-primary" disabled={!options.data} onClick={() => setRequesting(true)}><ShieldAlert size={14} aria-hidden="true" /> Request access</button>
        )}
      />
      <div className="stack" style={{ gap: "var(--s-4)" }}>
        {d && (
          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            {d.summary.map((s) => (
              <div key={s.label} className="card kpi" style={{ minHeight: 0 }}><span className="eyebrow">{s.label}</span><span className="kpi-value num">{s.value}</span></div>
            ))}
          </div>
        )}
        <div className="card">
          <div className="filters" role="search" aria-label="Filter access requests">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All</option>
              {["REQUESTED", "ACTIVE", "REVIEW_DUE", "EXPIRED", "REVOKED", "CLOSED", "REJECTED", "LAPSED"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
            <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{d?.isApprover ? "You see every request." : "You see your own requests."}</span>
            <div className="row" style={{ marginLeft: "auto" }}>
              <SourceBadge source={res.meta?.source} />
              <StaleIndicator stale={res.stale} loadedAt={res.loadedAt} onRefresh={res.refetch} />
            </div>
          </div>
          {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !d ? <TableSkeleton /> : d.items.length === 0 ? (
            <EmptyState title="No exceptional access">{d.canRequest.length ? "Request access when a ticket needs you to look at a merchant's records." : "Nothing to approve or review."}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Exceptional access requests. Select a row for details.</caption>
                <thead><tr><th>Ticket</th><th>Type</th><th>Status</th><th>Requested by</th><th>Merchants</th><th>Time</th><th>Next step</th></tr></thead>
                <tbody>
                  {d.items.map((g) => {
                    const next = g.actions.find((a) => a.allowed);
                    return (
                      <tr key={g.id} className="clickable" aria-selected={g.id === open} onClick={() => setOpen(g.id)}>
                        <td><button className="btn btn-sm btn-ghost mono" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); setOpen(g.id); }}>{g.ticketId}</button><span className="cell-sub subtle mono" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{g.id}</span></td>
                        <td>{KIND_LABEL[g.kind]}</td>
                        <td><StatusBadge status={g.status} />{g.reviewDue && <span className="cell-sub subtle" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{g.reviewOverdue ? "Review overdue" : "Review due"}</span>}</td>
                        <td>{g.requestedByName}</td>
                        <td>{g.scope.merchants.map((m) => m.name).join(", ")}</td>
                        <td>{g.status === "ACTIVE" && g.expiresAt ? <TimeLeft until={g.expiresAt} /> : <span className="num subtle">{g.durationMinutes} min</span>}</td>
                        <td>{g.isMine && g.status === "ACTIVE" ? <span className="badge badge-solid">Open records</span> : next ? <span className="badge badge-solid">{next.label}</span> : <span className="subtle">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {open && <GrantDrawer id={open} onClose={() => setOpen(undefined)} onChanged={res.refetch} />}
      {requesting && options.data && (
        <RequestDialog options={options.data} onClose={() => setRequesting(false)} onDone={(g) => { setRequesting(false); res.refetch(); setOpen(g.id); }} />
      )}
    </>
  );
}
