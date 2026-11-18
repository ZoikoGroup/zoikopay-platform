import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../App";
import { SessionProvider } from "../hooks/useSession";
import { me, withSession } from "../test/fixtures";
import type { Permission } from "../types/api";
import { NAV, visibleNav } from "./navConfig";
import { api } from "../services/api";
import { RAIL_SECTIONS, Sidebar } from "./Sidebar";

// Permission sets as the backend issues them (backend/src/authorization/permissions.ts).
const POR: Permission[] = ["overview.view", "area.merchants", "area.payment_operations", "area.routing", "area.partners", "area.refunds_disputes", "area.finance"];
// 03-05 §10.1: no Overview; the Super Admin page is the default dashboard.
const SUPER_ADMIN: Permission[] = ["health.view", "area.platform"];

beforeEach(() => vi.spyOn(api, 'notifications').mockResolvedValue({ data: [], meta: { requestId: 'test', environment: 'TEST', source: 'console', asOf: '2026-11-18T00:00:00Z' } }));
afterEach(() => vi.restoreAllMocks());

describe("side rail (Business Requirements 01-05 §07)", () => {
  it("lists the 12 §07 items in the documents' order, then the Super Admin page (03-05 §10.1)", () => {
    expect(NAV.slice(0, 12).map((i) => i.label)).toEqual([
      "Overview", "Merchants", "Payment Operations", "Routing", "Partners", "Refunds & Disputes",
      "Finance", "Payouts", "Risk & Compliance", "Developers", "Audits", "QA & Release",
    ]);
    // Additions outside §07, recorded as OPEN_QUESTIONS Q18.
    expect(NAV.slice(12, 15).map((i) => [i.label, i.permission])).toEqual([
      ["Access", "area.access"], ["Exceptional access", "area.exceptional"], ["Super Admin", "area.platform"],
    ]);
  });

  it("hides items by persona", () => {
    expect(visibleNav({ permissions: POR }).map((i) => i.label)).toEqual([
      "Overview", "Merchants", "Payment Operations", "Routing", "Partners", "Refunds & Disputes", "Finance", "Reports & Analytics", "Settings",
    ]);
    expect(visibleNav({ permissions: SUPER_ADMIN }).map((i) => i.label)).toEqual(["Super Admin", "Operations"]); // Super Admin page only
    expect(visibleNav({ permissions: [] })).toEqual([]);
    expect(visibleNav({ permissions: ["overview.view", "area.access"] }).map((i) => i.label)).toEqual(["Overview", "Access", "Reports & Analytics", "Settings"]); // IAM administrator
    expect(visibleNav({ permissions: ["overview.view", "area.exceptional"] }).map((i) => i.label)).toEqual(["Overview", "Exceptional access", "Reports & Analytics", "Settings"]); // Support, SRE
  });

  it("renders only permitted links and marks the current page", () => {
    render(withSession(<Sidebar collapsed={false} onToggle={() => undefined} onNavigate={() => undefined} />, me(POR)));
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Routing Policies" })).not.toHaveTextContent("Soon");
    expect(screen.queryByRole("link", { name: /Payouts/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Audits/ })).toBeNull();
  });

  it('expands and collapses sections independently with accessible controls', () => {
    render(withSession(<Sidebar collapsed={false} onToggle={() => undefined} onNavigate={() => undefined} />, me(POR)));
    const payments = screen.getByRole('button', { name: 'Payments' });
    const funds = screen.getByRole('button', { name: 'Funds & Payouts' });
    expect(payments).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(payments);
    expect(payments).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(payments.getAttribute('aria-controls')!)).toHaveAttribute('hidden');
    expect(screen.queryByRole('link', { name: 'Create Payment' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Settlements' })).toBeInTheDocument();
    fireEvent.click(funds);
    expect(screen.queryByRole('link', { name: 'Settlements' })).toBeNull();
    fireEvent.click(payments);
    expect(screen.getByRole('link', { name: 'Create Payment' })).toBeInTheDocument();
    expect(funds).toHaveAttribute('aria-expanded', 'false');
  });

  it("labels collapsed items for assistive technology", () => {
    render(withSession(<Sidebar collapsed onToggle={() => undefined} onNavigate={() => undefined} />, me(POR)));
    expect(screen.getByRole("link", { name: "Settlements" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it('shows the reference section headings and keeps every authorized destination reachable', () => {
    const permissions = [...new Set(RAIL_SECTIONS.flatMap((section) => section.items.map((item) => item.permission)))];
    render(withSession(<Sidebar collapsed={false} onToggle={() => undefined} onNavigate={() => undefined} />, me(permissions)));
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Command Center', 'Payments', 'Funds & Payouts', 'Operations', 'Risk & Compliance', 'Reports & Analytics', 'Integrations', 'Administration']);
    for (const label of ['Dashboard', 'Activity Feed', 'Create Payment', 'Payment Links', 'Recurring Payments', 'Balances & Accounts', 'Reconciliation', 'KYC / KYB & Onboarding', 'Webhooks', 'TOKs', 'Users & Permissions', 'Settings']) expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
  });

  describe("landing page", () => {
    afterEach(() => vi.unstubAllGlobals());
    const land = (perms: Permission[]) => {
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined))); // panels stay loading
      const router = createMemoryRouter(routes, { initialEntries: ["/"] });
      render(
        <SessionProvider initial={{ status: "ready", me: me(perms), selection: { merchantId: "", legalEntityId: "", currency: "GBP" } }}>
          <RouterProvider router={router} />
        </SessionProvider>,
      );
      return router;
    };

    it("sends Super Admin from / to the Super Admin page (03-05 §10.1 default dashboard)", async () => {
      const router = land(SUPER_ADMIN);
      expect(await screen.findByRole("heading", { level: 1, name: "Super Admin" })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/platform");
    });

    it("keeps Overview as the landing page for roles that have it", () => {
      const router = land(POR);
      expect(router.state.location.pathname).toBe("/");
    });
  });
});
