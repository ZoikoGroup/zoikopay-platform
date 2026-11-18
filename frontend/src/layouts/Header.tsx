import { CircleHelp, LogOut, Menu, SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { GlobalSearch } from "../components/GlobalSearch";
import { NotificationPanel } from "../components/NotificationPanel";
import { Segmented } from "../components/Segmented";
import { useDismiss } from "../hooks/ui";
import { useSession } from "../hooks/useSession";
import { findNav } from "../navigation/navConfig";
import { signOut } from "../pages/MiscPages";
import type { Environment } from "../types/api";

function Breadcrumb() {
  const { pathname } = useLocation();
  const item = findNav(pathname);
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><Link to="/" style={{ textDecoration: "none" }}>Zoiko Pay</Link></li>
        <li aria-current="page">{item?.label ?? "Not found"}</li>
      </ol>
    </nav>
  );
}

function initials(name: string) {
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

function UserMenu() {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  if (!me) return null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn btn-ghost" style={{ height: 38, padding: "0 6px 0 4px", gap: 10 }} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)} aria-label={`Account menu for ${me.displayName}`}>
        <span className="header-avatar" aria-hidden="true">{initials(me.displayName)}</span>
        <span className="desktop-only" style={{ display: "grid", textAlign: "left", lineHeight: 1.2 }}>
          <span style={{ fontSize: "var(--fs-sm)" }}>{me.displayName}</span>
          <span className="subtle" style={{ fontSize: "var(--fs-2xs)" }}>{me.personas.join(", ") || "No role"}</span>
        </span>
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Account">
          <div style={{ padding: "var(--s-4)", display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gap: 2 }}>
              <strong>{me.displayName}</strong>
              <span className="mono subtle">{me.username}</span>
            </div>
            <dl className="kv" style={{ fontSize: "var(--fs-xs)" }}>
              <dt>Role</dt><dd>{me.personas.join(", ") || "None"}</dd>
              <dt>Environments</dt><dd>{me.environments.join(", ") || "None"}</dd>
            </dl>
          </div>
          <hr className="divider" />
          <ul className="menu-list">
            <li>
              <button className="menu-item" onClick={signOut}>
                <LogOut size={15} aria-hidden="true" /> Sign out
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

function HelpMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="icon-btn" aria-label="Help and support" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <CircleHelp size={17} />
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Help">
          <div style={{ padding: "var(--s-4)", display: "grid", gap: 12, fontSize: "var(--fs-sm)" }}>
            <strong>Keyboard</strong>
            <dl className="kv" style={{ fontSize: "var(--fs-xs)" }}>
              <dt><span className="kbd">/</span></dt><dd>Focus global search</dd>
              <dt><span className="kbd">Esc</span></dt><dd>Close a panel, dialog or menu</dd>
              <dt><span className="kbd">← →</span></dt><dd>Read chart values when the chart is focused</dd>
            </dl>
            <strong>Support</strong>
            <p className="muted" style={{ fontSize: "var(--fs-xs)" }}>
              Quote the request id shown on any error when reporting a problem.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** TEST / LIVE switch. Only environments in the user's membership are enabled; the server re-checks. */
function EnvSwitch() {
  const { me, setEnvironment } = useSession();
  const [switching, setSwitching] = useState(false);
  const [envError, setEnvError] = useState<string>();
  if (!me) return null;
  const change = async (env: Environment) => {
    setSwitching(true);
    setEnvError(undefined);
    try {
      await setEnvironment(env);
    } catch (e) {
      setEnvError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };
  return (
    <>
      <Segmented<Environment>
        label="Environment"
        value={me.environment}
        disabled={switching}
        onChange={change}
        options={(["TEST", "LIVE"] as const).map((e) => ({ value: e, label: e === "TEST" ? "Sandbox (Test)" : "Live", disabled: !me.environments.includes(e) }))}
      />
      {envError && <span className="sr-only" role="alert">{envError}</span>}
    </>
  );
}

function ScopeMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return <div ref={ref} style={{ position: 'relative' }}><button className="icon-btn" aria-label="Filter workspace" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}><SlidersHorizontal size={17} /></button>{open && <div className="popover cc-scope-popover" role="dialog" aria-label="Workspace scope"><div className="popover-head"><strong>Workspace scope</strong></div><ScopeBar /></div>}</div>;
}

export function Header({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { me, can, scope, selection, setSelection } = useSession();
  if (!me) return null;
  return (
    <header className="header">
      <div className="header-left">
        <button className="icon-btn mobile-only" onClick={onOpenMenu} aria-label="Open navigation"><Menu size={18} /></button>
        {can("overview.view") ? <div className="header-search"><GlobalSearch /></div> : <Breadcrumb />}
      </div>
      <div className="header-right">
        {/* The server refuses /search without overview.view (Super Admin), so do not offer it. */}
        <span className="hide-phone"><EnvSwitch /></span>
        {scope && <select className="header-currency" aria-label="Display currency" value={selection.currency} onChange={(e) => setSelection({ currency: e.target.value })}>{scope.currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select>}
        {scope && <ScopeMenu />}
        <NotificationPanel />
        <HelpMenu />
        <UserMenu />
      </div>
    </header>
  );
}

/** Merchant, jurisdiction and currency scope. Changing scope reloads every panel. */
export function ScopeBar() {
  const { scope, selection, setSelection, me } = useSession();
  if (!scope || !me) return null;
  return (
    <div className="scope-bar" role="region" aria-label="Scope">
      <span className="badge env-badge hide-phone" data-env={me.environment} aria-label={`Environment ${me.environment}`}>{me.environment}</span>
      <span className="mobile-only"><EnvSwitch /></span>
      {scope.canSeeMerchantList && (
        <select className="select" aria-label="Merchant or account" value={selection.merchantId} onChange={(e) => setSelection({ merchantId: e.target.value })}>
          <option value="">All accessible merchants ({scope.merchants.length})</option>
          {scope.merchants.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
        </select>
      )}
      <select className="select" aria-label="Jurisdiction" value={selection.legalEntityId} onChange={(e) => setSelection({ legalEntityId: e.target.value })}>
        <option value="">All jurisdictions</option>
        {scope.legalEntities.map((l) => <option key={l.id} value={l.id}>{l.jurisdiction} · {l.id}</option>)}
      </select>
      <select className="select" aria-label="Currency" value={selection.currency} onChange={(e) => setSelection({ currency: e.target.value })}>
        {scope.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <span className="spacer" />
      {scope.liveUnavailable && <span className="badge badge-dashed">LIVE: no production data source</span>}
    </div>
  );
}
