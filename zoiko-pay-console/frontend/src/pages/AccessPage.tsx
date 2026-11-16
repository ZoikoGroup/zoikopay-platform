import { KeyRound, Search, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { ReauthDialog } from "../components/ActionDialogs";
import { PageHead } from "../components/Card";
import { Dialog, Drawer } from "../components/Overlay";
import { EmptyState, ErrorState, SourceBadge, StaleIndicator, TableSkeleton } from "../components/States";
import { StatusBadge, StatusGlyph } from "../components/StatusBadge";
import { useApi } from "../hooks/useApi";
import { PHONE_QUERY, useDebounced, useMediaQuery, useNow } from "../hooks/ui";
import { useSession } from "../hooks/useSession";
import { api } from "../services/api";
import { formatDateTime, formatDateTimeFull, humanize } from "../services/format";
import { ApiError } from "../services/http";
import type { AccessActionView, AccessGrant, AccessMember, AccessOptions, Environment } from "../types/api";

const SCREEN_ID = "ZP-PER-WF-002";
const NO_DATA_SCOPE = new Set(["PSUP", "PSRE"]);
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Unexpected error"));
const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function ErrorBanner({ error }: { error?: ApiError }) {
  if (!error || error.code === "STEP_UP_REQUIRED") return null;
  return <div className="banner" data-tone="strong" role="alert"><span><strong>{error.title}.</strong> {error.detail}</span></div>;
}

/** Confirms one action on one exact grant version. The server re-checks every rule. */
function GrantActionDialog({ grant, action, person, onClose, onDone }: {
  grant: AccessGrant;
  action: AccessActionView;
  person: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { me } = useSession();
  const now = useNow(5_000);
  const phone = useMediaQuery(PHONE_QUERY);
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [reauth, setReauth] = useState(false);
  const stepUpValid = !!me?.stepUpValidUntil && Date.parse(me.stepUpValidUntil) > now;
  const needsStepUp = action.stepUp && !stepUpValid;
  const blockedOnPhone = action.stepUp && phone;
  const reasonOk = !action.reasonRequired || reason.trim().length >= 10;
  const dateOk = action.name !== "narrow" || !!expiresAt;
  const latest = grant.expiresAt ? dateOnly(Date.parse(grant.expiresAt) - 86_400_000) : undefined;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.accessAction(grant.id, action.name, {
        version: grant.version,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(action.name === "narrow" ? { expiresAt } : {}),
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
      description={`${grant.role} for ${person} · ${grant.id} · version ${grant.version}.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {needsStepUp && !blockedOnPhone ? (
            <button className="btn btn-primary" onClick={() => setReauth(true)} data-autofocus><KeyRound size={14} aria-hidden="true" /> Confirm password to continue</button>
          ) : (
            <button className="btn btn-primary" disabled={blockedOnPhone || !confirmed || !reasonOk || !dateOk || busy} onClick={submit} data-autofocus>
              {busy ? "Submitting…" : action.label}
            </button>
          )}
        </>
      }
    >
      {blockedOnPhone ? (
        <div className="banner" data-tone="strong" role="alert">
          <span>Access approvals and revocations are disabled at phone width. Use a larger screen.</span>
        </div>
      ) : (
        <>
          {action.name === "revoke" && <div className="banner" role="note"><span>The person loses this role on their very next click.</span></div>}
          {action.name === "approve" && <div className="banner" role="note"><span>On approval this role becomes active immediately and replaces any current role.</span></div>}
          {action.name === "narrow" && (
            <div className="field">
              <label htmlFor="grant-expiry">New expiry date{grant.expiresAt ? ` (before ${grant.expiresAt.slice(0, 10)})` : ""}</label>
              <input id="grant-expiry" className="input" type="date" value={expiresAt} min={dateOnly(now + 86_400_000)} max={latest}
                onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
          )}
          {action.reasonRequired && (
            <div className="field" data-invalid={reason.length > 0 && !reasonOk}>
              <label htmlFor="grant-reason">Reason (required, at least 10 characters)</label>
              <textarea id="grant-reason" className="textarea" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I reviewed this exact grant, its scope and who requested it ({grant.requestedByName}).</span>
          </label>
        </>
      )}
      <ErrorBanner error={error} />
    </Dialog>
  );
}

/** Request a role for someone. Only roles and scopes inside the requester's own are offered; the server enforces the same. */
function RequestDialog({ options, onClose, onDone }: { options: AccessOptions; onClose: () => void; onDone: (m: AccessMember) => void }) {
  const now = useNow(60_000);
  const [username, setUsername] = useState("");
  const [persona, setPersona] = useState(options.roles[0]?.persona ?? "");
  const [merchants, setMerchants] = useState<string[]>([]);
  const [entities, setEntities] = useState<string[]>([]);
  const [envs, setEnvs] = useState<Environment[]>(options.environments.includes("TEST") ? ["TEST"] : [...options.environments]);
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const role = options.roles.find((r) => r.persona === persona);
  const merchantRole = role?.kind === "merchant";
  const needsEntities = !merchantRole && !NO_DATA_SCOPE.has(persona);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const scopeOk = merchantRole ? merchants.length > 0 : !needsEntities || entities.length > 0;
  const valid = /^[a-z][a-z0-9._-]{2,59}$/.test(username.trim().toLowerCase()) && !!role && scopeOk && envs.length > 0 && reason.trim().length >= 10;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.accessRequest({
        username: username.trim().toLowerCase(), persona, environments: envs, reason: reason.trim(),
        ...(merchantRole ? { merchantIds: merchants } : {}),
        ...(needsEntities ? { legalEntityIds: entities } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      });
      onDone(r.data);
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Request a role"
      description="A second administrator must approve it before it takes effect. You cannot request a role for yourself."
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="request-form" disabled={!valid || busy}>{busy ? "Sending…" : "Send for approval"}</button></>}
    >
      <form id="request-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="req-username">Username</label>
          <input id="req-username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="e.g. new.person" data-autofocus />
          <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>The person must already have an account (Create account on the sign-in page).</span>
        </div>
        <div className="field">
          <label htmlFor="req-role">Role</label>
          <select id="req-role" className="select" value={persona} onChange={(e) => { setPersona(e.target.value); setMerchants([]); setEntities([]); }}>
            {options.roles.map((r) => <option key={r.persona} value={r.persona}>{r.label} ({r.persona})</option>)}
          </select>
        </div>
        {merchantRole && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>Merchants</legend>
            {options.allMerchantsOption && (
              <label className="checkbox"><input type="checkbox" checked={merchants[0] === "*"} onChange={(e) => setMerchants(e.target.checked ? ["*"] : [])} /><span>All merchants in my organisation</span></label>
            )}
            {merchants[0] !== "*" && options.merchants.map((m) => (
              <label key={m.id} className="checkbox"><input type="checkbox" checked={merchants.includes(m.id)} onChange={() => setMerchants(toggle(merchants, m.id))} /><span>{m.displayName} <span className="mono subtle">{m.id}</span></span></label>
            ))}
          </fieldset>
        )}
        {needsEntities && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>Legal entities</legend>
            {options.legalEntities.map((le) => (
              <label key={le.id} className="checkbox"><input type="checkbox" checked={entities.includes(le.id)} onChange={() => setEntities(toggle(entities, le.id))} /><span>{le.name} <span className="mono subtle">{le.id}</span></span></label>
            ))}
          </fieldset>
        )}
        {!merchantRole && !needsEntities && <p className="subtle" style={{ fontSize: "var(--fs-xs)" }}>This role carries no data scope (02-02).</p>}
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Environments</legend>
          {options.environments.map((env) => (
            <label key={env} className="checkbox"><input type="checkbox" checked={envs.includes(env)} onChange={() => setEnvs(toggle(envs, env))} /><span>{env}</span></label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="req-expiry">Expires (optional)</label>
          <input id="req-expiry" className="input" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
            min={dateOnly(now + 86_400_000)} max={dateOnly(now + options.maxExpiryDays * 86_400_000)} />
        </div>
        <div className="field" data-invalid={reason.length > 0 && reason.trim().length < 10}>
          <label htmlFor="req-reason">Reason (at least 10 characters)</label>
          <textarea id="req-reason" className="textarea" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </div>
      </form>
      <ErrorBanner error={error} />
    </Dialog>
  );
}

function GrantCard({ grant, onAction }: { grant: AccessGrant; onAction: (g: AccessGrant, a: AccessActionView) => void }) {
  const live = grant.status === "ACTIVE" || grant.status === "PENDING_APPROVAL";
  return (
    <section className="stack" style={{ gap: 10, opacity: live ? 1 : 0.75 }}>
      <div className="row-between">
        <h3 style={{ margin: 0 }}>{grant.role} <span className="mono subtle" style={{ fontSize: "var(--fs-xs)" }}>{grant.persona}</span></h3>
        <StatusBadge status={grant.status} />
      </div>
      <dl className="kv">
        <dt>Scope</dt><dd>{grant.scope.summary}</dd>
        <dt>Expires</dt><dd>{grant.expiresAt ? formatDateTime(grant.expiresAt) : <span className="subtle">No expiry</span>}</dd>
        <dt>Requested by</dt><dd>{grant.requestedByName} · {formatDateTime(grant.requestedAt)}</dd>
        {grant.reason && <><dt>Reason</dt><dd>“{grant.reason}”</dd></>}
        <dt>Grant</dt><dd className="mono">{grant.id} · v{grant.version}</dd>
      </dl>
      {grant.actions.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {grant.actions.map((a) => (
              <button key={a.name} className={`btn btn-sm ${a.name === "approve" ? "btn-primary" : ""}`} disabled={!a.allowed} title={a.blockedReason} onClick={() => onAction(grant, a)}>
                {a.label}
              </button>
            ))}
          </div>
          {grant.actions.every((a) => !a.allowed) && <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{grant.actions[0]?.blockedReason}</span>}
        </div>
      )}
      <ol className="timeline">
        {grant.history.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <span className="node"><StatusGlyph tone={i === grant.history.length - 1 ? "positive" : "neutral"} /></span>
            <div style={{ display: "grid", gap: 2 }}>
              <span className="event-title">{e.event}</span>
              <span className="event-meta"><span className="num">{formatDateTimeFull(e.at)}</span><span>· {e.actor}</span></span>
              {e.note && <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>“{e.note}”</span>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PersonDrawer({ sub, onClose, onChanged }: { sub: string; onClose: () => void; onChanged: () => void }) {
  const res = useApi((s) => api.accessMember(sub, s), `access-member/${sub}`);
  const [pending, setPending] = useState<{ grant: AccessGrant; action: AccessActionView }>();
  const [done, setDone] = useState<string>();
  const m = res.data;
  const person = m ? m.displayName : "";
  return (
    <>
      <Drawer
        title={m ? m.displayName : "Loading…"}
        subtitle={m ? <><span className="mono">{m.username}</span>{m.isSelf ? " · this is you" : ""}</> : undefined}
        onClose={onClose}
        footer={<><SourceBadge source={res.meta?.source} /><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Close</button></>}
      >
        {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !m ? <TableSkeleton rows={6} /> : (
          <div className="stack" style={{ gap: "var(--s-5)" }}>
            {done && <div className="banner" role="status"><span><strong>{done}.</strong> Recorded in the audit log.</span></div>}
            {m.isSelf && <div className="banner" role="note"><span>Another administrator must change your own access.</span></div>}
            {m.grants.length === 0 ? (
              <EmptyState title="No role yet">This account can sign in but sees nothing until a role is requested and approved.</EmptyState>
            ) : m.grants.map((g) => <GrantCard key={g.id} grant={g} onAction={(grant, action) => setPending({ grant, action })} />)}
          </div>
        )}
      </Drawer>
      {pending && (
        <GrantActionDialog grant={pending.grant} action={pending.action} person={person} onClose={() => setPending(undefined)}
          onDone={() => { setDone(pending.action.label); setPending(undefined); res.refetch(); onChanged(); }} />
      )}
    </>
  );
}

/** Role and delegation administration (02-02 ZP-PER-WF-002). Merchant owners, IAM administrators and Security. */
export function AccessPage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [requesting, setRequesting] = useState(false);
  const dq = useDebounced(q);
  const query = { status: status || undefined, q: dq || undefined };
  const res = useApi((s) => api.accessMembers(query, s), `access-members${JSON.stringify(query)}`);
  const options = useApi(res.data?.canRequest ? (s) => api.accessOptions(s) : null, "access-options");
  const open = params.get("screen") === SCREEN_ID ? params.get("record") ?? undefined : undefined;
  const setOpen = (sub?: string) => setParams((p) => {
    if (sub) { p.set("screen", SCREEN_ID); p.set("record", sub); } else { p.delete("screen"); p.delete("record"); }
    return p;
  });
  const d = res.data;

  return (
    <>
      <PageHead
        title="Access"
        screen={<><span className="chip">{SCREEN_ID}</span><span className="chip">02-02</span><span className="chip">Roles: MOWN, PIAM, PSEC</span></>}
        description="Who can do what. Granting a role needs a second administrator; nobody can grant themselves a role or a role above their own; a revoke takes effect on the person's next click."
        actions={d?.canRequest && (
          <button className="btn btn-primary" disabled={!options.data} onClick={() => setRequesting(true)}>
            <UserPlus size={14} aria-hidden="true" /> Request a role
          </button>
        )}
      />
      <div className="stack" style={{ gap: "var(--s-4)" }}>
        {d && (
          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            {d.summary.map((s) => (
              <div key={s.label} className="card kpi" style={{ minHeight: 0 }}>
                <span className="eyebrow">{s.label}</span>
                <span className="kpi-value num">{s.value}</span>
              </div>
            ))}
          </div>
        )}
        {d?.accountsUnavailable && (
          <div className="banner" role="status"><span>Zoiko iD could not be reached, so accounts without a role are not listed. People with a role are shown.</span></div>
        )}
        <div className="card">
          <div className="filters" role="search" aria-label="Filter people">
            <div className="search">
              <Search size={14} className="lead" aria-hidden="true" />
              <input className="input" placeholder="Search people or roles" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people or roles" />
            </div>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              {d?.statuses.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
            <div className="row" style={{ marginLeft: "auto" }}>
              <SourceBadge source={res.meta?.source} />
              <StaleIndicator stale={res.stale} loadedAt={res.loadedAt} onRefresh={res.refetch} />
            </div>
          </div>
          {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !d ? <TableSkeleton /> : d.items.length === 0 ? (
            <EmptyState title="No people match">Try another status or search.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">People and their roles. Select a row for details and actions.</caption>
                <thead><tr><th>Person</th><th>Status</th><th>Role</th><th>Scope</th><th>Expires</th><th>Granted by</th><th>Next step</th></tr></thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.sub} className="clickable" aria-selected={r.sub === open} onClick={() => setOpen(r.sub)}>
                      <td>
                        <button className="btn btn-sm btn-ghost" style={{ padding: 0, textAlign: "left" }} onClick={(e) => { e.stopPropagation(); setOpen(r.sub); }}>{r.displayName}{r.isSelf ? " (you)" : ""}</button>
                        <span className="cell-sub subtle mono" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>{r.username}</span>
                      </td>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{r.role ?? <span className="subtle">—</span>}{r.requestedRole && <span className="cell-sub subtle" style={{ display: "block", fontSize: "var(--fs-2xs)" }}>Requested: {r.requestedRole}</span>}</td>
                      <td className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{r.scope ?? "—"}</td>
                      <td className="num">{r.expiresAt ? formatDateTime(r.expiresAt) : <span className="subtle">—</span>}</td>
                      <td>{r.grantedBy ?? <span className="subtle">—</span>}</td>
                      <td>{r.nextStep ? <span className="badge badge-solid">{r.nextStep}</span> : <span className="subtle">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d && <div className="table-foot"><span>{d.total} {d.total === 1 ? "person" : "people"}</span><span>Every action is checked again by the server and recorded</span></div>}
        </div>
      </div>
      {open && <PersonDrawer sub={open} onClose={() => setOpen(undefined)} onChanged={res.refetch} />}
      {requesting && options.data && (
        <RequestDialog options={options.data} onClose={() => setRequesting(false)}
          onDone={(m) => { setRequesting(false); res.refetch(); setOpen(m.sub); }} />
      )}
    </>
  );
}
