import { Activity, ArrowDownToLine, ArrowRight, BarChart3, BookOpen, CalendarDays, CheckCircle2, CircleAlert, Clock3, CreditCard, FileCheck2, Flag, Globe2, Layers3, Network, Plus, RefreshCw, Search, Server, ShieldCheck, Wallet, XCircle } from 'lucide-react';
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Card } from '../components/Card';
import { ActivityChart } from '../components/charts';
import { FieldDisplay, ScreenView } from '../components/ScreenView';
import { PaymentDrawer, PaymentsTable } from '../components/payments';
import { SandboxIntent } from '../components/SandboxIntent';
import { EmptyState, ErrorState, NoPermission, Skeleton, SourceBadge } from '../components/States';
import { StatusBadge } from '../components/StatusBadge';
import { useApi } from '../hooks/useApi';
import { useSession } from '../hooks/useSession';
import { api } from '../services/api';
import { formatCount, formatMoney, formatTime, humanize } from '../services/format';
import type { Kpi, Period, RecordView, ScreenList } from '../types/api';

type Icon = typeof Activity;
function Metrics({ items }: { items: { label: string; value: ReactNode; hint?: string; icon: Icon; tone?: string }[] }) {
  return <div className="metric-grid" style={{ '--metrics': items.length } as CSSProperties}>{items.map(({ label, value, hint, icon: Glyph, tone }) => <article className="metric-card" key={label} data-tone={tone}><span className="metric-icon"><Glyph size={25} strokeWidth={1.8} /></span><div><span className="metric-label">{label}</span><strong className="metric-value num">{value}</strong>{hint && <span className="metric-hint">{hint}</span>}</div></article>)}</div>;
}
function Heading({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="dash-head"><div><h1>{title}<span className="version-pill">v3.0</span></h1><p>{description}</p></div>{children}</div>;
}
function SandboxNote() {
  const { me } = useSession();
  return <div className="dash-note"><CircleAlert size={14} /><span><strong>{me?.environment === 'LIVE' ? 'Live workspace' : 'Sandbox data only'}</strong> — {me?.environment === 'LIVE' ? 'Production data requires a configured and authorized source.' : 'Illustrative TEST records. This workspace does not authorize production money movement.'}</span></div>;
}
function Tabs({ items, active, onChange }: { items: { id: string; label: string; icon: Icon }[]; active: string; onChange: (value: string) => void }) {
  return <div className="dash-tabs" role="tablist" aria-label="Workspace views">{items.map(({ id, label, icon: Glyph }) => <button key={id} className="dash-tab" role="tab" aria-selected={active === id} onClick={() => onChange(id)}><Glyph size={18} />{label}</button>)}</div>;
}
function Action({ to, icon: Glyph, children, primary = false }: { to: string; icon: Icon; children: ReactNode; primary?: boolean }) {
  return <Link to={to} className={'btn' + (primary ? ' btn-primary' : '')} style={{ textDecoration: 'none' }}><Glyph size={16} />{children}</Link>;
}
function ViewLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="dash-card-link" to={to}>{children}<ArrowRight size={13} /></Link>;
}
function kpiValue(kpi?: Kpi) {
  if (!kpi || kpi.value === null || kpi.restricted) return kpi?.restricted ? 'Restricted' : '—';
  return kpi.unit === 'minor' ? formatMoney(kpi.value, kpi.currency ?? 'GBP') : kpi.unit === 'percent' ? kpi.value + '%' : kpi.unit === 'count' ? formatCount(kpi.value) : kpi.value;
}
const COLORS = ['#009b3b', '#176bda', '#8751da', '#e6ae25', '#87a7ca'];
function Donut({ items, total, label }: { items: { label: string; value: number }[]; total: string; label: string }) {
  const sum = items.reduce((value, item) => value + item.value, 0);
  return <div className="dash-donut-wrap"><div className="dash-donut"><svg viewBox="0 0 120 120" role="img" aria-label={label + ': ' + total}><circle cx="60" cy="60" r="47" fill="none" stroke="var(--line-faint)" strokeWidth="13" />{items.map((item, i) => {
    const size = sum ? item.value / sum * 295.31 : 0;
    const start = sum ? items.slice(0, i).reduce((value, previous) => value + previous.value, 0) / sum * 295.31 : 0;
    return <circle key={item.label} cx="60" cy="60" r="47" fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="13" strokeDasharray={size + ' ' + (295.31 - size)} strokeDashoffset={-start} />;
  })}</svg><div className="dash-donut-center"><strong className="num">{total}</strong><span>{label}</span></div></div><ul className="dash-legend">{items.map((item, i) => <li key={item.label}><span className="dash-dot" style={{ background: COLORS[i % COLORS.length] }} />{item.label}<strong>{sum ? (item.value / sum * 100).toFixed(1) : '0.0'}%</strong></li>)}</ul></div>;
}
function Queue({ data, to, kind = 'Review item' }: { data?: ScreenList; to: string; kind?: string }) {
  if (!data) return <Skeleton height={155} />;
  if (!data.items.length) return <EmptyState title="No matching items">There are no records in your current scope.</EmptyState>;
  return <div className="table-wrap"><table className="table"><caption className="sr-only">{kind} queue</caption><thead><tr><th>Reference</th><th>{kind}</th><th>Updated</th><th>Status</th><th /></tr></thead><tbody>{data.items.slice(0, 5).map((row) => <tr key={row.id}><td><Link className="dash-card-link mono" to={to + (to.includes('?') ? '&' : '?') + 'record=' + encodeURIComponent(row.id)}>{row.id}</Link></td><td><FieldDisplay value={row.fields.merchant ?? row.fields.name ?? row.fields.jurisdiction ?? row.fields.provider ?? Object.values(row.fields)[0]} /></td><td className="num">{formatTime(row.updatedAt)}</td><td><StatusBadge status={row.status} /></td><td><Link to={to + (to.includes('?') ? '&' : '?') + 'record=' + encodeURIComponent(row.id)} aria-label={'Open ' + row.id}><ArrowRight size={14} /></Link></td></tr>)}</tbody></table></div>;
}
function GroupBars({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return <div className="dash-mini-chart" role="img" aria-label={items.map((item) => item.label + ': ' + item.value).join(', ')}>{items.map((item) => <div key={item.label}><span className="num">{item.value}</span><i style={{ height: Math.max(2, item.value / max * 110) }} /><span>{item.label}</span></div>)}</div>;
}
function ExportMetrics({ kpis }: { kpis: Kpi[] }) {
  const download = () => {
    const escape = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const csv = [['Metric', 'Value', 'Currency'], ...kpis.filter((item) => !item.restricted).map((item) => [item.label, item.value ?? '', item.currency ?? ''])].map((row) => row.map(escape).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');link.href = url;link.download = 'zoiko-pay-metrics.csv';link.click();URL.revokeObjectURL(url);
  };
  return <button className="btn btn-sm" onClick={download} disabled={!kpis.length}><ArrowDownToLine size={14} />Export metrics</button>;
}

function sumMoney(rows: RecordView[], field: string, currency: string): string {
  return rows.reduce((total, row) => {
    const value = row.fields[field];
    if (value && typeof value === 'object' && !Array.isArray(value) && 'minor' in value && 'currency' in value && value.currency === currency && typeof value.minor === 'string' && /^-?\d+$/.test(value.minor)) return total + BigInt(value.minor);
    return total;
  }, 0n).toString();
}
function SettlementTrend({ rows, currency }: { rows: RecordView[]; currency: string }) {
  const id = useId();
  const totalsByDate = new Map<string, bigint>();
  rows.filter((row) => row.fields.settlementCurrency === currency).forEach((row) => {
    const date = String(row.fields.statementDate);
    totalsByDate.set(date, (totalsByDate.get(date) ?? 0n) + BigInt(sumMoney([row], 'expectedNet', currency)));
  });
  const points = [...totalsByDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, amount]) => ({ label, amount: amount.toString() }));
  const max = Math.max(1, ...points.map((point) => Number(point.amount)));
  const coords = points.map((point, i) => [60 + i / Math.max(1, points.length - 1) * 640, 185 - Number(point.amount) / max * 155]);
  const path = coords.map(([x, y], i) => (i ? 'L' : 'M') + x + ',' + y).join(' ');
  if (!points.length) return <p className="dash-empty">No settlement batches in {currency} for this scope.</p>;
  return <svg viewBox="0 0 730 220" role="img" aria-label={'Expected net settlement by batch in ' + currency} style={{ width: '100%', minHeight: 200 }}><defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop stopColor="var(--brand-bright)" stopOpacity=".55" /><stop offset="1" stopColor="var(--brand-bright)" stopOpacity=".04" /></linearGradient></defs>{[0, .25, .5, .75, 1].map((ratio) => <g key={ratio}><line x1="60" x2="705" y1={185-ratio*155} y2={185-ratio*155} stroke="var(--chart-grid)" /><text x="50" y={189-ratio*155} fontSize="10" fill="var(--text-3)" textAnchor="end">{formatMoney(Math.round(max*ratio).toString(),currency,{compact:true})}</text></g>)}<path d={path + ' L700,185 L60,185 Z'} fill={'url(#'+id+')'} /><path d={path} fill="none" stroke="var(--brand)" strokeWidth="2.5" />{coords.map(([x,y], i) => <g key={i}><circle cx={x} cy={y} r="3.5" fill="#fff" stroke="var(--brand)" strokeWidth="2" /><text x={x} y="208" textAnchor="middle" fontSize="9" fill="var(--text-3)">{points[i]?.label.slice(5)}</text></g>)}</svg>;
}

