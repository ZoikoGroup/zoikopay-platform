import { Download, Search } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useApi } from "../hooks/useApi";
import { useDebounced } from "../hooks/ui";
import { LAYOUTS, type Column } from "../screens/config";
import { api } from "../services/api";
import { formatDateTime, formatDateTimeFull, formatMoney, humanize } from "../services/format";
import { byTotalSpent, CREATE_FORMS, QUICK_VIEWS } from "../screens/parity";
import type { ActionView, FieldValue, MoneyValue, RecordView } from "../types/api";
import { ActionDialog } from "./ActionDialogs";
import { LocalActionButtons, useDemoStatus } from "./DemoExtras";
import { CreateButton, CreateDialog, DraftsTable, type CreateSpec } from "./LocalDrafts";
import { Money } from "./Money";
import { Drawer } from "./Overlay";
import { EmptyState, ErrorState, SourceBadge, StaleIndicator, TableSkeleton } from "./States";
import { StatusBadge, StatusGlyph } from "./StatusBadge";

/** Affirmative actions get the primary (white) button; refusals and holds stay outlined. */
const PRIMARY_ACTIONS = new Set(["approve", "activate", "certify", "close", "promote", "go", "resolve", "approve_change", "submit", "finalize", "unarchive", "resume"]);

const isMoney =(v: FieldValue): v is MoneyValue => !!v && typeof v === "object" && !Array.isArray(v) && "minor" in v && "currency" in v;

/** Renders one field value according to its kind. Every amount shows its currency. */
export function FieldDisplay({ value, kind = "text" }: { value: FieldValue | undefined; kind?: Column["kind"] }) {
  if (value === undefined || value === null || value === "") return <span className="subtle">—</span>;
  if (isMoney(value)) return <Money minor={value.minor} currency={value.currency} />;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="subtle">None</span>;
    return <span className="row" style={{ flexWrap: "wrap", gap: 6 }}>{value.map((v) => <span key={v} className="chip">{v}</span>)}</span>;
  }
  if (typeof value === "object") {
    return (
      <span style={{ display: "grid", gap: 4 }}>
        {Object.entries(value).map(([k, v]) => (
          <span key={k} className="row-between" style={{ gap: 12 }}>
            <span className="muted">{k}</span>
            <StatusBadge status={v} label={humanize(v)} />
          </span>
        ))}
      </span>
    );
  }
  if (kind === "status") return <StatusBadge status={String(value)} />;
  if (kind === "date") return <span className="num" title={formatDateTimeFull(String(value))}>{formatDateTime(String(value))}</span>;
  return <span className={kind === "mono" ? "mono" : undefined}>{String(value)}</span>;
}

