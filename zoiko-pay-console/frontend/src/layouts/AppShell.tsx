import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { useMediaQuery } from "../hooks/ui";
import { Sidebar } from "../navigation/Sidebar";
import { Header, ScopeBar } from "./Header";

const COLLAPSE_KEY = "zp.console.sidebarCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell() {
  const [collapsedPref, setCollapsedPref] = useState(readCollapsed);
  const tablet = useMediaQuery("(max-width: 1024px) and (min-width: 721px)");
  const phone = useMediaQuery("(max-width: 720px)");
  const { pathname } = useLocation();
  // The phone drawer belongs to the page it was opened on, so navigating closes it.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const mobileOpen = openedOn === pathname;
  const setMobileOpen = (open: boolean) => setOpenedOn(open ? pathname : null);
  const collapsed = tablet ? true : phone ? false : collapsedPref;

  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [pathname]);

  const toggle = () => {
    setCollapsedPref((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // convenience only
      }
      return !c;
    });
  };

  return (
    <div className="shell" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      <a className="skip-link" href="#main">Skip to content</a>
      <Sidebar collapsed={collapsed} onToggle={toggle} onNavigate={() => setMobileOpen(false)} />
      {phone && mobileOpen && <div className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
      <div className="shell-main">
        <Header onOpenMenu={() => setMobileOpen(true)} />
        <ScopeBar />
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
