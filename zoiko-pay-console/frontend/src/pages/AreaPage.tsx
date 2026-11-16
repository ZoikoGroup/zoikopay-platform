import { useState } from "react";
import { useSearchParams } from "react-router";
import { AuditView } from "../components/AuditView";
import { PageHead } from "../components/Card";
import { PaymentDrawer, PaymentsTable } from "../components/payments";
import { SandboxIntent } from "../components/SandboxIntent";
import { ScreenView } from "../components/ScreenView";
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