function csvCell(v: FieldValue | undefined): string {
  let s: string;
  if (v === undefined || v === null) s = "";
  else if (isMoney(v)) s = `${formatMoney(v.minor, v.currency, { withCode: true })}`;
  else if (Array.isArray(v)) s = v.join("; ");
  else if (typeof v === "object") s = Object.entries(v).map(([k, x]) => `${k}: ${x}`).join("; ");
  else s = String(v);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

/** Export only what the server returned to this user (same permission and redaction as the screen). */
function exportCsv(screenId: string, columns: Column[], rows: RecordView[]) {
  const header = ["id", "status", ...columns.map((c) => c.label)].map((h) => `"${h}"`).join(",");
  const lines = rows.map((r) => [csvCell(r.id), csvCell(r.status), ...columns.map((c) => csvCell(r.fields[c.key]))].join(","));
  const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${screenId}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function RecordDrawer({ screenId, id, onClose }: { screenId: string; id: string; onClose: () => void }) {
  const layout = LAYOUTS[screenId];
  const res = useApi((s) => api.record(screenId, id, s), `${screenId}/${id}`);
  const [action, setAction] = useState<ActionView>();
  const [done, setDone] = useState<string>();
  const statusOf = useDemoStatus(screenId);
  const r = res.data;
  return (
    <>
      <Drawer
        title={<span className="mono">{id}</span>}
        subtitle={r ? `${screenId} · ${r.environment} · version ${r.version}` : "Loading…"}
        onClose={onClose}
        footer={
          r && r.actions.length > 0 ? (
            <div style={{ display: "grid", gap: 8, width: "100%" }}>
              <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                {r.actions.map((a) => (
                  <button key={a.name} className={`btn ${PRIMARY_ACTIONS.has(a.name) ? "btn-primary" : ""}`}
                    disabled={!a.allowed} title={a.blockedReason} onClick={() => setAction(a)}>
                    {a.label}
                  </button>
                ))}
              </div>
              {r.actions.every((a) => !a.allowed) && (
                <span className="subtle" style={{ fontSize: "var(--fs-xs)", textAlign: "right" }}>{r.actions[0]?.blockedReason}</span>
              )}
            </div>
          ) : <><SourceBadge source={res.meta?.source} /><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Close</button></>
        }
      >
        {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !r || !layout ? <TableSkeleton rows={8} /> : (
          <>
            {done && <div className="banner" role="status"><span><strong>{done}.</strong> Recorded in the audit log.</span></div>}
            <div className="row-between">
              <StatusBadge status={statusOf(r.id, r.status)} />
              <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>
                {r.requestedByName ? `Raised by ${r.isOwnRequest ? "you" : r.requestedByName}` : ""} · updated {formatDateTime(r.updatedAt)}
              </span>
            </div>
            {layout.sections.map((sec) => (
              <section key={sec.title} className="stack" style={{ gap: 10 }}>
                <h3>{sec.title}</h3>
                <dl className="kv">
                  {sec.fields.map((f) => (
                    <div key={f.key} style={{ display: "contents" }}>
                      <dt>{f.label}</dt>
                      <dd><FieldDisplay value={r.fields[f.key]} kind={f.kind} /></dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            <LocalActionButtons screenId={screenId} id={r.id} status={statusOf(r.id, r.status)} fields={r.fields} />
            {r.timeline && (
              <section className="stack" style={{ gap: 10 }}>
                <h3>History and evidence</h3>
                <ol className="timeline">
                  {r.timeline.map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      <span className="node"><StatusGlyph tone={i === (r.timeline?.length ?? 0) - 1 ? "positive" : "neutral"} /></span>
                      <div style={{ display: "grid", gap: 2 }}>
                        <span className="event-title">{e.event}</span>
                        <span className="event-meta"><span className="num">{formatDateTimeFull(e.at)}</span><span>· {e.actor}</span></span>
                        {e.note && <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>“{e.note}”</span>}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </Drawer>
      {r && action && (
        <ActionDialog screenId={screenId} record={r} action={action} onClose={() => setAction(undefined)}
          onDone={() => { setDone(action.label); setAction(undefined); res.refetch(); }} />
      )}
    </>
  );
}

/** A complete console screen: summary, filters, export, table and detail with actions. */
export function ScreenView({ screenId, initialQuery = "" }: { screenId: string; initialQuery?: string }) {
  const layout = LAYOUTS[screenId];
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState(initialQuery);
  const [viewKey, setViewKey] = useState("all");
  const views = QUICK_VIEWS[screenId];
  const quick = views?.find((v) => v.key === viewKey);
  const demoStatus = useDemoStatus(screenId);
  const [createOpen, setCreating] = useState(false);
  const closeCreate = () => {
    setCreating(false);
    setParams((p) => { p.delete("create"); return p; }, { replace: true });
  };
  const dq = useDebounced(q);
  const query = { status: status || undefined, q: dq || undefined };
  const res = useApi((s) => api.screen(screenId, query, s), `${screenId}${JSON.stringify(query)}`);
  // A server create form (TEST fixtures) wins over a browser-only local draft form.
  const server = res.data?.create;
  const createSpec: CreateSpec | undefined = server
    ? { label: server.label, prefix: screenId, status: "", fields: server.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.options, hint: f.hint })) }
    : CREATE_FORMS[screenId];
  const canCreate = !server || server.allowed;
  const creating = !!createSpec && canCreate && (createOpen || (params.get("screen") === screenId && params.get("create") === "1"));
  const saveOnServer = server ? async (merchantId: string, values: Record<string, string>) => {
    await api.create(screenId, { merchantId, values });
    res.refetch();
  } : undefined;
  const open = params.get("screen") === screenId ? params.get("record") ?? undefined : undefined;
  const setOpen = (id?: string) => setParams((p) => {
    if (id) { p.set("screen", screenId); p.set("record", id); } else { p.delete("screen"); p.delete("record"); }
    return p;
  });
  if (!layout) return null;
  const d = res.data;
  const all = !d ? [] : d.items.map((r) => { const status = demoStatus(r.id, r.status); return status === r.status ? r : { ...r, status }; });
  const items = quick?.match ? all.filter(quick.match) : all;
  const shown = quick?.key === "top" ? [...items].sort(byTotalSpent) : items;

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      {d && (
        <div className="kpi-grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(170px, 1fr))` }}>
          {d.summary.map((s) => (
            <div key={s.label} className="card kpi" style={{ minHeight: 0 }}>
              <span className="eyebrow">{s.label}</span>
              <span className="kpi-value">{s.value}</span>
            </div>
          ))}
        </div>
      )}
      {createSpec && !server && <DraftsTable screenId={screenId} columns={layout.columns} noun={layout.recordNoun} />}
      <div className="card">
        {views && (
          <div className="tabs" role="tablist" aria-label={`${layout.recordNoun} views`} style={{ padding: "0 var(--s-4)" }}>
            {views.map((v) => (
              <button key={v.key} role="tab" className="tab" aria-selected={v.key === viewKey} disabled={!!v.unavailable} title={v.unavailable}
                onClick={() => setViewKey(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
        )}
        <div className="filters" role="search" aria-label={`Filter ${layout.recordNoun}s`}>
          <div className="search">
            <Search size={14} className="lead" aria-hidden="true" />
            <input className="input" placeholder={`Search ${layout.recordNoun}s`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${layout.recordNoun}s`} />
          </div>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {d?.statuses.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
          <div className="row" style={{ marginLeft: "auto" }}>
            <SourceBadge source={res.meta?.source} />
            <StaleIndicator stale={res.stale} loadedAt={res.loadedAt} onRefresh={res.refetch} />
            <button className="btn btn-sm" disabled={!shown.length} onClick={() => exportCsv(screenId, layout.columns, shown)}>
              <Download size={13} aria-hidden="true" /> Export CSV
            </button>
            {createSpec && (canCreate ? <CreateButton spec={createSpec} onClick={() => setCreating(true)} /> : <span className="subtle" style={{ fontSize: "var(--fs-xs)" }} title={server?.blockedReason}>{server?.blockedReason}</span>)}
          </div>
        </div>
        {res.error ? <ErrorState error={res.error} onRetry={res.refetch} /> : !d ? <TableSkeleton /> : shown.length === 0 ? (
          <EmptyState title={`No ${layout.recordNoun}s match`}>Try another status or search, or widen the merchant scope in the header.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">{d.screen.title}. Select a row for details.</caption>
              <thead>
                <tr>
                  <th>ID</th><th>Status</th>
                  {layout.columns.map((c) => <th key={c.key} className={c.kind === "money" ? "right" : undefined}>{c.label}</th>)}
                  <th>Next step</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const actionable = r.actions.filter((a) => a.allowed && !a.quiet);
                  return (
                    <tr key={r.id} className="clickable" aria-selected={r.id === open} onClick={() => setOpen(r.id)}>
                      <td><button className="btn btn-sm btn-ghost mono" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>{r.id}</button></td>
                      <td><StatusBadge status={r.status} /></td>
                      {layout.columns.map((c) => <td key={c.key} className={c.kind === "money" ? "right" : undefined}><FieldDisplay value={r.fields[c.key]} kind={c.kind} /></td>)}
                      <td>{actionable.length ? <span className="badge badge-solid">{actionable[0]?.label}</span> : r.isOwnRequest ? <span className="subtle">Raised by you</span> : <span className="subtle">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {d && <div className="table-foot"><span>{shown.length} {layout.recordNoun}{shown.length === 1 ? "" : "s"}</span><span>Actions are checked again by the server</span></div>}
      </div>
      {open && <RecordDrawer screenId={screenId} id={open} onClose={() => setOpen(undefined)} />}
      {creating && createSpec && <CreateDialog spec={createSpec} screenId={screenId} onClose={closeCreate} submit={saveOnServer} />}
    </div>
  );
}
