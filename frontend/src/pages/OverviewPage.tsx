import { Activity, ArrowLeftRight, KeyRound, Lightbulb, PencilLine, X, ArrowRight, Banknote, BarChart3, CheckCircle2, CircleAlert, Clock3, Code2, CreditCard, FileCheck2, Globe2, Info, Layers3, ListChecks, PlusCircle, ShieldCheck, TriangleAlert, Undo2, Wallet, Webhook, Zap } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Card } from '../components/Card';
import { FieldDisplay } from '../components/ScreenView';
import { PaymentDrawer } from '../components/payments';
import { TodayVsYesterday } from '../components/DemoExtras';
import { EmptyState, ErrorState, NoPermission, Skeleton, SourceBadge } from '../components/States';
import { StatusBadge } from '../components/StatusBadge';
import { useApi } from '../hooks/useApi';
import { useSession } from '../hooks/useSession';
import dots from '../assets/world-dots.svg';
import { api } from '../services/api';
import { formatCount, formatDay, formatMoney, formatRelative, humanize, percentChange, percentChangeMinor } from '../services/format';
import type { ActivityResponse, Kpi, Period, Permission, RecordView } from '../types/api';

type Glyph = typeof Activity;
function ReadMore({ to, children = 'View all' }: { to: string; children?: ReactNode }) {
  return <Link className="cc-more" to={to}>{children}<ArrowRight size={13} /></Link>;
}
function Figure({ label, value, icon: Icon, hint, tone }: { label: string; value: ReactNode; icon: Glyph; hint: string; tone?: string }) {
  return <article className="cc-metric" data-tone={tone}><Icon size={27} strokeWidth={1.8} /><div><h2>{label}</h2><strong className="cc-figure num">{value}</strong><span>{hint}</span></div></article>;
}
function numeric(kpi?: Kpi) {
  if (kpi?.restricted) return 'Restricted';
  if (!kpi || kpi.value === null) return '—';
  return kpi.unit === 'minor' ? formatMoney(kpi.value, kpi.currency ?? 'GBP') : kpi.unit === 'percent' ? kpi.value + '%' : kpi.unit === 'count' ? formatCount(kpi.value) : kpi.value;
}
function moneyFrom(rows: RecordView[], field: string, currency: string) {
  return rows.reduce((sum, row) => {
    const value = row.fields[field];
    return value && typeof value === 'object' && !Array.isArray(value) && 'minor' in value && 'currency' in value && value.currency === currency && typeof value.minor === 'string' && /^-?\d+$/.test(value.minor) ? sum + BigInt(value.minor) : sum;
  }, 0n).toString();
}
const colors = ['#009f43', '#176bda', '#9448d1', '#e7ad27'];
const PERIOD_LABEL: Record<Period, string> = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' };
const PREVIOUS_LABEL: Record<Period, string> = { '24h': 'previous 24 hours', '7d': 'previous 7 days', '30d': 'previous 30 days' };
/** "+4.2% vs previous 7 days", as Stripe's "Compare: previous period". */
function compared(kpi: Kpi | undefined, period: Period): string | null {
  if (!kpi || kpi.restricted || kpi.value === null || kpi.previous === null) return null;
  if (kpi.unit === 'minor') { const change = percentChangeMinor(kpi.value, kpi.previous); return change && change + ' vs ' + PREVIOUS_LABEL[period]; }
  if (kpi.unit === 'percent') { const delta = Number(kpi.value) - Number(kpi.previous); return Number.isFinite(delta) ? (delta >= 0 ? '+' : '−') + Math.abs(delta).toFixed(1) + ' pts vs ' + PREVIOUS_LABEL[period] : null; }
  const change = percentChange(kpi.value, kpi.previous); return change && change + ' vs ' + PREVIOUS_LABEL[period];
}
type FlowMode = 'volume' | 'transactions' | 'success';
function FlowChart({ data, mode, period }: { data: ActivityResponse; mode: FlowMode; period: Period }) {
  const tick = (start: string) => period === '24h' ? new Date(start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : formatDay(start);
  const id = useId();
  const values = data.buckets.map((bucket) => mode === 'volume' ? Number(bucket.volumeMinor ?? '0') : mode === 'transactions' ? bucket.count : bucket.count ? bucket.succeeded / bucket.count * 100 : 0);
  const maximum = mode === 'success' ? 100 : Math.max(1, ...values) * 1.12;
  const positions = values.map((value, index) => [58 + index / Math.max(1, values.length - 1) * 430, 165 - value / maximum * 143]);
  const path = positions.map(([x, y], index) => (index ? 'L' : 'M') + x + ',' + y).join(' ');
  const label = mode === 'volume' ? 'Payment volume (' + data.currency + ')' : mode === 'transactions' ? 'Transactions' : 'Success rate';
  const valueAt = (index: number) => {
    const bucket = data.buckets[index];
    if (!bucket) return '—';
    return mode === 'volume' ? formatMoney(bucket.volumeMinor ?? '0', data.currency) : mode === 'transactions' ? formatCount(bucket.count) : bucket.count ? (bucket.succeeded / bucket.count * 100).toFixed(1) + '%' : 'No transactions';
  };
  return <div className="cc-flow-chart"><svg viewBox="0 0 510 199" role="img" aria-label={label + ', ' + PERIOD_LABEL[period]}><defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop stopColor="#00c34c" stopOpacity=".4" /><stop offset="1" stopColor="#00c34c" stopOpacity=".03" /></linearGradient></defs>{[0, .25, .5, .75, 1].map((ratio) => <g key={ratio}><line x1="58" x2="490" y1={165 - ratio * 143} y2={165 - ratio * 143} stroke="var(--chart-grid)" /><text x="48" y={168 - ratio * 143} textAnchor="end" fontSize="9" fill="var(--text-2)">{mode === 'volume' ? formatMoney(Math.round(maximum * ratio).toString(), data.currency, { compact: true }) : Math.round(maximum * ratio) + (mode === 'success' ? '%' : '')}</text></g>)}{positions.length > 0 && <><path d={path + ' L488,165 L58,165 Z'} fill={'url(#' + id + ')'} /><path d={path} fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeLinejoin="round" /></>}{data.buckets.map((bucket, index) => index % Math.max(1, Math.ceil(data.buckets.length / 6)) === 0 || index === data.buckets.length - 1 ? <g key={bucket.start}><circle cx={positions[index]?.[0]} cy={positions[index]?.[1]} r="3" fill="#fff" stroke="var(--brand)" strokeWidth="1.7"><title>{tick(bucket.start) + ': ' + valueAt(index)}</title></circle><text x={positions[index]?.[0]} y="186" textAnchor="middle" fontSize="8" fill="var(--text-2)">{tick(bucket.start)}</text></g> : null)}</svg><details className="cc-chart-data"><summary>Show chart data</summary><div className="table-wrap"><table className="table"><caption className="sr-only">{label}</caption><thead><tr><th>Date</th><th>{label}</th></tr></thead><tbody>{data.buckets.map((bucket, index) => <tr key={bucket.start}><td>{tick(bucket.start)}</td><td>{valueAt(index)}</td></tr>)}</tbody></table></div></details></div>;
}
function RecordSchedule({ rows }: { rows: RecordView[] }) {
  return <ul className="cc-schedule">{rows.slice(0, 3).map((row) => {
    const rawDate = row.fields.approvalDeadline ?? row.fields.statementDate ?? row.updatedAt;
    const date = new Date(String(rawDate));
    const valid = Number.isFinite(date.getTime());
    const target = row.id.startsWith('po_') ? '/payouts?screen=ZP-BRW-010&record=' : '/finance?screen=ZP-BRW-009&record=';
    return <li key={row.id}><span className="cc-date"><small>{valid ? date.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }).toUpperCase() : '—'}</small><strong>{valid ? date.getUTCDate() : '—'}</strong></span><div><strong><FieldDisplay value={row.fields.amount ?? row.fields.expectedNet} /></strong><small><FieldDisplay value={row.fields.beneficiary ?? row.fields.merchant ?? row.id} /></small></div><Link to={target + encodeURIComponent(row.id)}><StatusBadge status={row.status} /></Link></li>;
  })}</ul>;
}
const WIDGETS = [
  { key: 'today', label: 'Today vs yesterday' }, { key: 'keys', label: 'API keys' }, { key: 'tips', label: 'Recommendations' }, { key: 'flow', label: 'Payment volume' },
  { key: 'regions', label: 'Activity by region' }, { key: 'alerts', label: 'Alerts and tasks' }, { key: 'lifecycle', label: 'Payment lifecycle' },
  { key: 'health', label: 'Operational health' }, { key: 'transactions', label: 'Recent transactions' }, { key: 'upcoming', label: 'Settlements and payouts' },
  { key: 'integrations', label: 'Integrations' }, { key: 'quick', label: 'Quick actions' },
] as const;
type WidgetKey = (typeof WIDGETS)[number]['key'];
const HIDDEN_KEY = 'zp.console.overviewHidden';
const TIPS_KEY = 'zp.console.dismissedTips';
function readList(key: string): string[] {
  try { const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
function saveList(key: string, list: string[]) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* convenience only */ }
}
const TIPS: { key: string; title: string; text: string; to: string; label: string; permission: Permission }[] = [
  { key: 'products', title: 'Set up your product catalogue', text: 'Add products and prices so you can create payment links, invoices and subscriptions.', to: '/commerce?screen=ZP-COM-002', label: 'Open product catalogue', permission: 'area.payment_operations' },
  { key: 'recovery', title: 'Recover failed payments', text: 'Retry failed subscription payments automatically and send reminder emails.', to: '/billing?screen=ZP-STR-008', label: 'Explore revenue recovery', permission: 'area.payment_operations' },
  { key: 'webhooks', title: 'Check your webhook endpoints', text: 'Make sure your systems hear about payments, refunds and disputes.', to: '/developers?view=webhooks', label: 'Review webhooks', permission: 'area.developers' },
  { key: 'payouts', title: 'Review your payout schedule', text: 'Choose how often available funds are paid out to your bank.', to: '/money?screen=ZP-STR-014', label: 'Payout schedule', permission: 'area.finance' },
];