export function PaymentsWorkspace({ reports = false }: { reports?: boolean }) {
  const { can, selection } = useSession();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'overview';
  const [period, setPeriod] = useState<Period>('30d');
  const [payment, setPayment] = useState<string>();
  const selectedPayment = params.get("payment") ?? payment;
  const query = { period, currency: selection.currency, merchantId: selection.merchantId || undefined };
  const key = JSON.stringify(query);
  const kpis = useApi(can('overview.view') ? (signal) => api.kpis(query, signal) : null, key);
  const trend = useApi(can('metrics.counts.view') ? (signal) => api.activity(query, signal) : null, key);
  const records = useApi(can('payments.read') ? (signal) => api.payments({ merchantId: selection.merchantId || undefined, legalEntityId: selection.legalEntityId || undefined, currency: selection.currency, pageSize: 100 }, signal) : null, key + selection.legalEntityId);
  const byMethod = new Map<string, number>();
  records.data?.items.forEach((row) => { const label = row.method ? humanize(row.method.type) : 'Restricted';byMethod.set(label, (byMethod.get(label) ?? 0) + 1); });
  const metrics = kpis.data?.kpis.slice(0, 5) ?? [];
  const icons = [Layers3, CheckCircle2, Activity, ShieldCheck, Clock3];
  const setView = (value: string) => setParams((current) => { current.set('view', value);current.delete('screen');return current; });
  const terminal = ['SUCCEEDED', 'FAILED', 'PROCESSING', 'REQUIRES_CAPTURE'];
  const tabs = [{ id: 'overview', label: 'Overview', icon: Layers3 }, { id: 'transactions', label: 'Transactions', icon: CreditCard }, ...(can('area.refunds_disputes') ? [{ id: 'refunds', label: 'Refunds & Disputes', icon: RefreshCw }] : []), { id: 'performance', label: 'Performance', icon: BarChart3 }];
  if (view === 'links' || view === 'recurring') return <>
    <Heading title={view === 'links' ? 'Payment Links' : 'Recurring Payments'} description="Payment workspace" /><SandboxNote />
    <Card title={view === 'links' ? 'Payment links are not connected' : 'Recurring payment schedules are not connected'}><p className="muted">This capability has no configured backend yet. You can create a sandbox payment intent or inspect existing transactions.</p><div className="row" style={{ marginTop: 18 }}><Action to="/payments?screen=ZP-BRW-004" icon={Plus} primary>Create Payment</Action><Action to="/payments" icon={CreditCard}>Payment Explorer</Action></div></Card>
  </>;
  if (reports && view === 'exports') return <><Heading title="Exports" description="Download only the scoped metrics your role may access." /><SandboxNote /><Card title="Payment Metrics" actions={<ExportMetrics kpis={kpis.data?.kpis ?? []} />}>{kpis.error ? <ErrorState error={kpis.error} onRetry={kpis.refetch} /> : <ul className="dash-list">{kpis.data?.kpis.map((item) => <li key={item.key}><span>{item.label}</span><strong>{kpiValue(item)}</strong></li>)}</ul>}</Card></>;
  return <>
    <Heading title={reports ? 'Reports & Analytics' : 'Payments – Payment Explorer'} description={reports ? 'Inspect scoped payment metrics and export the information your role permits.' : 'Search, monitor, and manage payment transactions across channels and payment methods.'}><ExportMetrics kpis={kpis.data?.kpis ?? []} /></Heading>
    <SandboxNote />
    <Tabs items={tabs} active={view} onChange={setView} />
    {view === 'refunds' && can('area.refunds_disputes') ? <ScreenView screenId="ZP-BRW-008" /> : <>
      {kpis.error && <div className="dash-error"><ErrorState error={kpis.error} onRetry={kpis.refetch} /></div>}
      <Metrics items={Array.from({ length: 5 }, (_, i) => ({ label: metrics[i]?.label ?? ['Total Payment Volume', 'Successful Transactions', 'Success Rate', 'Fraud Rate', 'Pending Approvals'][i] ?? 'Metric', value: kpiValue(metrics[i]), hint: metrics[i]?.restricted ? 'Not included in your role' : 'Selected currency · ' + period.toUpperCase(), icon: icons[i] ?? Layers3, tone: ['green', 'blue', 'green', 'red', 'amber'][i] }))} />
      {view === 'transactions' ? <Card title="All Transactions" flush>{can('payments.read') ? <PaymentsTable onOpen={setPayment} selectedId={selectedPayment} /> : <NoPermission />}</Card> : <div className="dash-layout"><div className="dash-left">
        <div className="dash-charts"><Card title="Payment Volume Trend" actions={<div className="segmented" role="group" aria-label="Chart period">{(['7d', '30d', '24h'] as Period[]).map((value) => <button key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{value.toUpperCase()}</button>)}</div>}><div className="dash-chart">{trend.error ? <ErrorState error={trend.error} onRetry={trend.refetch} /> : trend.data ? <ActivityChart buckets={trend.data.buckets} period={period} currency={trend.data.currency} amountsVisible={trend.data.amountsVisible} /> : can('metrics.counts.view') ? <Skeleton height={220} /> : <NoPermission />}</div></Card>
          <Card title="By Payment Method">{records.error ? <ErrorState error={records.error} /> : records.data ? <><Donut items={[...byMethod].map(([label, value]) => ({ label, value }))} total={formatCount(records.data.items.length)} label="Sample transactions" /><p className="subtle" style={{ fontSize: 9 }}>Distribution of the first {records.data.items.length} scoped records.</p></> : can('payments.read') ? <Skeleton height={220} /> : <NoPermission />}</Card></div>
        <Card title="Recent Transactions" flush actions={<button className="dash-card-link btn-ghost" style={{ border: 0 }} onClick={() => setView('transactions')}>View all transactions <ArrowRight size={13} /></button>}>{can('payments.read') ? <PaymentsTable compact onOpen={setPayment} selectedId={selectedPayment} /> : <NoPermission />}</Card>
      </div><aside className="dash-side"><Card title="Quick Actions"><div className="dash-actions"><Action to="/payments?screen=ZP-BRW-004" icon={Plus} primary>Create Payment</Action>{can('area.refunds_disputes') && <Action to="/refunds" icon={RefreshCw}>Review Refunds</Action>}{can('area.routing') && <Action to="/routing" icon={Network}>Routing Policies</Action>}{can('health.view') && <Action to="/operations" icon={Activity}>Operations</Action>}</div></Card>
        <Card title="Payment Lifecycle" eyebrow="Current sample · intent states"><ul className="dash-list">{terminal.map((status) => <li key={status}><span className="dash-service-name"><StatusBadge status={status} /></span><strong className="num">{records.data ? records.data.items.filter((row) => row.status === status).length : '—'}</strong></li>)}</ul></Card>
        <Card title="Execution & Evidence"><ul className="dash-list"><li><span>Development source<small>Fictional TEST records</small></span><SourceBadge source={records.meta?.source ?? 'fixture'} /></li><li><span>Provider integrations<small>No live PSP connection configured</small></span><StatusBadge status="DISABLED" /></li><li><span>Settlement finality<small>Requires independent bank evidence</small></span><ShieldCheck size={18} style={{ color: 'var(--brand)' }} /></li></ul>{can('area.partners') && <ViewLink to="/partners">View provider capabilities</ViewLink>}</Card>
      </aside></div>}
    </>}
    {selectedPayment && <PaymentDrawer id={selectedPayment} onClose={() => { setPayment(undefined);setParams((current) => { current.delete("payment");return current; }); }} />}
  </>;
}

