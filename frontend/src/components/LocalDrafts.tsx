import { Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { useSession } from "../hooks/useSession";
import type { Column } from "../screens/config";
import type { FieldValue } from "../types/api";
import { Dialog } from "./Overlay";
import { FieldDisplay } from "./ScreenView";
import { StatusBadge } from "./StatusBadge";

/**
 * Frontend-only "create" support for screens that have no backend API yet.
 *
 * What a user creates here is a LOCAL DRAFT: it is kept in this browser
 * (localStorage) only, is never sent to the server, never reaches a PSP and
 * never moves money. Every draft is labelled as such wherever it is shown.
 */

export interface DraftField {
  key: string;
  label: string;
  /** money: a positive amount such as 12.50, kept exactly as minor units (no floats). */
  type: "text" | "email" | "money" | "number" | "select" | "date" | "url" | "textarea";
  options?: string[];
  required?: boolean;
  hint?: string;
}

export interface CreateSpec {
  label: string;
  fields: DraftField[];
  /** Status a new draft starts in, e.g. ACTIVE or REQUIRES_APPROVAL. */
  status: string;
  /** Id prefix, e.g. "cus". */
  prefix: string;
}

export interface DraftRecord {
  id: string;
  status: string;
  fields: Record<string, FieldValue>;
  createdAt: string;
  createdBy: string;
}

const DRAFTS = (screenId: string) => `zp.console.drafts.${screenId}`;
const STATUS = (screenId: string) => `zp.console.status.${screenId}`;
const CHANGED = "zp:drafts-changed";

/** Fallback when storage is blocked (private window): values then last until reload. */
const memory = new Map<string, string>();

function rawOf(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? fallback;
  } catch {
    return memory.get(key) ?? fallback;
  }
}