/** Stripe home "API keys": the caller's keys, masked, from the Developer Hub screen. */
function ApiKeysCard({ rows, error }: { rows?: RecordView[]; error: boolean }) {
  const keys = (rows ?? []).filter((row) => row.fields.kind === 'API key');
  return <Card title={<span className="row"><KeyRound size={16} />API keys</span>} actions={<ReadMore to="/developers?screen=ZP-BRW-013">Go to API keys</ReadMore>}>
    {error ? <p className="cc-panel-note">API keys could not be loaded.</p> : !rows ? <Skeleton height={60} /> : !keys.length ? <p className="cc-panel-note">No API keys in your scope.</p> :
      <div>{keys.slice(0, 4).map((item) => <div key={item.id} className="key-row"><span><strong>{String(item.fields.name ?? 'Key')}</strong><small className="subtle" style={{ display: 'block' }}>{String(item.fields.merchant ?? '')}</small></span><span className="mono">{String(item.fields.value ?? '••••')}</span><StatusBadge status={item.status} /></div>)}</div>}
    <p className="cc-panel-note">Secret keys are shown masked. A full key is shown once, when it is created.</p>
  </Card>;
}

function Recommendations() {
  const { can } = useSession();
  const [dismissed, setDismissed] = useState<string[]>(() => readList(TIPS_KEY));
  const tips = TIPS.filter((tip) => can(tip.permission) && !dismissed.includes(tip.key));
  const dismiss = (key: string) => setDismissed((old) => { const next = [...old, key]; saveList(TIPS_KEY, next); return next; });
  return <Card title={<span className="row"><Lightbulb size={16} />Recommendations</span>}>
    {!tips.length ? <p className="cc-panel-note">You are all caught up.</p> : <ul className="dash-list">{tips.slice(0, 3).map((tip) => <li key={tip.key}><span><strong>{tip.title}</strong><small>{tip.text}</small><ReadMore to={tip.to}>{tip.label}</ReadMore></span><button className="icon-btn" aria-label={'Dismiss: ' + tip.title} onClick={() => dismiss(tip.key)}><X size={14} /></button></li>)}</ul>}
  </Card>;
}