export function FundsWorkspace({ payoutsOnly = false }: { payoutsOnly?: boolean }) {
  const { can, selection } = useSession();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'overview';
  const settlement = useApi(can('area.finance') ? (signal) => api.screen('ZP-BRW-009', {}, signal) : null, 'funds-settlements');
  const payouts = useApi(can('area.payouts') ? (signal) => api.screen('ZP-BRW-010', {}, signal) : null, 'funds-payouts');
  const source = payoutsOnly ? payouts : settlement;
  const rows = source.data?.items ?? [];
  const groups = new Map<string, number>();rows.forEach((row) => groups.set(humanize(row.status), (groups.get(humanize(row.status)) ?? 0) + 1));
  const tabs = [{ id: 'overview', label: 'Overview', icon: Layers3 }, ...(can('area.finance') ? [{ id: 'settlements', label: 'Settlements', icon: CalendarDays }, { id: 'reconciliation', label: 'Reconciliation', icon: Layers3 }, { id: 'investigations', label: 'Unknown Outcomes', icon: Search }] : []), ...(can('area.payouts') ? [{ id: 'payouts', label: 'Payouts', icon: ArrowRight }] : [])];
  const screenId = view === 'payouts' ? 'ZP-BRW-010' : view === 'investigations' ? 'ZP-BRW-011' : 'ZP-BRW-009';
  if (view === 'balances') return <><Heading title="Balances & Accounts" description="Account evidence and funds availability for your authorized workspace." /><SandboxNote /><Card title="Authoritative balances are not connected"><p className="muted">A bank or ledger balance source has not been integrated. Statement receipts and settlement records do not establish an available balance.</p><div style={{ marginTop: 18 }}><Action to="/finance" icon={BookOpen}>View Settlement Evidence</Action></div></Card></>;
  return <>
    <Heading title="Funds & Payouts – Balances, Settlements & Payouts" description="Review settlement evidence, payout approvals, and reconciliation across your authorized scope." />
    <SandboxNote /><Tabs items={tabs} active={view} onChange={(value) => setParams({ view: value })} />
    {view !== 'overview' ? <ScreenView key={screenId} screenId={screenId} /> : <>
      {source.error && <ErrorState error={source.error} onRetry={source.refetch} />}
      <Metrics items={[
        { label: 'Bank Receipts (Test)', value: settlement.data ? formatMoney(sumMoney(settlement.data.items, 'bankReceived', selection.currency), selection.currency) : '—', hint: selection.currency + ' · scoped statement batches', icon: Wallet },
        { label: 'Expected Net Settlements', value: settlement.data ? formatMoney(sumMoney(settlement.data.items, 'expectedNet', selection.currency), selection.currency) : '—', hint: 'Independent bank matching required', icon: BookOpen },
        { label: 'Payouts Awaiting Review', value: payouts.data ? payouts.data.items.filter((row) => row.status === 'REQUIRES_APPROVAL').length : can('area.payouts') ? '—' : 'Restricted', hint: 'Two-person approval controls', icon: CalendarDays },
        { label: 'Open Settlement Batches', value: settlement.data ? settlement.data.items.filter((row) => row.status !== 'CLOSED').length : '—', hint: 'Pending close or in exception', icon: Clock3 },
        { label: 'Reconciliation Variance', value: settlement.data ? formatMoney(sumMoney(settlement.data.items, 'residual', selection.currency), selection.currency) : '—', hint: selection.currency + ' · unresolved residuals', icon: Layers3 },
        { label: 'Closed Batches', value: settlement.data ? settlement.data.items.filter((row) => row.status === 'CLOSED').length : '—', hint: 'Scoped TEST records', icon: ShieldCheck },
      ]} />
      <div className="dash-layout"><div className="dash-left"><div className="dash-charts"><Card title="Settlement Volume by Batch" eyebrow={selection.currency + " · expected net · TEST statements"}>{settlement.data ? <SettlementTrend rows={settlement.data.items} currency={selection.currency} /> : <Skeleton height={210} />}</Card><Card title="Reconciliation Overview"><Donut items={[...groups].map(([label, value]) => ({ label, value }))} total={formatCount(rows.length)} label="Scoped records" /></Card></div>
        <Card title={payoutsOnly ? 'Payout Approval Queue' : 'Settlement Schedule'} flush actions={<ViewLink to={payoutsOnly ? '/payouts?screen=ZP-BRW-010' : '/finance?screen=ZP-BRW-009'}>View all</ViewLink>}><Queue data={source.data} to={payoutsOnly ? '/payouts?screen=ZP-BRW-010' : '/finance?screen=ZP-BRW-009'} kind={payoutsOnly ? 'Payout' : 'Settlement'} /></Card>
      </div><aside className="dash-side"><Card title="Quick Actions"><div className="dash-actions tall">{can('area.payouts') && <Action to="/payouts?screen=ZP-BRW-010" icon={ArrowRight} primary>Review Payouts</Action>}{can('area.finance') && <><Action to="/finance?screen=ZP-BRW-009" icon={RefreshCw}>Reconcile Records</Action><Action to="/finance?screen=ZP-BRW-011" icon={Search}>Investigate Outcome</Action></>}</div></Card>
        <Card title="Evidence & Controls"><ul className="dash-list"><li><span>Funds availability<small>No authoritative balance integration yet</small></span><StatusBadge status="UNVERIFIED" /></li><li><span>Bank settlement<small>Independent proof is required</small></span><ShieldCheck size={18} /></li><li><span>Production payouts<small>Not enabled by this dashboard</small></span><StatusBadge status="DISABLED" /></li></ul></Card>
        <Card title="Payout Status">{payouts.error ? <ErrorState error={payouts.error} /> : payouts.data ? <ul className="dash-list">{payouts.data.summary.map((item) => <li key={item.label}><span>{item.label}</span><strong>{item.value}</strong></li>)}</ul> : <p className="dash-empty">Payout records are {can('area.payouts') ? 'loading.' : 'outside your role.'}</p>}</Card>
      </aside></div>
    </>}
  </>;
}

