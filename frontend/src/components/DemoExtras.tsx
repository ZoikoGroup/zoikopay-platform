import { Copy, Eye, RefreshCw } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { LOCAL_ACTIONS, MODULES, SERVER_MODULES, type LocalAction } from "../screens/parity";
import type { FieldValue } from "../types/api";
import { recordEvent, showToast, useLocalDrafts, useLocalStatus } from "./LocalDrafts";

/**
 * Stripe-style previews and demo buttons. Frontend only: every value here is a
 * demo value, every change stays in this browser, nothing reaches the server.
 */

/** Demo buttons for one record: each changes its status in this browser only. */
export function LocalActionButtons({ screenId, id, status, fields }: { screenId: string; id: string; status: string; fields: Record<string, FieldValue> }) {
  const { set } = useLocalStatus(screenId);
  const actions = SERVER_MODULES.has(screenId) ? [] : (MODULES[screenId]?.actions ?? LOCAL_ACTIONS[screenId] ?? []).filter((a) => a.from.includes(status) && (!a.match || a.match(fields)));
  if (!actions.length) return null;
  const run = (a: LocalAction) => {
    if (a.to !== status) set(id, a.to);
    if (a.emit) recordEvent(a.emit, id);
    showToast(a.toast ?? `${a.label}: done (demo, this browser only)`);
  };
  return (
    <div className="demo-actions" role="group" aria-label="Demo actions">
      <span className="eyebrow">Demo actions · this browser only</span>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {actions.map((a) => <button key={a.label} className={`btn btn-sm ${a.danger ? "" : "btn-primary"}`} data-danger={a.danger || undefined} onClick={() => run(a)}>{a.label}</button>)}
      </div>
    </div>
  );
}

/** Applies demo status changes to a status. */
export function useDemoStatus(screenId: string) {
  const { map } = useLocalStatus(screenId);
  const server = SERVER_MODULES.has(screenId);
  return (id: string, status: string) => (server ? status : map[id] ?? status);
}

// ------------------------------------------------------------------ checkout
export function CheckoutPreview() {
  const { add } = useLocalDrafts("ZP-STR-015");
  const [card, setCard] = useState("4242 4242 4242 4242");
  const [email, setEmail] = useState("test.buyer@example.com");
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const ids = useId();
  const pay = (e: FormEvent) => {
    e.preventDefault();
    const digits = card.replace(/\s/g, "");
    if (!/^\d{16}$/.test(digits)) { setResult({ ok: false, text: "Enter a 16-digit test card number." }); return; }
    const declined = digits.endsWith("0002") || digits.endsWith("9995");
    const now = new Date();
    const id = `cs_demo_${now.getTime().toString(36)}`;
    add({ id, status: declined ? "EXPIRED" : "COMPLETE", fields: { merchant: "Kestrel Studio UK", mode: "Subscription", amount: { minor: "2900", currency: "GBP" }, successUrl: "https://kestrel.example/thanks" }, createdAt: now.toISOString(), createdBy: email });
    recordEvent(declined ? "payment_intent.payment_failed" : "checkout.session.completed", id);
    setResult(declined ? { ok: false, text: digits.endsWith("9995") ? "Declined: insufficient funds. Try 4242 4242 4242 4242." : "Your card was declined. Try 4242 4242 4242 4242." } : { ok: true, text: "Payment succeeded. The session is listed below (demo)." });
  };
  return (
    <section className="card demo-checkout" aria-label="Checkout preview">
      <div className="demo-checkout-summary">
        <span className="eyebrow">Kestrel Studio UK · demo</span>
        <span>Subscribe to Studio Pro</span>
        <strong className="demo-big num">£29.00 <small className="subtle">per month</small></strong>
        <dl className="kv"><dt>Studio Pro × 1</dt><dd className="num">£29.00</dd><dt>VAT (20%, included)</dt><dd className="num">£4.83</dd><dt><strong>Total due today</strong></dt><dd className="num"><strong>£29.00</strong></dd></dl>
      </div>
      <form className="stack demo-checkout-form" onSubmit={pay}>
        <div className="field"><label htmlFor={`${ids}-email`}>Email</label><input id={`${ids}-email`} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor={`${ids}-card`}>Card information</label><input id={`${ids}-card`} className="input mono" inputMode="numeric" value={card} onChange={(e) => setCard(e.target.value)} /><span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>Test cards: 4242 4242 4242 4242 succeeds · 4000 0000 0000 0002 is declined</span></div>
        <div className="row" style={{ gap: 10 }}>
          <div className="field" style={{ flex: 1 }}><label htmlFor={`${ids}-exp`}>Expiry</label><input id={`${ids}-exp`} className="input mono" defaultValue="12 / 34" /></div>
          <div className="field" style={{ flex: 1 }}><label htmlFor={`${ids}-cvc`}>CVC</label><input id={`${ids}-cvc`} className="input mono" defaultValue="123" /></div>
        </div>
        <button className="btn btn-primary">Subscribe</button>
        {result && <div className="banner" data-tone={result.ok ? undefined : "strong"} role="status"><span>{result.text}</span></div>}
      </form>
    </section>
  );
}

