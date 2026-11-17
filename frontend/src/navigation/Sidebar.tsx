import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState, type FocusEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router";
import { useSession } from "../hooks/useSession";
import { signOut } from "../pages/MiscPages";
import { ZoikoMark } from "./icons";
import { visibleNav, type NavItem } from "./navConfig";
import "../styles/sidebar.css";

/** Small brand mark, also used on the sign-in page. */
export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 32 32"><path d="M8 9h16L8 23h16" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
}

const GROUPS: NavItem["group"][] = ["Workspace", "Financial Operations", "Platform"];

function initials(name: string) {
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

/**
 * Role-aware navigation. Items the persona may not use are not rendered at
 * all; the backend still enforces every permission independently.
 */
export function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle: () => void; onNavigate: () => void }) {
  const { me } = useSession();
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  if (!me) return null;
  const items = visibleNav(me);
  const groups = GROUPS.map((g) => ({ label: g, items: items.filter((i) => i.group === g) })).filter((g) => g.items.length > 0);

  const showTip = (label: string, el: HTMLElement) => {
    if (!collapsed) return;
    const r = el.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2, left: r.right + 12 });
  };
  const tipProps = (label: string) => ({
    onMouseEnter: (e: MouseEvent<HTMLElement>) => showTip(label, e.currentTarget),
    onMouseLeave: () => setTip(null),
    onFocus: (e: FocusEvent<HTMLElement>) => showTip(label, e.currentTarget),
    onBlur: () => setTip(null),
  });

  return (
    <aside className="sb" aria-label="Primary">
      <div className="sb-brand">
        <span className="sb-mark"><ZoikoMark size={30} /></span>
        <span className="sb-word">
          <span className="sb-word-main">Zoiko Pay</span>
          <span className="sb-word-sub">Operations Console</span>
        </span>
      </div>

      <nav className="sb-nav" aria-label="Main navigation">
        {groups.map((g) => (
          <section className="sb-group" key={g.label} aria-labelledby={`sb-${g.label}`}>
            <h2 className="sb-group-label" id={`sb-${g.label}`}>{g.label}</h2>
            <ul className="sb-list">
              {g.items.map((item) => (
                <li key={item.key}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    className="sb-link"
                    onClick={onNavigate}
                    aria-label={collapsed ? item.label : undefined}
                    {...tipProps(item.label)}
                  >
                    <span className="sb-icon"><item.icon size={17} /></span>
                    <span className="sb-label">{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>

      <div className="sb-foot">
        <div className="sb-profile">
          <span className="sb-avatar" aria-hidden="true">{initials(me.displayName)}</span>
          <span className="sb-who">
            <span className="sb-name">{me.displayName}</span>
            <span className="sb-meta"><span className="sb-env" data-env={me.environment}>{me.environment}</span>{me.personas.join(" · ") || "No role"}</span>
          </span>
          <button className="sb-btn sb-hide-collapsed" onClick={signOut} aria-label="Sign out" {...tipProps("Sign out")}>
            <LogOut size={15} strokeWidth={1.6} />
          </button>
        </div>
        <button className="sb-btn sb-toggle" onClick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={collapsed}
          {...tipProps(collapsed ? "Expand sidebar" : "Collapse sidebar")}>
          {collapsed ? <PanelLeftOpen size={15} strokeWidth={1.6} /> : <PanelLeftClose size={15} strokeWidth={1.6} />}
          <span className="sb-label">Collapse</span>
        </button>
      </div>

      {tip && collapsed && createPortal(<div className="nav-tooltip" role="tooltip" style={{ top: tip.top, left: tip.left }}>{tip.label}</div>, document.body)}
    </aside>
  );
}