export function OperationsWorkspace() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'overview';
  const health = useApi((signal) => api.systemHealth(signal), 'operations-health', { refreshMs: 15000 });
  const services = health.data?.services ?? [];
  const down = services.filter((service) => !service.ok);
  const measured = services.flatMap((service) => service.availability ? [service.availability.percent] : []);
  const uptime = measured.length ? (measured.reduce((sum, value) => sum + value, 0) / measured.length).toFixed(2) + '%' : '—';
  const tabs = [{ id: 'overview', label: 'Operational Overview', icon: Layers3 }, { id: 'alerts', label: 'Exceptions & Alerts', icon: CircleAlert }, { id: 'providers', label: 'Provider Health', icon: Globe2 }, { id: 'diagnostics', label: 'Monitoring & Diagnostics', icon: Activity }];
  const shown = view === 'alerts' ? down : view === 'providers' ? services.filter((service) => service.category === 'connector') : services;
  const gradientId = useId();
  return <>
    <Heading title="Operations Dashboard" description="Monitor platform health, inspect service exceptions, and follow current dependency evidence."><div className="row"><span className="subtle" style={{ fontSize: 10 }}>Last checked {health.data?.lastCheck ? formatTime(health.data.lastCheck) : '—'}</span><button className="btn btn-ghost btn-sm" onClick={health.refetch}><RefreshCw size={15} />Refresh</button></div></Heading>
    <Tabs items={tabs} active={view} onChange={(value) => setParams({ view: value })} />
    {health.error && <ErrorState error={health.error} onRetry={health.refetch} />}
    <Metrics items={[{ label: 'Observed Availability', value: uptime, hint: 'Since this monitor started · not an SLA', icon: CheckCircle2 }, { label: 'Unavailable Services', value: health.data ? down.length : '—', hint: 'Latest probe results', icon: CircleAlert, tone: 'red' }, { label: 'Monitored Services', value: health.data ? services.length : '—', hint: 'Configured local dependencies', icon: Server, tone: 'blue' }, { label: 'Database Health', value: health.data ? humanize(health.data.database.status) : '—', hint: 'Reported by service probes', icon: Layers3, tone: 'purple' }, { label: 'Probe Interval', value: health.data ? health.data.intervalSeconds + ' sec' : '—', hint: 'Automatically refreshed', icon: Clock3 }]} />
    <div className="dash-layout"><div className="dash-left"><div className="dash-charts"><Card title="Platform Health by Service" eyebrow="Observed availability since monitor startup"><svg viewBox="0 0 620 210" role="img" aria-label="Measured availability by service" style={{ width: '100%', minHeight: 190 }}><defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--brand)" /><stop offset="1" stopColor="#8be1ac" /></linearGradient></defs>{[0, 25, 50, 75, 100].map((value) => <g key={value}><line x1="35" x2="610" y1={175 - value * 1.5} y2={175 - value * 1.5} stroke="var(--chart-grid)" /><text x="27" y={179 - value * 1.5} fontSize="9" textAnchor="end" fill="var(--text-3)">{value}%</text></g>)}{services.map((service, i) => <g key={service.name}><rect x={48 + i * (550 / Math.max(1, services.length))} y={175 - (service.availability?.percent ?? 0) * 1.5} width={Math.min(40, 390 / Math.max(1, services.length))} height={(service.availability?.percent ?? 0) * 1.5} rx="4" fill={service.ok ? 'url(#' + gradientId + ')' : 'var(--red)'} /><text x={65 + i * (550 / Math.max(1, services.length))} y="195" textAnchor="middle" fontSize="8" fill="var(--text-3)">{service.name.replace('console-', '')}</text></g>)}</svg><p className="subtle" style={{ fontSize: 9 }}>Values reflect measured local uptime. No historical transaction-success series is supplied.</p></Card><Card title={view === 'providers' ? 'Configured Connector Status' : 'Service Status'}><ul className="dash-list">{shown.map((service) => <li key={service.name}><span className="dash-service-name"><span className="service-mark">{service.name.slice(0, 2).toUpperCase()}</span><span>{humanize(service.name)}<small>{service.latencyMs} ms · {service.category}</small></span></span><StatusBadge status={service.ok ? 'ok' : 'degraded'} label={service.ok ? 'Healthy' : 'Unavailable'} /></li>)}</ul>{!shown.length && <p className="dash-empty">{view === 'alerts' ? 'No unavailable services in the latest probe.' : 'No services are configured for this view.'}</p>}</Card></div>
      <Card title="Monitoring & Diagnostics" flush><div className="table-wrap"><table className="table"><thead><tr><th>Service</th><th>Dependency Checks</th><th>Latency</th><th>Availability</th><th>Status</th></tr></thead><tbody>{services.map((service) => <tr key={service.name}><td><strong>{service.name}</strong></td><td>{Object.entries(service.checks).map(([name, value]) => name + ': ' + value).join(' · ') || 'Process check'}</td><td>{service.latencyMs} ms</td><td>{service.availability ? service.availability.percent + '%' : 'Not sampled'}</td><td><StatusBadge status={service.ok ? 'ok' : 'unreachable'} /></td></tr>)}</tbody></table></div></Card>
    </div><aside className="dash-side"><Card title="Operational Alerts" actions={<span className="badge">{down.length}</span>}><ul className="dash-list">{down.map((service) => <li key={service.name}><CircleAlert size={19} style={{ color: 'var(--red)' }} /><span><strong>{humanize(service.name)}</strong><small>{service.status} · Inspect the local service and its dependencies.</small></span></li>)}</ul>{health.data && !down.length && <p className="dash-empty"><CheckCircle2 size={26} style={{ color: 'var(--brand)', display: 'block', margin: '0 auto 10px' }} />All monitored services are currently responding.</p>}</Card>
      <Card title="Quick Actions"><div className="stack">{can('area.payment_operations') && <ViewLink to="/payments?view=transactions">Search Transactions</ViewLink>}{can('area.finance') && <ViewLink to="/finance?screen=ZP-BRW-011">Investigate an Outcome</ViewLink>}{can('area.partners') && <ViewLink to="/partners">Provider Capabilities</ViewLink>}{can('area.audits') && <ViewLink to="/audits">View Audit Trail</ViewLink>}<button className="btn btn-sm" onClick={health.refetch}><RefreshCw size={14} />Refresh Diagnostics</button></div></Card>
      <Card title="System Resources"><p className="dash-empty">CPU, memory and storage telemetry are not connected. Service-health probes are shown instead of estimated resource usage.</p></Card>
    </aside></div>
  </>;
}

