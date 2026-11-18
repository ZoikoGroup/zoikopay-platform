import { Activity, ArrowDownToLine, ArrowLeftRight, BadgeCheck, BarChart3, BookOpen, Building2, ChartNoAxesCombined, ChevronRight, Code2, CreditCard, FileCheck2, FileText, House, KeyRound, Link2, ListChecks, LogOut, Network, PanelLeftClose, PanelLeftOpen, Repeat2, Settings, ShieldCheck, TriangleAlert, Undo2, Users, Wallet, Webhook } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Brand } from '../components/Brand';
import { useApi } from '../hooks/useApi';
import { useSession } from '../hooks/useSession';
import { signOut } from '../pages/MiscPages';
import { api } from '../services/api';
import type { Permission } from '../types/api';
import { visibleNav } from './navConfig';
import '../styles/sidebar.css';

export function BrandMark() { return <img className="brand-mark" src="/brand/icon.svg" alt="" />; }
interface RailItem { label: string; to: string; icon: typeof Activity; permission: Permission; badge?: 'activity' | 'exceptions' }
export const RAIL_SECTIONS: { label: string; items: RailItem[] }[] = [
  { label: 'Command Center', items: [
    { label: 'Dashboard', to: '/', icon: House, permission: 'overview.view' },
    { label: 'Activity Feed', to: '/?view=activity', icon: Activity, permission: 'overview.view', badge: 'activity' },
  ] },
  { label: 'Payments', items: [
    { label: 'Create Payment', to: '/payments?screen=ZP-BRW-004', icon: ArrowLeftRight, permission: 'area.payment_operations' },
    { label: 'Payment Links', to: '/payments?view=links', icon: Link2, permission: 'area.payment_operations' },
    { label: 'Recurring Payments', to: '/payments?view=recurring', icon: Repeat2, permission: 'area.payment_operations' },
    { label: 'Refunds & Adjustments', to: '/refunds', icon: Undo2, permission: 'area.refunds_disputes' },
    { label: 'Routing Policies', to: '/routing', icon: Network, permission: 'area.routing' },
  ] },
  { label: 'Funds & Payouts', items: [
    { label: 'Balances & Accounts', to: '/finance?view=balances', icon: Wallet, permission: 'area.finance' },
    { label: 'Settlements', to: '/finance', icon: CreditCard, permission: 'area.finance' },
    { label: 'Payouts', to: '/payouts', icon: ArrowLeftRight, permission: 'area.payouts' },
  ] },
  { label: 'Operations', items: [
    { label: 'Transactions', to: '/payments', icon: CreditCard, permission: 'area.payment_operations' },
    { label: 'Reconciliation', to: '/finance?screen=ZP-BRW-009', icon: BookOpen, permission: 'area.finance' },
    { label: 'Exceptions & Reviews', to: '/finance?screen=ZP-BRW-011', icon: TriangleAlert, permission: 'area.finance', badge: 'exceptions' },
    { label: 'Service Health', to: '/operations', icon: Activity, permission: 'health.view' },
  ] },
  { label: 'Risk & Compliance', items: [
    { label: 'Fraud & Risk', to: '/risk', icon: ShieldCheck, permission: 'area.risk_compliance' },
    { label: 'Disputes & Chargebacks', to: '/refunds?screen=ZP-BRW-008', icon: ShieldCheck, permission: 'area.refunds_disputes' },
    { label: 'KYC / KYB & Onboarding', to: '/merchants?screen=ZP-BRW-002', icon: BadgeCheck, permission: 'area.merchants' },
    { label: 'Compliance & Policies', to: '/risk?view=eligibility', icon: FileCheck2, permission: 'area.risk_compliance' },
  ] },
  { label: 'Reports & Analytics', items: [
    { label: 'Reports', to: '/reports', icon: BarChart3, permission: 'overview.view' },
    { label: 'Analytics & Insights', to: '/reports?view=performance', icon: ChartNoAxesCombined, permission: 'overview.view' },
    { label: 'Exports', to: '/reports?view=exports', icon: ArrowDownToLine, permission: 'overview.view' },
    { label: 'Audit Trail', to: '/audits', icon: FileText, permission: 'area.audits' },
  ] },
  { label: 'Integrations', items: [
    { label: 'API & Developer', to: '/developers', icon: Code2, permission: 'area.developers' },
    { label: 'Webhooks', to: '/developers?view=webhooks', icon: Webhook, permission: 'area.developers' },
    { label: 'TOKs', to: '/developers?view=toks', icon: KeyRound, permission: 'area.developers' },
    { label: 'Provider Connections', to: '/partners', icon: Network, permission: 'area.partners' },
  ] },
  { label: 'Administration', items: [
    { label: 'Users & Permissions', to: '/access', icon: Users, permission: 'area.access' },
    { label: 'Entities & Accounts', to: '/merchants', icon: Building2, permission: 'area.merchants' },
    { label: 'Exceptional Access', to: '/exceptional', icon: KeyRound, permission: 'area.exceptional' },
    { label: 'Release Gates', to: '/release', icon: ListChecks, permission: 'area.qa_release' },
    { label: 'Super Admin', to: '/platform', icon: Settings, permission: 'area.platform' },
    { label: 'Settings', to: '/settings', icon: Settings, permission: 'overview.view' },
  ] },
];

