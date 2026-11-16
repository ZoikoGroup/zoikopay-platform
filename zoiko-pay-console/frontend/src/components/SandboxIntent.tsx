import { RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSession } from "../hooks/useSession";
import { api } from "../services/api";
import { currencyExponent, formatMoney, formatDateTimeFull } from "../services/format";
import { ApiError } from "../services/http";
import type { SandboxIntent as Intent } from "../types/api";
import { Card } from "./Card";
import { StatusBadge } from "./StatusBadge";

const newKey = () => `idem_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

/**
 * ZP-BRW-004 Payment Intent & Checkout Integration (sandbox).
 * Builds a create-intent request, validates it on the server and shows the
 * response preview. Nothing is sent to the payment gateway.
 */
export function SandboxIntent() {
  const { scope } = useSession();
  const merchants = scope?.merchants ?? [];
  const [form, setForm] = useState({ merchantId: merchants[0]?.id ?? "", amount_minor: "1999", currency: merchants[0]?.currencies[0] ?? "GBP",
    capture_mode: "automatic", order_ref: "ORDER-1001" });
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Intent>();
  const [error, setError] = useState<ApiError>();
  const merchant = merchants.find((m) => m.id === form.merchantId);
  const display = /^[1-9]\d{0,14}$/.test(form.amount_minor) ? formatMoney(form.amount_minor, form.currency) : "—";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setResult((await api.sandboxIntent(key, form)).data);
    } catch (err) {
      setResult(undefined);
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Unexpected error"));
    } finally {
      setBusy(false);
    }
  };

  if (!merchants.length) return <Card><p className="muted">No merchant in your scope can create payment intents.</p></Card>;

  return (
    <div className="grid grid-12">
      <Card className="span-6" title="Create intent" eyebrow="TEST sandbox · POST /v1/payment_intents">
        <form className="stack" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="sb-merchant">Merchant</label>
            <select id="sb-merchant" className="select" value={form.merchantId}
              onChange={(e) => { const m = merchants.find((x) => x.id === e.target.value); setForm({ ...form, merchantId: e.target.value, currency: m?.currencies[0] ?? form.currency }); }}>
              {merchants.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </div>
          <div className="detail-grid">
            <div className="field">
              <label htmlFor="sb-amount">amount_minor (integer)</label>
              <input id="sb-amount" className="input mono" inputMode="numeric" value={form.amount_minor} onChange={(e) => setForm({ ...form, amount_minor: e.target.value.trim() })} />
              <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>Display amount: {display} · exponent {currencyExponent(form.currency)}</span>
            </div>
            <div className="field">
              <label htmlFor="sb-currency">Currency (authorized)</label>
              <select id="sb-currency" className="select" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                {(merchant?.currencies ?? []).map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="detail-grid">
            <div className="field">
              <label htmlFor="sb-capture">capture_mode</label>
              <select id="sb-capture" className="select" value={form.capture_mode} onChange={(e) => setForm({ ...form, capture_mode: e.target.value })}>
                <option value="automatic">automatic</option><option value="manual">manual</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="sb-order">Order reference</label>
              <input id="sb-order" className="input" value={form.order_ref} onChange={(e) => setForm({ ...form, order_ref: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="sb-key">Idempotency-Key (required for money-affecting POST)</label>
            <div className="row">
              <input id="sb-key" className="input mono" style={{ flex: 1 }} value={key} onChange={(e) => setKey(e.target.value.trim())} />
              <button type="button" className="btn btn-sm" onClick={() => setKey(newKey())}><RefreshCw size={13} aria-hidden="true" /> New key</button>
            </div>
            <span className="subtle" style={{ fontSize: "var(--fs-xs)" }}>Same key + same request returns the same response; same key + different request is refused (04-08).</span>
          </div>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Validating…" : "Validate and preview"}</button>
        </form>
      </Card>

      <Card className="span-6" title="Response preview" eyebrow="Simulated: nothing is sent to the gateway">
        {error ? (
          <div className="banner" data-tone="strong" role="alert">
            <span><strong>{error.status} {error.code}.</strong> {error.detail ?? error.title}
              {error.fields?.map((f) => <span key={f.path} style={{ display: "block" }} className="mono">{f.path}: {f.message}</span>)}</span>
          </div>
        ) : !result ? (
          <p className="muted">Submit the form to see the response the API would return.</p>
        ) : (
          <div className="stack">
            <div className="row-between">
              <StatusBadge status={result.status} />
              <span className="badge badge-dashed">{result.idempotent_replay ? "IDEMPOTENT REPLAY" : "NEW"}</span>
            </div>
            <dl className="kv">
              <dt>intent_id</dt><dd className="mono">{result.id}</dd>
              <dt>status</dt><dd className="mono">{result.status}</dd>
              <dt>next_action</dt><dd className="mono">null</dd>
              <dt>amount</dt><dd>{formatMoney(result.amount_minor, result.currency)} <span className="subtle">({result.amount_minor} minor units)</span></dd>
              <dt>created_at</dt><dd className="num">{formatDateTimeFull(result.created_at)}</dd>
              <dt>client token</dt><dd className="mono">{result.client_token_ref}</dd>
            </dl>
            <p className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{result.notice} Callback URLs must be on the merchant's allow-list; errors use typed codes with a correlation id.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
