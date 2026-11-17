import { useEffect, useState } from "react";
import { createBrowserRouter, Navigate, RouterProvider, type RouteObject } from "react-router";
import { ErrorState } from "./components/States";
import { useSession } from "./hooks/useSession";
import { AppShell } from "./layouts/AppShell";
import { isVisible, NAV, type NavItem, visibleNav } from "./navigation/navConfig";
import { AreaPage } from "./pages/AreaPage";
import { LoginPage } from "./pages/LoginPage";
import { ForbiddenRoute, NoAccessPage, NotFoundPage } from "./pages/MiscPages";
import { OverviewPage } from "./pages/OverviewPage";
import { UNAUTHENTICATED_EVENT } from "./services/http";

/**
 * Shows an area only to roles that may see it; the server decides who that is.
 * A role without Overview (Super Admin, whose default dashboard is the Super
 * Admin page, 03-05 §10.1) lands on its first permitted area instead.
 */
function Area({ item }: { item: NavItem }) {
  const { me } = useSession();
  if (me && item.key === "overview" && !isVisible(item, me)) {
    const home = visibleNav(me)[0];
    if (home) return <Navigate to={home.path} replace />;
  }
  if (!me || !isVisible(item, me)) return <ForbiddenRoute />;
  return item.key === "overview" ? <OverviewPage /> : <AreaPage key={item.key} item={item} />;
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      ...NAV.map((item) => (item.path === "/" ? { index: true, element: <Area item={item} /> } : { path: item.path.slice(1), element: <Area item={item} /> })),
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

const router = createBrowserRouter(routes);

/** Two screens: the sign-in form and, once signed in, the dashboard. */
export function App() {
  const { status, me, error, refresh } = useSession();
  const [reason, setReason] = useState<string>();
  useEffect(() => {
    const on = (e: Event) => setReason((e as CustomEvent<string>).detail);
    window.addEventListener(UNAUTHENTICATED_EVENT, on);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, on);
  }, []);

  if (status === "loading") {
    return <div style={{ minHeight: "100%", display: "grid", placeItems: "center" }} role="status" aria-label="Loading console"><div className="skeleton" style={{ width: 160, height: 6 }} /></div>;
  }
  if (status === "signed-out") return <LoginPage reason={reason} onSignedIn={refresh} />;
  if (status === "error" && error) {
    return <main style={{ minHeight: "100%", display: "grid", placeItems: "center" }}><div className="card" style={{ width: "min(520px, 100%)" }}><ErrorState error={error} onRetry={refresh} /></div></main>;
  }
  if (!me?.hasAccess) return <NoAccessPage />;
  return <RouterProvider router={router} />;
}
