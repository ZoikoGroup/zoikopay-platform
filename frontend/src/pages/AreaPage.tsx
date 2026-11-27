import { useState } from "react";
import { useSearchParams } from "react-router";
import { AuditView } from "../components/AuditView";
import { PageHead } from "../components/Card";
import { PaymentDrawer, PaymentsTable } from "../components/payments";
import { SandboxIntent } from "../components/SandboxIntent";
import { ModuleView } from "../components/ModuleView";
import { ScreenView } from "../components/ScreenView";
import { MODULES } from "../screens/parity";
import { CreatePaymentWorkspace, FundsWorkspace, OperationsWorkspace, PaymentsWorkspace, RiskWorkspace } from "./WorkspaceDashboards";
import { Card } from "../components/Card";
import { Link } from "react-router";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { PlatformPage } from "./PlatformPage";
import { AccessPage } from "./AccessPage";
import { ExceptionalPage } from "./ExceptionalPage";
import type { NavItem } from "../navigation/navConfig";
import { SCREENS } from "../navigation/screens";

function PaymentExplorer() {
  const [params, setParams] = useSearchParams();
  const open = params.get("payment") ?? undefined;
  const setOpen = (id?: string) => setParams((p) => { if (id) p.set("payment", id); else p.delete("payment"); return p; });
  return (
    <div className="card">
      <PaymentsTable onOpen={setOpen} selectedId={open} />
      {open && <PaymentDrawer id={open} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

function Screen({ id }: { id: string }) {
  if (MODULES[id]) return <ModuleView id={id} />;
  if (id === "ZP-BRW-005") return <PaymentExplorer />;
  if (id === "ZP-BRW-004") return <SandboxIntent />;
  return <ScreenView screenId={id} />;
}

/** One side-rail area: its spec screens as tabs. */
export function AreaPage({ item }: { item: NavItem }) {
  const [params, setParams] = useSearchParams();
  const fromLink = params.get("screen");
  const [tab, setTab] = useState(fromLink && item.screens.includes(fromLink) ? fromLink : item.screens[0] ?? "");
  const active = fromLink && item.screens.includes(fromLink) ? fromLink : tab;
  const spec = SCREENS[active];

  if (item.key === "platform") return <PlatformPage />;
  if (item.key === "access") return <AccessPage />;
  if (item.key === "exceptional") return <ExceptionalPage />;

  if (item.key === "settings") return <WorkspaceSettings />;
  if (item.key === "developers" && params.get("view") === "webhooks") return <><PageHead title="Webhooks" description="Review the endpoint and delivery records available to your role." /><ScreenView screenId="ZP-BRW-013" initialQuery="Webhook endpoint" /></>;
  if (item.key === "developers" && params.get("view") === "toks") return <><PageHead title="TOKs" description="Integration workspace" /><Card title="TOKs is not connected"><p>This workspace has no configured TOKs integration. No external action is performed from this page.</p><Link className="dash-card-link" to="/developers" style={{ marginTop: 16 }}>Open API & Developer</Link></Card></>;
  if (item.key === "operations") return <OperationsWorkspace />;
  if (item.key === "reports") return <PaymentsWorkspace reports />;
  if (item.key === "payments" && !fromLink) return <PaymentsWorkspace />;
  if (item.key === "payments" && fromLink === "ZP-BRW-004") return <CreatePaymentWorkspace />;
  if (item.key === "finance" && !fromLink) return <FundsWorkspace />;
  if (item.key === "payouts" && !fromLink) return <FundsWorkspace payoutsOnly />;
  if (item.key === "risk" && !fromLink) return <RiskWorkspace />;

  if (item.key === "audits") {
    return (
      <>
        <PageHead title="Audits" description="Every sign-in, decision, sandbox request and denied request recorded by this console, in a tamper-evident chain." />
        <AuditView />
      </>
    );
  }

  return (
    <>
      <PageHead
        title={item.label}
        screen={spec && <><span className="chip">{spec.id}</span><span className="chip">{spec.tier}</span><span className="chip">Roles: {spec.personas}</span></>}
        description={spec?.intent}
      />
      {item.screens.length > 1 && (
        <div className="tabs" role="tablist" aria-label={`${item.label} screens`} style={{ marginBottom: "var(--s-4)", padding: 0 }}>
          {item.screens.map((id) => (
            <button key={id} role="tab" className="tab" aria-selected={id === active}
              onClick={() => { setTab(id); setParams((p) => { p.delete("screen"); p.delete("record"); p.delete("payment"); return p; }); }}>
              {SCREENS[id]?.title ?? id}
            </button>
          ))}
        </div>
      )}
      <Screen key={active} id={active} />
    </>
  );
}