function parseJson<T>(raw: string, fallback: T, ok: (v: unknown) => boolean): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return ok(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeKey(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    localStorage.setItem(key, raw);
  } catch {
    // Storage blocked: the in-memory copy above is used.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: key }));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const isList = (v: unknown) => Array.isArray(v);
const isMap = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const readDrafts = (screenId: string) => parseJson<DraftRecord[]>(rawOf(DRAFTS(screenId), "[]"), [], isList);
const readStatus = (screenId: string) => parseJson<Record<string, string>>(rawOf(STATUS(screenId), "{}"), {}, isMap);

/** Drafts for one screen, kept in this browser only. */
export function useLocalDrafts(screenId: string) {
  const raw = useSyncExternalStore(subscribe, () => rawOf(DRAFTS(screenId), "[]"), () => "[]");
  const rows = useMemo(() => parseJson<DraftRecord[]>(raw, [], isList), [raw]);
  const add = useCallback((r: DraftRecord) => writeKey(DRAFTS(screenId), [r, ...readDrafts(screenId)]), [screenId]);
  const remove = useCallback((id: string) => writeKey(DRAFTS(screenId), readDrafts(screenId).filter((r) => r.id !== id)), [screenId]);
  return { rows, add, remove };
}

/**
 * Demo status changes (Refund, Void, Cancel, …) per record, kept in this
 * browser only. The server's record is never changed.
 */
export function useLocalStatus(screenId: string) {
  const raw = useSyncExternalStore(subscribe, () => rawOf(STATUS(screenId), "{}"), () => "{}");
  const map = useMemo(() => parseJson<Record<string, string>>(raw, {}, isMap), [raw]);
  const set = useCallback((id: string, status: string) => writeKey(STATUS(screenId), { ...readStatus(screenId), [id]: status }), [screenId]);
  return { map, set };
}

/** Adds a demo event to Workbench → Events, so actions leave a trace like in a real account. */
export function recordEvent(type: string, object: string) {
  const now = new Date();
  const r: DraftRecord = {
    id: `evt_demo_${now.getTime().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, status: "DELIVERED",
    fields: { type, resource: object, delivered: "200 OK (demo)" }, createdAt: now.toISOString(), createdBy: "You",
  };
  writeKey(DRAFTS("ZP-STR-032"), [r, ...readDrafts("ZP-STR-032")].slice(0, 200));
}

/** A short "Saved" style message at the bottom of the screen. */
export function showToast(message: string) {
  const el = document.createElement("div");
  el.className = "demo-toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 2600);
}

/** "12.50" → "1250". Exact string arithmetic; null when not a positive amount with ≤ 2 decimals. */
export function toMinor(major: string): string | null {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(major.trim());
  const whole = m?.[1];
  if (!m || !whole) return null;
  const minor = BigInt(whole) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return minor > 0n ? minor.toString() : null;
}

function check(f: DraftField, raw: string): string | null {
  const v = raw.trim();
  if (!v) return f.required ? "This field is required." : null;
  if (v.length > 200) return "Use at most 200 characters.";
  if (f.type === "email" && !/^[^\s@]{1,64}@[^\s@]{1,120}\.[a-z]{2,24}$/i.test(v)) return "Enter a valid email address.";
  if (f.type === "number" && !/^\d{1,9}(\.\d{1,2})?$/.test(v)) return "Enter a number.";
  if (f.type === "url" && !/^https:\/\/\S{3,190}$/.test(v)) return "Enter an https:// address.";
  if (f.type === "money" && !toMinor(v)) return "Enter a positive amount, for example 12.50.";
  if (f.type === "select" && !(f.options ?? []).includes(v)) return "Choose one of the options.";
  return null;
}

/** Emails are masked on display, as everywhere else in the console. */
const mask = (email: string) => `${email.slice(0, 1).toLowerCase()}••••@${(email.split("@")[1] ?? "").toLowerCase()}`;

/** The "+ Create" form. Saves a local draft only; says so before and after. */
export function CreateDialog({ spec, screenId, onClose, onCreated }: { spec: CreateSpec; screenId: string; onClose: () => void; onCreated?: (r: DraftRecord) => void }) {
  const { me, selection, scope } = useSession();
  const { add } = useLocalDrafts(screenId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const merchants = scope?.merchants ?? [];
  const [merchantId, setMerchantId] = useState(selection.merchantId || merchants[0]?.id || "");
  const formId = `create-${screenId}`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: Record<string, string> = {};
    for (const f of spec.fields) { const why = check(f, values[f.key] ?? ""); if (why) found[f.key] = why; }
    setErrors(found);
    if (Object.keys(found).length) return;
    const merchant = merchants.find((m) => m.id === merchantId);
    const fields: Record<string, FieldValue> = { ...(merchant ? { merchant: merchant.displayName } : {}) };
    for (const f of spec.fields) {
      const v = (values[f.key] ?? "").trim();
      if (!v) continue;
      const minor = f.type === "money" ? toMinor(v) : null;
      fields[f.key] = minor ? { minor, currency: selection.currency } : f.type === "email" ? mask(v) : v;
    }
    const now = new Date();
    const r: DraftRecord = {
      id: `${spec.prefix}_draft_${now.getTime().toString(36)}`, status: spec.status, fields,
      createdAt: now.toISOString(), createdBy: me?.displayName ?? "You",
    };
    add(r);
    recordEvent(`${spec.prefix}.created`, r.id);
    showToast(`${spec.label}: saved as a local draft`);
    onCreated?.(r);
    onClose();
  };

  return (
    <Dialog
      title={spec.label}
      description="Saved as a local draft in this browser only. It is not sent to the server, reaches no provider and moves no money."
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form={formId} data-autofocus>{spec.label}</button></>}
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        {merchants.length > 0 && (
          <div className="field">
            <label htmlFor={`${formId}-merchant`}>Merchant</label>
            <select id={`${formId}-merchant`} className="select" value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
              {merchants.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </div>
        )}
        {spec.fields.map((f) => {
          const id = `${formId}-${f.key}`;
          const set = (v: string) => setValues((old) => ({ ...old, [f.key]: v }));
          const value = values[f.key] ?? "";
          return (
            <div key={f.key} className="field" data-invalid={!!errors[f.key]}>
              <label htmlFor={id}>{f.label}{f.required ? "" : " (optional)"}{f.type === "money" ? ` · ${selection.currency}` : ""}</label>
              {f.type === "select" ? (
                <select id={id} className="select" value={value} onChange={(e) => set(e.target.value)}>
                  <option value="">Choose…</option>
                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea id={id} className="textarea" maxLength={200} value={value} onChange={(e) => set(e.target.value)} />
              ) : (
                <input id={id} className="input" maxLength={200} value={value} onChange={(e) => set(e.target.value)}
                  type={f.type === "email" ? "email" : f.type === "date" ? "date" : f.type === "url" ? "url" : "text"}
                  inputMode={f.type === "money" || f.type === "number" ? "decimal" : undefined}
                  placeholder={f.type === "money" ? "0.00" : f.type === "url" ? "https://" : undefined} />
              )}
              {f.hint && !errors[f.key] && <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{f.hint}</span>}
              {errors[f.key] && <span className="field-error" role="alert">{errors[f.key]}</span>}
            </div>
          );
        })}
      </form>
    </Dialog>
  );
}

/** Local drafts as a table, with a remove button per row. */
export function DraftsTable({ screenId, columns, noun }: { screenId: string; columns: Column[]; noun: string }) {
  const { rows, remove } = useLocalDrafts(screenId);
  if (!rows.length) return null;
  return (
    <section className="card" aria-label={`Local draft ${noun}s`}>
      <header className="card-head">
        <div style={{ display: "grid", gap: 2 }}>
          <span className="eyebrow">This browser only · not sent to the server</span>
          <h2>Local drafts ({rows.length})</h2>
        </div>
        <span className="badge badge-dashed">LOCAL DRAFT</span>
      </header>
      <div className="card-body flush">
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Local draft {noun}s</caption>
            <thead><tr><th>ID</th><th>Status</th>{columns.map((c) => <th key={c.key} className={c.kind === "money" ? "right" : undefined}>{c.label}</th>)}<th>Created</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td><StatusBadge status={r.status} /></td>
                  {columns.map((c) => <td key={c.key} className={c.kind === "money" ? "right" : undefined}><FieldDisplay value={r.fields[c.key]} kind={c.kind} /></td>)}
                  <td><FieldDisplay value={r.createdAt} kind="date" /></td>
                  <td><button className="btn btn-sm btn-ghost" onClick={() => remove(r.id)} aria-label={`Remove draft ${r.id}`}><Trash2 size={13} aria-hidden="true" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/** The "+ Create …" button; opens the form. */
export function CreateButton({ spec, onClick }: { spec: CreateSpec; onClick: () => void }) {
  return <button className="btn btn-primary btn-sm" onClick={onClick}><Plus size={14} aria-hidden="true" /> {spec.label}</button>;
}