export function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle: () => void; onNavigate: () => void }) {
  const { me, can } = useSession();
  const { pathname, search } = useLocation();
  const sectionId = useId();
  const routeKey = pathname + search;
  const [dropdowns, setDropdowns] = useState<{ route: string; closed: Record<string, boolean> }>({ route: routeKey, closed: {} });
  const toggleSection = (label: string) => setDropdowns((previous) => {
    const closed = previous.route === routeKey ? previous.closed : {};
    return { route: routeKey, closed: { ...closed, [label]: !closed[label] } };
  });
  const notifications = useApi(me ? (signal) => api.notifications(signal) : null, 'rail-notifications', { refreshMs: 60000 });
  if (!me) return null;
  const sections = RAIL_SECTIONS.map((section) => ({ ...section, items: section.items.filter((item) => can(item.permission)) })).filter((section) => section.items.length);
  const current = new URLSearchParams(search);
  const selected = (to: string) => {
    const target = new URL(to, 'http://console.local');
    if (pathname !== target.pathname) return false;
    const queries = [...target.searchParams];
    if (!queries.length && target.pathname === '/payments' && !current.has('screen')) return !current.has('view') || current.get('view') === 'transactions';
    return queries.length ? queries.every(([key, value]) => current.get(key) === value) : !current.has('view') && !current.has('screen');
  };
  const unread = notifications.data?.filter((item) => !item.read) ?? [];
  return <aside className="sb command-rail" aria-label="Primary">
    <Link className="sb-brand" to={can('overview.view') ? '/' : visibleNav(me)[0]?.path ?? '/'} onClick={onNavigate}><Brand light compact={collapsed} /></Link>
    <nav className="sb-nav" aria-label="Main navigation">{sections.map((section, index) => {
      const expanded = collapsed || dropdowns.route !== routeKey || !dropdowns.closed[section.label];
      const linksId = `${sectionId}-section-${index}`;
      return <section className="rail-section" data-active={section.items.some((item) => selected(item.to))} key={section.label} aria-label={section.label}>
      <h2 className="rail-section-title"><button type="button" className="rail-section-toggle" aria-expanded={expanded} aria-controls={linksId} onClick={() => toggleSection(section.label)}><span>{section.label}</span><ChevronRight size={13} aria-hidden="true" /></button></h2>
      <ul id={linksId} className="rail-links" hidden={!expanded}>{section.items.map((item) => {
        const Icon = item.icon;
        const badge = item.badge === 'activity' ? unread.length : item.badge === 'exceptions' ? unread.filter((notice) => notice.screenId === 'ZP-BRW-011').length : 0;
        const active = selected(item.to);
        return <li key={item.to}><Link to={item.to} className="rail-link" aria-current={active ? 'page' : undefined} aria-label={collapsed ? item.label : undefined} title={collapsed ? item.label : undefined} onClick={onNavigate}><Icon size={16} strokeWidth={1.7} aria-hidden="true" /><span className="sb-label">{item.label}</span>{badge > 0 && <span className={'rail-count' + (item.badge === 'activity' ? ' rail-count-green' : '')} aria-label={badge + ' unread'}>{badge > 99 ? '99+' : badge}</span>}{active && <ChevronRight size={12} className="rail-current-arrow" aria-hidden="true" />}</Link></li>;
      })}</ul>
    </section>; })}</nav>
    <div className="sb-globe" aria-hidden="true"><div /></div>
    <footer className="sb-foot"><div className="sb-footer-buttons"><button className="sb-btn" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}<span className="sb-label">Collapse</span></button><span className="rail-sandbox"><span className="sb-online" /> TEST</span><button className="sb-btn" onClick={signOut} aria-label="Sign out"><LogOut size={15} /></button></div></footer>
  </aside>;
}
