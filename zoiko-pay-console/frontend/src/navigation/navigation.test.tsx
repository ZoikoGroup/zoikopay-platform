import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "../App";
import { SessionProvider } from "../hooks/useSession";
import { me, withSession } from "../test/fixtures";
import type { Permission } from "../types/api";
import { NAV, visibleNav } from "./navConfig";
import { Sidebar } from "./Sidebar";

// Permission sets as the backend issues them (backend/src/authorization/permissions.ts).
const POR: Permission[] = ["overview.view", "area.merchants", "area.payment_operations", "area.routing", "area.partners", "area.refunds_disputes", "area.finance"];
// 03-05 §10.1: no Overview; the Super Admin page is the default dashboard.
const SUPER_ADMIN: Permission[] = ["health.view", "area.platform"];

describe("side rail (Business Requirements 01-05 §07)", () => {
  it("lists the 12 §07 items in the documents' order, then the Super Admin page (03-05 §10.1)", () => {
    expect(NAV.slice(0, 12).map((i) => i.label)).toEqual([
      "Overview", "Merchants", "Payment Operations", "Routing", "Partners", "Refunds & Disputes",
      "Finance", "Payouts", "Risk & Compliance", "Developers", "Audits", "QA & Release",
    ]);
    // Additions outside §07, recorded as OPEN_QUESTIONS Q18.
    expect(NAV.slice(12).map((i) => [i.label, i.permission])).toEqual([
      ["Access", "area.access"], ["Exceptional access", "area.exceptional"], ["Super Admin", "area.platform"],
    ]);
  });

  it("hides items by persona", () => {
    expect(visibleNav({ permissions: POR }).map((i) => i.label)).toEqual([
      "Overview", "Merchants", "Payment Operations", "Routing", "Partners", "Refunds & Disputes", "Finance",
    ]);
    expect(visibleNav({ permissions: SUPER_ADMIN }).map((i) => i.label)).toEqual(["Super Admin"]); // Super Admin page only
    expect(visibleNav({ permissions: [] })).toEqual([]);
    expect(visibleNav({ permissions: ["overview.view", "area.access"] }).map((i) => i.label)).toEqual(["Overview", "Access"]); // IAM administrator
    expect(visibleNav({ permissions: ["overview.view", "area.exceptional"] }).map((i) => i.label)).toEqual(["Overview", "Exceptional access"]); // Support, SRE
  });

  it("renders only permitted links and marks the current page", () => {
    render(withSession(<Sidebar collapsed={false} onToggle={() => undefined} onNavigate={() => undefined} />, me(POR)));
    expect(screen.getByRole("link", { name: /Overview/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Routing" })).not.toHaveTextContent("Soon");
    expect(screen.queryByRole("link", { name: /Payouts/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Audits/ })).toBeNull();
  });

  it("labels collapsed items for assistive technology", () => {
    render(withSession(<Sidebar collapsed onToggle={() => undefined} onNavigate={() => undefined} />, me(POR)));
    expect(screen.getByRole("link", { name: "Finance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
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