function QuickLink({ to, permission, label, icon: Icon, primary = false }: { to: string; permission: Permission; label: string; icon: Glyph; primary?: boolean }) {
  const { can } = useSession();
  if (!can(permission)) return null;
  return <Link className={'btn cc-quick-link' + (primary ? ' btn-primary' : '')} to={to}><Icon size={21} /><span>{label}</span></Link>;
}

export function OverviewPage() {
  const { me, can, selection, scope } = useSession();
  const [params, setParams] = useSearchParams();
  const [flow, setFlow] = useState<FlowMode>('volume');
  const [period, setPeriod] = useState<Period>('30d');
  const [openedPayment, setOpenedPayment] = useState<string>();
  const query = { period, currency: selection.currency, merchantId: selection.merchantId || undefined };
  const key = JSON.stringify(query) + selection.legalEntityId;
  const kpis = useApi((signal) => api.kpis(query, signal), 'cc-kpis-' + key);
  const activity = useApi(can('metrics.counts.view') ? (signal) => api.activity(query, signal) : null, 'cc-activity-' + key);
  const payments = useApi(can('payments.read') ? (signal) => api.payments({ pageSize: 100, merchantId: selection.merchantId || undefined, legalEntityId: selection.legalEntityId || undefined }, signal) : null, 'cc-payments-' + key);
  const health = useApi(can('health.view') ? (signal) => api.systemHealth(signal) : null, 'cc-health', { refreshMs: 15000 });
  const notices = useApi((signal) => api.notifications(signal), 'cc-tasks', { refreshMs: 60000 });
  const settlement = useApi(can('area.finance') ? (signal) => api.screen('ZP-BRW-009', {}, signal) : null, 'cc-settlement-' + key);
  const payouts = useApi(can('area.payouts') ? (signal) => api.screen('ZP-BRW-010', {}, signal) : null, 'cc-payouts-' + key);
  const topups = useApi(can('area.finance') ? (signal) => api.screen('ZP-STR-010', {}, signal) : null, 'cc-topups-' + key);
  const transfers = useApi(can('area.finance') ? (signal) => api.screen('ZP-STR-011', {}, signal) : null, 'cc-transfers-' + key);
  const recent = useApi((signal) => api.recentActivity(signal), 'cc-recent');
  const devHub = useApi(can('area.developers') ? (signal) => api.screen('ZP-BRW-013', {}, signal) : null, 'cc-keys-' + key);
  const [hidden, setHidden] = useState<string[]>(() => readList(HIDDEN_KEY));
  const [editing, setEditing] = useState(false);
  const show = (widget: WidgetKey) => !hidden.includes(widget);
  const toggleWidget = (widget: WidgetKey) => setHidden((old) => { const next = old.includes(widget) ? old.filter((w) => w !== widget) : [...old, widget]; saveList(HIDDEN_KEY, next); return next; });
  if (!me) return null;
  const metrics = Object.fromEntries((kpis.data?.kpis ?? []).map((item) => [item.key, item]));
  const count = activity.data?.buckets.reduce((total, bucket) => total + bucket.count, 0);
  const sample = payments.data?.items ?? [];
  const recentPayments = sample.filter((payment) => payment.currency === selection.currency).slice(0, 5);
  const regionCounts = new Map<string, number>();
  sample.forEach((payment) => {
    const label = scope?.legalEntities.find((entity) => entity.id === payment.legalEntityId)?.jurisdiction ?? payment.legalEntityId;
    regionCounts.set(label, (regionCounts.get(label) ?? 0) + 1);
  });
  const currencies = new Map<string, bigint>();sample.forEach((payment) => currencies.set(payment.currency, (currencies.get(payment.currency) ?? 0n) + BigInt(payment.amountMinor)));
  const services = health.data?.services ?? [];
  const unavailable = services.filter((service) => !service.ok);
  const unread = notices.data?.filter((notice) => !notice.read) ?? [];
  const reviewAlerts = unread.filter((notice) => ['ZP-BRW-011', 'ZP-BRW-012'].includes(notice.screenId));
  const alertCount = unavailable.length + reviewAlerts.length;
  const tasks = [{ label: 'Payments Awaiting Review', screen: 'ZP-BRW-011', to: '/finance?screen=ZP-BRW-011', permission: 'area.finance' as Permission, icon: CreditCard }, { label: 'Payouts to Approve', screen: 'ZP-BRW-010', to: '/payouts', permission: 'area.payouts' as Permission, icon: ListChecks }, { label: 'Merchant Onboarding Reviews', screen: 'ZP-BRW-002', to: '/merchants?screen=ZP-BRW-002', permission: 'area.merchants' as Permission, icon: FileCheck2 }, { label: 'Compliance Checks', screen: 'ZP-BRW-012', to: '/risk', permission: 'area.risk_compliance' as Permission, icon: ShieldCheck }].filter((task) => can(task.permission));
  const queue = [...(payouts.data?.items ?? []).filter((row) => row.status === 'REQUIRES_APPROVAL' || row.status === 'READY'), ...(settlement.data?.items ?? []).filter((row) => row.status !== 'CLOSED')];
  const connectors = services.filter((service) => service.category === 'connector');
  const availability = services.flatMap((service) => service.availability ? [service.availability.percent] : []);
  const canAmounts = can('metrics.amounts.view');
  const canSettlements = can('area.finance') && canAmounts;
  const since = PERIOD_LABEL[period].replace(/^l/, 'L') + ' · ' + selection.currency;
  // Bank received on closed TEST batches + approved TEST top-ups − paid TEST transfers (exact BigInt arithmetic).
  const closedBalance = settlement.data ? (BigInt(moneyFrom(settlement.data.items.filter((row) => row.status === 'CLOSED'), 'bankReceived', selection.currency))
    + BigInt(moneyFrom((topups.data?.items ?? []).filter((row) => row.status === 'SUCCEEDED'), 'amount', selection.currency))
    - BigInt(moneyFrom((transfers.data?.items ?? []).filter((row) => row.status === 'PAID'), 'amount', selection.currency))).toString() : undefined;
  const incoming = settlement.data ? moneyFrom(settlement.data.items.filter((row) => row.status !== 'CLOSED'), 'expectedNet', selection.currency) : undefined;
  const activeFlow = !canAmounts && flow === 'volume' ? 'transactions' : flow;

  return <div className="command-center">
    <div className="cc-heading"><div><h1>Global Payment Operations Command Center <span className="version-pill">v2.0</span></h1><p>Monitor, manage, and optimise payments, settlements, and financial operations across markets and payment rails.</p></div><div className="cc-activation"><Info size={16} /><strong>Production activation pending approved release gates.</strong>{can('area.qa_release') ? <ReadMore to="/release">View Gates</ReadMore> : <span className="cc-test">TEST</span>}</div></div>
    <div className="cc-provenance"><SourceBadge source={kpis.meta?.source ?? 'fixture'} /><span>Scoped TEST records · {selection.currency} · Health is measured from local services</span><button className="btn btn-sm" aria-expanded={editing} onClick={() => setEditing((value) => !value)}><PencilLine size={13} />{editing ? 'Done' : 'Edit'}</button><div className="cc-flow-tabs cc-period" role="group" aria-label="Date range">{(['24h', '7d', '30d'] as Period[]).map((value) => <button key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{value.toUpperCase()}</button>)}</div></div>
    {editing && <fieldset className="widget-editor"><legend className="sr-only">Choose the widgets shown on your dashboard</legend>{WIDGETS.map((widget) => <label key={widget.key} className="checkbox"><input type="checkbox" checked={show(widget.key)} onChange={() => toggleWidget(widget.key)} /><span>{widget.label}</span></label>)}</fieldset>}
    {kpis.error && <ErrorState error={kpis.error} onRetry={kpis.refetch} />}
    <div className="cc-metrics">
      <Figure label="Gross Volume" value={numeric(metrics.volume)} hint={metrics.volume?.restricted ? 'Amounts are outside your role' : compared(metrics.volume, period) ?? since} icon={Layers3} />
      <Figure label="Net Volume" value={numeric(metrics.net_volume)} hint={metrics.net_volume?.restricted ? 'Amounts are outside your role' : compared(metrics.net_volume, period) ?? 'Gross minus refunds and lost disputes'} icon={Banknote} />
      <Figure label="Total Transactions" value={count === undefined ? '—' : formatCount(count)} hint={'All statuses · ' + PERIOD_LABEL[period]} icon={CreditCard} tone="blue" />
      <Figure label="Success Rate" value={numeric(metrics.success_rate)} hint={compared(metrics.success_rate, period) ?? 'Confirmed successful intents'} icon={CheckCircle2} />
      <Figure label="Dispute Rate" value={metrics.dispute_rate ? numeric(metrics.dispute_rate) : '—'} hint={!metrics.dispute_rate ? 'Dispute metrics are not connected' : metrics.dispute_rate.restricted ? 'Disputes are outside your role' : compared(metrics.dispute_rate, period) ?? 'Disputes ÷ succeeded payments'} icon={TriangleAlert} tone="red" />
      <Figure label="Balance (Test)" value={!canSettlements ? '—' : closedBalance !== undefined ? formatMoney(closedBalance, selection.currency) : '—'} hint={!canSettlements ? 'Balance source is not connected' : incoming !== undefined ? 'Incoming ' + formatMoney(incoming, selection.currency) + ' · TEST statements' : 'Closed TEST statement batches'} icon={Wallet} />
    </div>
    {params.get('view') === 'activity' && <Card className="cc-feed" title="Activity Feed" actions={<button className="btn btn-sm" onClick={() => setParams({})}>Back to Dashboard</button>}>{recent.error ? <ErrorState error={recent.error} /> : <ul className="dash-list">{recent.data?.map((item) => <li key={item.id}><span><strong>{item.title}</strong><small>{formatRelative(item.at)}</small></span>{item.resource.type === 'payment' && can('payments.read') && <button className="btn btn-sm" onClick={() => setOpenedPayment(item.resource.id)}>Inspect</button>}</li>)}</ul>}</Card>}
    {show('today') && <TodayVsYesterday />}
    {(show('keys') && can('area.developers')) || show('tips') ? <div className="cc-side-cards">{show('keys') && can('area.developers') && <ApiKeysCard rows={devHub.data?.items} error={!!devHub.error} />}{show('tips') && <Recommendations />}</div> : null}
    <div className="cc-grid">
      {show('flow') && <Card className="cc-flow" title={<span className="row">Payment Volume & Flow <Info size={13} className="subtle" /></span>} actions={<div className="cc-flow-tabs" role="group" aria-label="Payment flow metric">{([{ id: 'volume', label: 'Volume' }, { id: 'transactions', label: 'Transactions' }, { id: 'success', label: 'Success Rate' }] as const).map((tab) => <button key={tab.id} aria-pressed={activeFlow === tab.id} disabled={tab.id === 'volume' && !canAmounts} onClick={() => setFlow(tab.id)}>{tab.label}</button>)}</div>}>
        {activity.error ? <ErrorState error={activity.error} onRetry={activity.refetch} /> : !can('metrics.counts.view') ? <NoPermission /> : !activity.data ? <Skeleton height={195} /> : <div className="cc-flow-body"><FlowChart data={activity.data} mode={activeFlow} period={period} /><div className="cc-currency-legend"><span className="cc-mini-caption">Requested sample amounts</span>{[...currencies].map(([currency, amount], index) => <div key={currency}><span className="dash-dot" style={{ background: colors[index % colors.length] }} /><strong>{currency}</strong><span>{canAmounts ? formatMoney(amount.toString(), currency) : 'Restricted'}</span></div>)}{!currencies.size && <p>Currency detail requires access to payment records.</p>}</div></div>}
      </Card>}
      {show('regions') && <Card className="cc-regions" title={<span className="row">Payment Activity by Region <Info size={13} className="subtle" /></span>}><div className="cc-region-body"><div className="cc-map"><img src={dots} alt="" /><Globe2 className="cc-map-glow" aria-hidden="true" /></div><ul>{[...regionCounts].map(([label, total], index) => <li key={label}><span className="dash-dot" style={{ background: colors[index % colors.length] }} /><span>{label}</span><strong>{sample.length ? (total / sample.length * 100).toFixed(1) : '0'}%</strong></li>)}</ul></div><p className="cc-panel-note">{payments.data ? 'Transaction counts in the first ' + sample.length + ' scoped records; not FX-converted volume.' : 'Regional breakdown requires permission to view payment records.'}</p></Card>}
      {show('alerts') && <div className="cc-actions-column"><Card title={<>Operational Alerts <span className="cc-red">({alertCount})</span></>} actions={can('health.view') ? <ReadMore to="/operations?view=alerts" /> : undefined}><ul className="cc-alert-list">{unavailable.slice(0, 3).map((service) => <li key={service.name}><TriangleAlert size={16} /><span><strong>{humanize(service.name)}</strong> is not responding</span></li>)}{reviewAlerts.slice(0, 3).map((notice) => <li key={notice.id}><CircleAlert size={16} /><span>{notice.title}</span></li>)}</ul>{!alertCount && <p className="cc-panel-note">No alerts are visible in your current scope.</p>}</Card>
        <Card title="Approvals & Tasks"><ul className="cc-task-list">{tasks.map((task) => { const Icon = task.icon;const total = unread.filter((notice) => notice.screenId === task.screen).length;return <li key={task.screen}><Link to={task.to}><Icon size={17} /><span>{task.label}</span><strong>{total}</strong></Link></li>; })}</ul>{!tasks.length && <p className="cc-panel-note">Your role has no approval queues.</p>}</Card></div>}
      {show('lifecycle') && <Card className="cc-lifecycle" title="Payment Lifecycle" eyebrow="Current scoped sample · intent states"><div className="cc-lifecycle-steps">{[{ status: 'REQUIRES_CAPTURE', label: 'Awaiting Capture', icon: CreditCard }, { status: 'SUCCEEDED', label: 'Succeeded', icon: CheckCircle2 }, { status: 'PROCESSING', label: 'Processing', icon: Clock3 }, { status: 'FAILED', label: 'Failed', icon: CircleAlert }].map(({ status, label, icon: Icon }) => <div key={status}><span className="cc-life-icon"><Icon size={23} /></span><span><small>{label}</small><strong>{payments.data ? formatCount(sample.filter((payment) => payment.status === status).length) : '—'}</strong></span></div>)}</div></Card>}
      {show('health') && <Card className="cc-operational-health" title="Operational Health"><div className="cc-health-grid"><div data-ok={connectors.length > 0 && connectors.every((service) => service.ok)}>{connectors.length > 0 && connectors.every((service) => service.ok) ? <CheckCircle2 size={21} /> : <CircleAlert size={21} />}<span><small>Local Connectors</small><strong>{health.data ? connectors.filter((item) => item.ok).length + ' / ' + connectors.length : '—'}</strong><em>Measured probes</em></span></div><div data-ok={services.length > 0 && unavailable.length === 0}>{services.length > 0 && unavailable.length === 0 ? <CheckCircle2 size={21} /> : <CircleAlert size={21} />}<span><small>Services</small><strong>{health.data ? services.filter((item) => item.ok).length + ' / ' + services.length : '—'}</strong><em>Currently healthy</em></span></div><div data-ok={availability.length > 0 && availability.every((value) => value === 100)}>{availability.length > 0 && availability.every((value) => value === 100) ? <CheckCircle2 size={21} /> : <CircleAlert size={21} />}<span><small>Availability</small><strong>{availability.length ? (availability.reduce((sum, value) => sum + value, 0) / availability.length).toFixed(1) + '%' : '—'}</strong><em>Since monitor start</em></span></div></div>{!can('health.view') && <p className="cc-panel-note">Health probes are outside your role.</p>}</Card>}
      {show('transactions') && <Card className="cc-transactions" title="Recent Transactions" flush actions={can('area.payment_operations') ? <ReadMore to="/payments?view=transactions">View All Transactions</ReadMore> : undefined}>{payments.error ? <ErrorState error={payments.error} onRetry={payments.refetch} /> : !can('payments.read') ? <NoPermission /> : !payments.data ? <Skeleton height={180} /> : !recentPayments.length ? <EmptyState title="No matching transactions" /> : <div className="table-wrap"><table className="table"><caption className="sr-only">Recent scoped transactions in {selection.currency}</caption><thead><tr><th>Transaction ID</th><th>Customer / Merchant</th><th>Method</th><th>Amount</th><th>Status</th></tr></thead><tbody>{recentPayments.map((payment) => <tr key={payment.id}><td><button className="cc-id" onClick={() => setOpenedPayment(payment.id)}>{payment.id.slice(0, 16)}…</button></td><td>{payment.merchantName}</td><td><span className="cc-method">{payment.method?.brand.toUpperCase() ?? 'Restricted'}</span></td><td className="num">{formatMoney(payment.amountMinor, payment.currency)}</td><td><StatusBadge status={payment.status} /></td></tr>)}</tbody></table></div>}</Card>}
      {show('upcoming') && <Card className="cc-upcoming" title="Settlements & Payout Reviews" actions={can('area.payouts') ? <ReadMore to="/payouts" /> : can('area.finance') ? <ReadMore to="/finance" /> : undefined}>{queue.length ? <RecordSchedule rows={queue} /> : payouts.error ? <ErrorState error={payouts.error} /> : settlement.error ? <ErrorState error={settlement.error} /> : <p className="cc-panel-note">{can('area.payouts') || can('area.finance') ? 'No pending records are available in this scope.' : 'Settlement and payout records are outside your role.'}</p>}<p className="cc-panel-note">Review deadlines and statement dates · not a dispatch schedule.</p></Card>}
      {show('integrations') && <Card className="cc-integrations" title="Integrations & Platform" actions={can('area.developers') ? <ReadMore to="/developers">Manage</ReadMore> : undefined}><ul className="cc-integration-list">{[{ label: 'Payment API', note: 'Business routes not mounted', icon: Code2, status: 'DISABLED' }, { label: 'Webhooks', note: 'Development endpoint fixtures', icon: Webhook, status: 'UNVERIFIED' }, { label: 'Payouts (Banking)', note: 'No live payout connector', icon: Layers3, status: 'DISABLED' }, { label: 'Fraud & Risk', note: 'TEST control records only', icon: ShieldCheck, status: 'UNVERIFIED' }].map(({ label, note, icon: Icon, status }) => <li key={label}><Icon size={25} /><span><strong>{label}</strong><small>{note}</small></span><StatusBadge status={status} /></li>)}</ul></Card>}
    </div>
    {show('quick') && <section className="cc-quick-actions" aria-label="Quick Actions"><h2><Zap size={26} />Quick Actions</h2><QuickLink to="/payments?screen=ZP-BRW-004" permission="area.payment_operations" label="Create a Payment" icon={PlusCircle} primary /><QuickLink to="/refunds" permission="area.refunds_disputes" label="Review a Refund" icon={Undo2} /><QuickLink to="/payouts" permission="area.payouts" label="Review Payouts" icon={ArrowLeftRight} /><QuickLink to="/finance?screen=ZP-BRW-009" permission="area.finance" label="Reconcile Transactions" icon={Layers3} /><QuickLink to="/reports?view=exports" permission="overview.view" label="Generate a Report" icon={BarChart3} /></section>}
    {openedPayment && <PaymentDrawer id={openedPayment} onClose={() => setOpenedPayment(undefined)} />}
  </div>;
}
