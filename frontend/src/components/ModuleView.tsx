import { Info, Trash2 } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { humanize } from "../services/format";
import { MODULES, SERVER_MODULES } from "../screens/parity";
import type { FieldValue } from "../types/api";
import { ApiKeysPanel, CapitalOffer, CardVisuals, CheckoutPreview, LocalActionButtons, PricingPreview, SigmaBox, useDemoStatus } from "./DemoExtras";
import { CreateButton, CreateDialog, useLocalDrafts } from "./LocalDrafts";
import { Drawer } from "./Overlay";
import { FieldDisplay, ScreenView } from "./ScreenView";
import { EmptyState, NotBuiltBadge } from "./States";
import { StatusBadge } from "./StatusBadge";

interface Row { id: string; status: string; fields: Record<string, FieldValue>; local: boolean; createdAt?: string }

/**
 * A Stripe area with no backend API yet: demo values, local drafts and demo
 * actions, all in this browser only. It says so plainly at the top.
 */
export function ModuleView({ id }: { id: string }) {
  const mod = MODULES[id];
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreating] = useState(false);
  const creating = !!mod?.create && (createOpen || (params.get("screen") === id && params.get("create") === "1"));
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string>();
  const { rows: drafts, remove } = useLocalDrafts(id);
  const statusOf = useDemoStatus(id);
  if (!mod) return null;
  const close = () => {
    setCreating(false);
    setParams((p) => { p.delete("create"); return p; }, { replace: true });
  };
  const rows: Row[] = [
    ...drafts.map((d) => ({ id: d.id, status: statusOf(d.id, d.status), fields: d.fields, local: true, createdAt: d.createdAt })),
    ...(mod.demo ?? []).map((d) => ({ ...d, status: statusOf(d.id, d.status), local: false })),
  ];
  const statuses = [...new Set(rows.map((r) => r.status))].sort();
  const shown = filter ? rows.filter((r) => r.status === filter) : rows;
  const open = rows.find((r) => r.id === openId);

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <div className="banner" data-tone="dashed" role="note">
        <Info size={16} aria-hidden="true" />
        <span>
          <strong>Not connected yet.</strong> No server API exists for {mod.title.toLowerCase()}, so this page shows <strong>demo values</strong>.
          {" "}Anything you create or change is kept in this browser only: it is not sent to the server and moves no money.
          {mod.note ? ` ${mod.note}` : ""}
        </span>
      </div>
      {mod.extra === "checkout" && <CheckoutPreview />}
      {mod.extra === "sigma" && <SigmaBox />}
      {mod.extra === "pricing" && <PricingPreview />}
      {mod.extra === "keys" && <ApiKeysPanel />}
      {mod.extra === "capital" && <CapitalOffer status={rows[0]?.status ?? "OFFERED"} />}
      {mod.extra === "cards" && <CardVisuals rows={rows} />}
      <div className="card">
        <header className="card-head">
          <div style={{ display: "grid", gap: 2 }}>
            <span className="eyebrow">{id} · demo values</span>
            <h2>{mod.title}</h2>
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <NotBuiltBadge />
            {statuses.length > 1 && (
              <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by status">
                <option value="">All statuses</option>
                {statuses.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </select>
            )}
            {mod.create && <CreateButton spec={mod.create} onClick={() => setCreating(true)} />}
          </div>
        </header>
        {!shown.length ? (
          <div className="card-body"><EmptyState title={`No ${mod.noun}s`}>{mod.create ? `Use “${mod.create.label}” to add one.` : "Nothing matches this filter."}</EmptyState></div>
        ) : (
          <div className="card-body flush">
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">{mod.title}. Select a row for details.</caption>
                <thead><tr><th>ID</th><th>Status</th>{mod.columns.map((c) => <th key={c.key} className={c.kind === "money" ? "right" : undefined}>{c.label}</th>)}<th>Source</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id} className="clickable" aria-selected={r.id === openId} onClick={() => setOpenId(r.id)}>
                      <td><button className="btn btn-sm btn-ghost mono" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}>{r.id}</button></td>
                      <td><StatusBadge status={r.status} /></td>
                      {mod.columns.map((c) => <td key={c.key} className={c.kind === "money" ? "right" : undefined}><FieldDisplay value={r.fields[c.key]} kind={c.kind} /></td>)}
                      <td>{r.local ? <span className="badge badge-dashed">LOCAL DRAFT</span> : <span className="badge">DEMO</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot"><span>{shown.length} {mod.noun}{shown.length === 1 ? "" : "s"}</span><span>Demo values · this browser only</span></div>
          </div>
        )}
      </div>
      {open && (
        <Drawer
          title={<span className="mono">{open.id}</span>}
          subtitle={`${mod.title} · ${open.local ? "local draft" : "demo value"}`}
          onClose={() => setOpenId(undefined)}
          footer={<>
            {open.local && <button className="btn" onClick={() => { remove(open.id); setOpenId(undefined); }}><Trash2 size={13} aria-hidden="true" /> Remove draft</button>}
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => setOpenId(undefined)}>Close</button>
          </>}
        >
          <div className="row-between"><StatusBadge status={open.status} />{open.createdAt && <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>Created <FieldDisplay value={open.createdAt} kind="date" /></span>}</div>
          <dl className="kv">
            {mod.columns.map((c) => <div key={c.key} style={{ display: "contents" }}><dt>{c.label}</dt><dd><FieldDisplay value={open.fields[c.key]} kind={c.kind} /></dd></div>)}
          </dl>
          {(id === "ZP-STR-032" || id === "ZP-STR-033") && (
            <section className="stack" style={{ gap: 8 }}>
              <h3>{id === "ZP-STR-032" ? "Event data" : "Response body"}</h3>
              <pre className="demo-json">{JSON.stringify(id === "ZP-STR-032"
                ? { id: open.id, object: "event", type: open.fields.type, livemode: false, data: { object: { id: open.fields.resource } } }
                : Number(open.fields.code) < 300 ? { object: String(open.fields.path ?? "").split("/")[2]?.replace(/s$/, ""), id: "obj_demo" } : { error: { type: open.fields.code === "402" ? "card_error" : "invalid_request_error", message: open.fields.code === "402" ? "Your card was declined." : "No such resource." } }, null, 2)}</pre>
            </section>
          )}
          <LocalActionButtons screenId={id} id={open.id} status={open.status} fields={open.fields} />
        </Drawer>
      )}
      {creating && mod.create && <CreateDialog spec={mod.create} screenId={id} onClose={close} />}
    </div>
  );
}

/**
 * A Stripe-parity page: server TEST fixtures (with a short note and any preview)
 * where the console server provides them, otherwise browser-only demo values.
 */
export function ParityScreen({ id }: { id: string }) {
  const mod = MODULES[id];
  if (!SERVER_MODULES.has(id) || !mod) return <ModuleView id={id} />;
  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <div className="banner" data-tone="dashed" role="note">
        <Info size={16} aria-hidden="true" />
        <span><strong>TEST records from the console server.</strong> {mod.intent} Requests and approvals are checked and audited by the server; nothing reaches a bank or provider and no money moves.{mod.note ? ` ${mod.note}` : ""}</span>
      </div>
      {mod.extra === "sigma" && <SigmaBox />}
      {mod.extra === "capital" && <CapitalOffer status="OFFERED" />}
      <ScreenView screenId={id} />
    </div>
  );
}