export function RiskWorkspace() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'overview';
  const policy = useApi((signal) => api.screen('ZP-BRW-012', {}, signal), 'risk-policy');
  const kyb = useApi(can('area.merchants') ? (signal) => api.screen('ZP-BRW-002', {}, signal) : null, 'risk-kyb');
  const rows = policy.data?.items ?? [];
  const pending = rows.filter((row) => !['ENABLED', 'DISABLED'].includes(row.status));
  const tabs = [{ id: 'overview', label: 'Overview', icon: Layers3 }, { id: 'eligibility', label: 'Merchant Eligibility', icon: BookOpen }, { id: 'investigations', label: 'Investigations', icon: CalendarDays }, { id: 'monitoring', label: 'Transaction Monitoring', icon: Activity }, { id: 'evidence', label: 'Evidence & Approvals', icon: ShieldCheck }];
  const keys = ['ENABLED', 'DISABLED', 'PENDING_CHANGE', 'SUSPENDED'];
  const summary = policy.data?.summary;
  return <>
    <Heading title="Risk & Compliance" description="Monitor merchant eligibility, jurisdictional controls, and evidence-led compliance decisions." />
    <SandboxNote /><Tabs items={tabs} active={view} onChange={(value) => setParams({ view: value })} />
    {policy.error && <ErrorState error={policy.error} onRetry={policy.refetch} />}
    <Metrics items={[{ label: 'KYB Awaiting Review', value: kyb.data ? kyb.data.items.filter((row) => ['SUBMITTED', 'IN_REVIEW', 'INFO_REQUESTED'].includes(row.status)).length : can('area.merchants') ? '—' : 'Restricted', hint: 'Scoped merchant applications', icon: FileCheck2 }, { label: 'Open Control Reviews', value: policy.data ? pending.length : '—', hint: 'Policy and capability records', icon: Flag, tone: 'red' }, { label: 'Restricted Test Cells', value: policy.data ? rows.filter((row) => ['SUSPENDED', 'DISABLED'].includes(row.status)).length : '—', hint: 'Execution follows approved eligibility', icon: XCircle, tone: 'amber' }, { label: summary?.[1]?.label ?? 'Pending Changes', value: summary?.[1]?.value ?? '—', hint: 'Independent approval required', icon: Clock3, tone: 'blue' }]} />
    {view === 'eligibility' ? <ScreenView screenId="ZP-BRW-012" /> : view === 'monitoring' ? <Card title="Transaction Monitoring"><p className="dash-empty">A transaction-monitoring feed is not configured. Approved eligibility and review controls remain available below.</p><ViewLink to="/risk?screen=ZP-BRW-012">Inspect eligibility controls</ViewLink></Card> : <>
      <div className="dash-grid-2"><Card title={view === 'investigations' ? 'Open Review Items' : 'Priority Review Queue'} eyebrow="Evidence-linked control records · No automatic approvals" flush actions={<ViewLink to="/risk?screen=ZP-BRW-012">View all controls</ViewLink>}><Queue data={policy.data ? { ...policy.data, items: view === 'investigations' ? pending : rows } : undefined} to="/risk?screen=ZP-BRW-012" kind="Control" /></Card>
        <Card title="Market & Capability Eligibility" eyebrow="Illustrative jurisdictions · not a live license" actions={<ViewLink to="/risk?screen=ZP-BRW-012">Authority matrix</ViewLink>}><ul className="dash-list">{rows.slice(0, 4).map((row) => <li key={row.id}><span><FieldDisplay value={row.fields.jurisdiction ?? row.fields.country ?? row.id} /></span><StatusBadge status={row.status} /></li>)}</ul><div className="dash-note" style={{ marginTop: 12, marginBottom: 0 }}>Eligibility requires legal entity, provider, method, currency, contract and security evidence. Missing authority blocks execution.</div></Card></div>
      <div className="dash-bottom"><Card title="Control Review Distribution" eyebrow="Current scoped records"><GroupBars items={keys.map((status) => ({ label: humanize(status), value: rows.filter((row) => row.status === status).length }))} /></Card>
        <Card title="Evidence & Approval Tasks" actions={<ViewLink to="/risk?screen=ZP-BRW-012">View tasks</ViewLink>}><ul className="dash-list">{pending.slice(0, 3).map((row) => <li key={row.id}><span><strong>{row.id}</strong><small>Review current authority evidence</small></span><StatusBadge status={row.status} /></li>)}</ul>{policy.data && !pending.length && <p className="dash-empty">No pending control changes.</p>}</Card>
        <Card title={view === 'evidence' ? 'Approval Evidence' : 'Audit & Decision Trail'}><ul className="dash-list">{rows.slice(0, 3).map((row) => <li key={row.id}><span><strong>{row.id}</strong><small>{formatTime(row.updatedAt)} · {humanize(row.status)}</small></span><ViewLink to={'/risk?screen=ZP-BRW-012&record=' + encodeURIComponent(row.id)}>Inspect</ViewLink></li>)}</ul></Card></div>
      {kyb.data && <div style={{ marginTop: 16 }}><Card title="KYB Reviews" flush actions={<ViewLink to="/merchants?screen=ZP-BRW-002">View applications</ViewLink>}><Queue data={kyb.data} to="/merchants?screen=ZP-BRW-002" kind="Merchant" /></Card></div>}
    </>}
    <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>{can('area.merchants') && <Action to="/merchants?screen=ZP-BRW-002" icon={FileCheck2}>Review KYB Evidence</Action>}{can('area.qa_release') && <Action to="/release" icon={ShieldCheck}>View Release Gates</Action>}</div>
  </>;
}

export function CreatePaymentWorkspace() {
  return <><Heading title="Create Payment" description="Create a scoped sandbox payment intent with duplicate-request protection." /><SandboxNote /><SandboxIntent /></>;
}