// --------------------------------------------------------------------- cards
export function CardVisuals({ rows }: { rows: { id: string; status: string; fields: Record<string, FieldValue> }[] }) {
  return (
    <div className="demo-cards">
      {rows.map((r) => (
        <div key={r.id} className="demo-card-vis" data-off={r.status !== "ACTIVE" || undefined} aria-label={`${String(r.fields.type ?? "")} card for ${String(r.fields.cardholder ?? "")}, ${r.status.toLowerCase()}`}>
          <div className="row-between"><strong>Zoiko Pay</strong><span>{String(r.fields.type ?? "")}</span></div>
          <span className="mono demo-card-num">•••• •••• •••• {String(r.fields.last4 ?? "0000")}</span>
          <div className="row-between"><span>{String(r.fields.cardholder ?? "")}</span><span>{r.status === "ACTIVE" ? "Active" : r.status === "CANCELED" ? "Canceled" : "Frozen"}</span></div>
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------- sigma
const TEMPLATES: { name: string; sql: string; rows: string[][] }[] = [
  { name: "Gross volume by month", sql: "SELECT date_trunc('month', created) AS month,\n       sum(amount) / 100.0 AS gross_gbp\nFROM charges\nWHERE status = 'succeeded'\nGROUP BY 1\nORDER BY 1 DESC;",
    rows: [["month", "gross_gbp"], ["2026-11", "£48,210.40"], ["2026-10", "£45,980.15"], ["2026-09", "£41,302.60"], ["2026-08", "£39,875.00"]] },
  { name: "Customers with failed payments", sql: "SELECT c.email, count(*) AS failures\nFROM charges ch JOIN customers c ON c.id = ch.customer_id\nWHERE ch.status = 'failed'\nGROUP BY 1 ORDER BY 2 DESC LIMIT 5;",
    rows: [["email", "failures"], ["a••••@example.com", "4"], ["m••••@example.com", "3"], ["t••••@example.com", "2"]] },
  { name: "Payments by card brand", sql: "SELECT card_brand, count(*) AS payments, sum(amount) / 100.0 AS volume_gbp\nFROM charges\nGROUP BY 1 ORDER BY 3 DESC;",
    rows: [["card_brand", "payments", "volume_gbp"], ["visa", "412", "£31,204.10"], ["mastercard", "268", "£19,880.45"], ["amex", "61", "£7,120.00"]] },
];
export function SigmaBox() {
  const [pick, setPick] = useState(0);
  const [sql, setSql] = useState(TEMPLATES[0]?.sql ?? "");
  const [out, setOut] = useState<string[][]>();
  const ids = useId();
  const tpl = TEMPLATES[pick];
  const run = () => setOut(tpl && sql.trim() === tpl.sql.trim() ? tpl.rows : [["message"], ["This demo runs the saved templates only. Choose a template to reset the query."]]);
  return (
    <section className="card" aria-label="Query editor">
      <header className="card-head">
        <div style={{ display: "grid", gap: 2 }}><span className="eyebrow">Demo results · no SQL is run</span><h2>Query editor</h2></div>
        <div className="row">
          <label className="sr-only" htmlFor={`${ids}-tpl`}>Template</label>
          <select id={`${ids}-tpl`} className="select" value={pick} onChange={(e) => { const i = Number(e.target.value); setPick(i); setSql(TEMPLATES[i]?.sql ?? ""); setOut(undefined); }}>
            {TEMPLATES.map((t, i) => <option key={t.name} value={i}>{t.name}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={run}>Run</button>
        </div>
      </header>
      <div className="card-body stack">
        <label className="sr-only" htmlFor={`${ids}-sql`}>SQL</label>
        <textarea id={`${ids}-sql`} className="textarea mono demo-sql" spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)} />
        {out ? (
          <div className="table-wrap"><table className="table"><caption className="sr-only">Query results</caption><thead><tr>{out[0]?.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{out.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="num">{c}</td>)}</tr>)}</tbody></table></div>
        ) : <span className="subtle">Press Run to see demo results.</span>}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------- pricing
export function PricingPreview() {
  const plans = [["Studio Pro", "£29", "For one designer"], ["Studio Team", "£79", "For growing teams"], ["Studio Agency", "£199", "For agencies with clients"]] as const;
  return (
    <section className="card" aria-label="Pricing table preview">
      <header className="card-head"><div style={{ display: "grid", gap: 2 }}><span className="eyebrow">Preview · demo values</span><h2>Website pricing</h2></div></header>
      <div className="card-body demo-pricing">
        {plans.map(([name, price, hint], i) => (
          <div key={name} className="demo-plan" data-featured={i === 1 || undefined}>
            <strong>{name}</strong>
            <span className="demo-big num">{price}<small className="subtle"> / month</small></span>
            <span className="subtle">{hint}</span>
            <button className={`btn ${i === 1 ? "btn-primary" : ""}`} onClick={() => showToast("Preview only: customers would go to checkout.")}>Subscribe</button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------- capital
export function CapitalOffer({ status }: { status: string }) {
  const accepted = status === "ACCEPTED";
  return (
    <section className="card demo-hero" aria-label="Financing offer">
      <span className="badge">{accepted ? "Accepted (demo)" : "Pre-approved offer (demo)"}</span>
      <h2 className="demo-big">{accepted ? "£45,000.00 on its way" : "You're eligible for £45,000.00"}</h2>
      <p className="muted">One fixed fee of £4,050.00. Repay 12% of daily sales, with no repayment on days without sales. {accepted ? "Repayment progress: £0.00 of £49,050.00." : "Open the offer below to accept it."}</p>
      {accepted && <div className="demo-progress" role="img" aria-label="Repaid 0%"><span style={{ width: "2%" }} /></div>}
    </section>
  );
}

// ---------------------------------------------------------------------- keys
const KEY_STORE = "zp.console.demoKeys";
function readKeys(): { secret: string; revealed: boolean } {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY_STORE) ?? "null");
    if (v && typeof v === "object" && "secret" in v && "revealed" in v) return v as { secret: string; revealed: boolean };
  } catch { /* fall through */ }
  return { secret: "sk_test_demo_51Zk8Qe2LmV7xR4tPa9", revealed: false };
}
export function ApiKeysPanel() {
  const [keys, setKeys] = useState(readKeys);
  const save = (next: { secret: string; revealed: boolean }) => { setKeys(next); try { localStorage.setItem(KEY_STORE, JSON.stringify(next)); } catch { /* demo only */ } };
  const publishable = "pk_test_demo_51Zk8Qe2LmV7xR4tPa9";
  const copy = (v: string) => { navigator.clipboard?.writeText(v).then(() => showToast("Copied"), () => showToast(v)); };
  const roll = () => { const s = "sk_test_demo_" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 10); save({ secret: s, revealed: true }); recordEvent("api_key.rolled", "sk_test_demo"); showToast("New secret key created (demo). The old one stops working."); };
  return (
    <section className="card" aria-label="Standard keys">
      <header className="card-head"><div style={{ display: "grid", gap: 2 }}><span className="eyebrow">Demo keys · they do not work anywhere</span><h2>Standard keys</h2></div></header>
      <div className="card-body flush"><div className="table-wrap"><table className="table">
        <caption className="sr-only">Standard API keys</caption>
        <thead><tr><th>Name</th><th>Token</th><th /></tr></thead>
        <tbody>
          <tr><td>Publishable key</td><td className="mono">{publishable}</td><td><button className="btn btn-sm btn-ghost" onClick={() => copy(publishable)} aria-label="Copy publishable key"><Copy size={13} /></button></td></tr>
          <tr><td>Secret key</td><td className="mono">{keys.revealed ? keys.secret : "sk_test_demo_••••••••••••"}</td>
            <td className="row">{keys.revealed ? <button className="btn btn-sm btn-ghost" onClick={() => copy(keys.secret)} aria-label="Copy secret key"><Copy size={13} /></button> : <button className="btn btn-sm" onClick={() => save({ ...keys, revealed: true })}><Eye size={13} /> Reveal</button>}<button className="btn btn-sm" onClick={roll}><RefreshCw size={13} /> Roll key</button></td></tr>
        </tbody>
      </table></div></div>
    </section>
  );
}

// ------------------------------------------------------------------- charts
/** Small two-line chart (today vs yesterday) with one scale, gridlines and an emphasised end point. */
export function TodayVsYesterday() {
  const hour = new Date().getHours();
  // Deterministic demo values: cumulative £ by hour.
  const wave = (h: number, k: number) => Math.round(220 + 180 * Math.sin((h + k) / 3.2) + h * 140 + ((h * 37 + k * 11) % 90));
  const cum = (upto: number, k: number) => { let acc = 0; return Array.from({ length: upto }, (_, h) => (acc += Math.max(40, wave(h, k)))); };
  const today = cum(hour + 1, 0), yesterday = cum(24, 3);
  const max = Math.max(...yesterday, ...today);
  const step = max > 20000 ? 10000 : 5000;
  const top = Math.ceil(max / step) * step;
  const W = 640, H = 170, L = 56, R = 10, T = 10, B = 24;
  const x = (i: number) => L + (i / 23) * (W - L - R), y = (v: number) => T + (1 - v / top) * (H - T - B);
  const path = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = today[today.length - 1] ?? 0;
  const fmt = (pounds: number) => "£" + pounds.toLocaleString("en-GB");
  return (
    <section className="card demo-today" aria-label="Today versus yesterday">
      <header className="card-head">
        <div className="row" style={{ gap: 28 }}>
          <div><span className="eyebrow">Gross volume · today</span><div className="demo-big num">{fmt(last)}</div></div>
          <div><span className="eyebrow">Yesterday</span><div className="demo-big num subtle">{fmt(yesterday[23] ?? 0)}</div></div>
        </div>
        <span className="badge badge-dashed">DEMO VALUES</span>
      </header>
      <div className="card-body">
        <svg viewBox={`0 0 ${W} ${H}`} className="demo-chart" role="img" aria-label={`Today ${fmt(last)} so far; yesterday ${fmt(yesterday[23] ?? 0)}`}>
          {Array.from({ length: top / step + 1 }, (_, i) => i * step).map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" /><text x={L - 8} y={y(v) + 3.5} textAnchor="end">{fmt(v)}</text></g>)}
          {[0, 6, 12, 18, 23].map((h) => <text key={h} x={x(h)} y={H - 6} textAnchor={h === 0 ? "start" : h === 23 ? "end" : "middle"}>{h === 0 ? "00:00" : h === 23 ? "23:59" : `${String(h).padStart(2, "0")}:00`}</text>)}
          <path d={path(yesterday)} fill="none" stroke="var(--line-max)" strokeWidth="1.5" strokeDasharray="4 4" />
          <path d={`${path(today)}L${x(today.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill="var(--chart-area)" />
          <path d={path(today)} fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeLinejoin="round" />
          <circle cx={x(today.length - 1)} cy={y(last)} r="3.5" fill="var(--brand)" stroke="var(--surface-1)" strokeWidth="2" />
        </svg>
        <div className="row subtle" style={{ gap: 16, fontSize: "var(--fs-xs)" }}><span><span className="demo-key" style={{ background: "var(--brand)" }} />Today</span><span><span className="demo-key" style={{ background: "var(--line-max)" }} />Yesterday</span></div>
      </div>
    </section>
  );
}

/** Live invoice preview for Settings → Invoice branding. */
export function InvoicePreview({ color, footer, prefix }: { color?: string; footer?: string; prefix?: string }) {
  const accent = /^#[0-9a-f]{6}$/i.test(color ?? "") ? color : "#008333";
  return (
    <div className="demo-invoice" aria-label="Invoice preview">
      <div style={{ background: accent, height: 8 }} />
      <div className="stack" style={{ padding: 16, gap: 10 }}>
        <div className="row-between"><strong>Zoiko Pay merchant</strong><span className="subtle mono">{(prefix || "INV")}-1042</span></div>
        <dl className="kv"><dt>Studio Pro × 1</dt><dd className="num">£29.00</dd><dt><strong>Amount due</strong></dt><dd className="num"><strong>£29.00</strong></dd></dl>
        <span className="demo-invoice-pay" style={{ background: accent }}>Pay online</span>
        <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{footer || "Thank you for your business."}</span>
      </div>
    </div>
  );
}
