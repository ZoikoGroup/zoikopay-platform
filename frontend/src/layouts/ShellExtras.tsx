import { ChevronDown, ChevronUp, CircleCheck, Circle, Plus, SquareTerminal } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useDismiss } from "../hooks/ui";
import { useApi } from "../hooks/useApi";
import { api } from "../services/api";
import { useSession } from "../hooks/useSession";
import type { Permission } from "../types/api";

/** Stripe-style strip across the top while the workspace is in TEST (sandbox). */
export function SandboxBanner() {
  const { me } = useSession();
  if (me?.environment !== "TEST") return null;
  return (
    <div className="sandbox-strip" role="note">
      <strong>Sandbox</strong>
      <span>You're testing in a sandbox. Changes you make here don't affect real customers or payments.</span>
    </div>
  );
}

// --------------------------------------------------------------- Setup guide
interface Step { key: string; label: string; to: string; permission: Permission }
const STEPS: Step[] = [
  { key: "details", label: "Add your contact details", to: "/settings", permission: "overview.view" },
  { key: "bank", label: "Link a bank account", to: "/treasury?screen=ZP-STR-027&create=1", permission: "area.finance" },
  { key: "apikey", label: "Create an API key", to: "/workbench?screen=ZP-STR-034&create=1", permission: "area.developers" },
  { key: "webhook", label: "Add a webhook endpoint", to: "/developers?screen=ZP-BRW-013&create=1", permission: "area.developers" },
  { key: "product", label: "Create your first product", to: "/commerce?screen=ZP-COM-002&create=1", permission: "area.payment_operations" },
  { key: "payment", label: "Try a test payment", to: "/payments?screen=ZP-BRW-004", permission: "area.payment_operations" },
];
const GUIDE_KEY = "zp.console.setupGuide";
function readDone(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(GUIDE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function Ring({ done, total }: { done: number; total: number }) {
  const c = 2 * Math.PI * 7;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" fill="none" stroke="var(--line)" strokeWidth="2.5" />
      <circle cx="9" cy="9" r="7" fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeDasharray={`${total ? (done / total) * c : 0} ${c}`} transform="rotate(-90 9 9)" />
    </svg>
  );
}

/** Setup guide: a checklist of first steps. Progress is remembered in this browser. */
export function SetupGuide() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [manual, setDone] = useState<string[]>(readDone);
  // Steps the server sees you have already done (your own successful actions).
  const progress = useApi((signal) => api.setupProgress(signal), 'setup-progress-' + String(open));
  const done = [...new Set([...manual, ...Object.entries(progress.data ?? {}).filter(([, v]) => v).map(([k]) => k)])];
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const steps = STEPS.filter((s) => can(s.permission));
  if (!steps.length) return null;
  const finished = steps.filter((s) => done.includes(s.key)).length;
  const toggle = (key: string) => setDone((old) => {
    const next = old.includes(key) ? old.filter((k) => k !== key) : [...old, key];
    try { localStorage.setItem(GUIDE_KEY, JSON.stringify(next)); } catch { /* convenience only */ }
    return next;
  });
  return (
    <div ref={ref} style={{ position: "relative" }} className="hide-phone">
      <button className="btn btn-sm setup-guide-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        Setup guide <Ring done={finished} total={steps.length} />
      </button>
      {open && (
        <div className="popover setup-guide" role="dialog" aria-label="Setup guide">
          <div className="popover-head"><strong>Setup guide</strong><span className="subtle">{finished} of {steps.length} done</span></div>
          <ul className="setup-steps">
            {steps.map((s) => {
              const isDone = done.includes(s.key);
              return (
                <li key={s.key} data-done={isDone}>
                  <button className="icon-btn" onClick={() => toggle(s.key)} aria-pressed={isDone} aria-label={`Mark “${s.label}” as ${isDone ? "not done" : "done"}`}>
                    {isDone ? <CircleCheck size={17} /> : <Circle size={17} />}
                  </button>
                  <Link to={s.to} onClick={() => setOpen(false)}>{s.label}</Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- "+" create
const CREATE_LINKS: { label: string; to: string; permission: Permission }[] = [
  { label: "Payment", to: "/payments?screen=ZP-BRW-004", permission: "area.payment_operations" },
  { label: "Customer", to: "/commerce?screen=ZP-COM-001&create=1", permission: "area.payment_operations" },
  { label: "Product", to: "/commerce?screen=ZP-COM-002&create=1", permission: "area.payment_operations" },
  { label: "Payment link", to: "/commerce?screen=ZP-COM-003&create=1", permission: "area.payment_operations" },
  { label: "Subscription", to: "/commerce?screen=ZP-COM-004&create=1", permission: "area.payment_operations" },
  { label: "Invoice", to: "/commerce?screen=ZP-COM-005&create=1", permission: "area.payment_operations" },
  { label: "Coupon", to: "/commerce?screen=ZP-STR-001&create=1", permission: "area.payment_operations" },
  { label: "Add funds", to: "/money?screen=ZP-STR-010&create=1", permission: "area.finance" },
];

/** The round "+" button: quick links to every create form the role can use. */
export function QuickCreateMenu() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const links = CREATE_LINKS.filter((l) => can(l.permission));
  if (!links.length) return null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="icon-btn quick-create-btn" aria-label="Create" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <Plus size={17} />
      </button>
      {open && (
        <div className="popover" role="menu" aria-label="Create">
          <div className="popover-head"><strong>Create</strong></div>
          <ul className="menu-list">
            {links.map((l) => <li key={l.label}><Link role="menuitem" className="menu-item" to={l.to} onClick={() => setOpen(false)}>{l.label}</Link></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------- Developers bar
const DEV_LINKS: { section: string; links: { label: string; to: string }[] }[] = [
  { section: "Workbench", links: [
    { label: "Overview", to: "/developers" }, { label: "Webhooks", to: "/developers?view=webhooks" },
    { label: "Events", to: "/workbench?screen=ZP-STR-032" }, { label: "Logs", to: "/workbench?screen=ZP-STR-033" },
  ] },
  { section: "Build", links: [
    { label: "API keys", to: "/developers?screen=ZP-BRW-013" }, { label: "Test a payment", to: "/payments?screen=ZP-BRW-004" },
  ] },
];

/** Stripe's bottom "Developers" bar, for roles with the Developers area. */
export function DeveloperBar() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  if (!can("area.developers")) return null;
  return (
    <div ref={ref} className="dev-bar">
      {open && (
        <nav className="dev-bar-panel" aria-label="Developers">
          {DEV_LINKS.map((g) => (
            <div key={g.section}>
              <span className="eyebrow">{g.section}</span>
              <ul className="menu-list">
                {g.links.map((l) => <li key={l.label}><Link className="menu-item" to={l.to} onClick={() => setOpen(false)}>{l.label}</Link></li>)}
              </ul>
            </div>
          ))}
        </nav>
      )}
      <button className="dev-bar-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SquareTerminal size={15} aria-hidden="true" /> Developers {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}
