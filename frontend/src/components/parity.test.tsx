import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeveloperBar, QuickCreateMenu, SandboxBanner } from "../layouts/ShellExtras";
import { LAYOUTS } from "../screens/config";
import { CREATE_FORMS, MODULE_GROUPS, MODULES } from "../screens/parity";
import { me, withSession } from "../test/fixtures";
import { toMinor } from "./LocalDrafts";
import { ModuleView } from "./ModuleView";
import { ScreenView } from "./ScreenView";
import { api } from "../services/api";
import type { RecordView, ScreenList } from "../types/api";

beforeEach(() => localStorage.clear());
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("Stripe parity (frontend only)", () => {
  it("converts amounts to minor units exactly, without floats", () => {
    expect(toMinor("12.5")).toBe("1250");
    expect(toMinor("0.07")).toBe("7");
    expect(toMinor("1999")).toBe("199900");
    for (const bad of ["0", "0.00", "-1", "1.234", "1e3", "abc", ""]) expect(toMinor(bad)).toBeNull();
  });

  it("has a table layout for every Customers & Billing screen (they rendered blank before)", () => {
    for (const id of ["ZP-COM-001", "ZP-COM-002", "ZP-COM-003", "ZP-COM-004", "ZP-COM-005", "ZP-COM-006"]) {
      expect(LAYOUTS[id]?.columns.length, id).toBeGreaterThan(0);
      if (CREATE_FORMS[id]) expect(CREATE_FORMS[id]?.fields.length, id).toBeGreaterThan(0);
    }
    for (const ids of Object.values(MODULE_GROUPS)) for (const id of ids) expect(MODULES[id], id).toBeDefined();
  });

  it("says a module is not connected and saves a create as a local draft only", () => {
    render(withSession(<ModuleView id="ZP-STR-001" />, me(["area.payment_operations"])));
    expect(screen.getByRole("note")).toHaveTextContent("Not connected yet");
    fireEvent.click(screen.getByRole("button", { name: "Create coupon" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "WINTER10" } });
    fireEvent.change(screen.getByLabelText(/^Type/), { target: { value: "Percentage discount" } });
    fireEvent.change(screen.getByLabelText(/Percent or amount/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/^Duration/), { target: { value: "Once" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Create coupon" }).at(-1)!);
    expect(screen.getByText("WINTER10")).toBeInTheDocument();
    expect(screen.getByText("LOCAL DRAFT")).toBeInTheDocument();
    expect(localStorage.getItem("zp.console.drafts.ZP-STR-001")).toContain("WINTER10");
    // Creating also leaves a demo event in Workbench → Events.
    expect(localStorage.getItem("zp.console.drafts.ZP-STR-032")).toContain("coupon.created");
  });

  it("shows demo values and applies a demo action in this browser only", () => {
    render(withSession(<ModuleView id="ZP-STR-001" />, me(["area.payment_operations"])));
    expect(screen.getByText("WELCOME20")).toBeInTheDocument();
    expect(screen.getAllByText("DEMO").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("WELCOME20"));
    fireEvent.click(screen.getByRole("button", { name: "Expire coupon" }));
    expect(localStorage.getItem("zp.console.status.ZP-STR-001")).toBe(JSON.stringify({ coupon_welcome20: "EXPIRED" }));
    expect(screen.queryByRole("button", { name: "Expire coupon" })).toBeNull();
  });

  it("gives every module demo values", () => {
    for (const ids of Object.values(MODULE_GROUPS)) for (const id of ids) expect(MODULES[id]?.demo?.length, id).toBeGreaterThan(0);
  });

  it("refuses an invalid amount in a create form", () => {
    render(withSession(<ModuleView id="ZP-STR-010" />, me(["area.finance"])));
    fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "12.345" } });
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: "Bank transfer (TEST)" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add funds" }).at(-1)!);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a positive amount");
    expect(localStorage.getItem("zp.console.drafts.ZP-STR-010")).toBeNull();
  });

  it("shows the sandbox strip in TEST only, and hides role-gated shell pieces", () => {
    const { unmount } = render(withSession(<><SandboxBanner /><QuickCreateMenu /><DeveloperBar /></>, me(["overview.view"])));
    expect(screen.getByText(/testing in a sandbox/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Developers/ })).toBeNull();
    unmount();
    render(withSession(<><SandboxBanner /><QuickCreateMenu /><DeveloperBar /></>, me(["area.payment_operations", "area.developers"], { environment: "LIVE", environments: ["TEST", "LIVE"] })));
    expect(screen.queryByText(/testing in a sandbox/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("menuitem", { name: "Customer" })).toHaveAttribute("href", "/commerce?screen=ZP-COM-001&create=1");
    expect(screen.queryByRole("menuitem", { name: "Add funds" })).toBeNull(); // needs area.finance
  });

  it("saves a server create form through the API instead of the browser", async () => {
    const meta = { requestId: "t", environment: "TEST" as const, source: "fixture" as const, asOf: "2026-11-27T00:00:00Z" };
    const list: ScreenList = {
      screen: { id: "ZP-STR-010", title: "Top-ups" }, summary: [], statuses: [], total: 0, items: [],
      create: { label: "Add funds", source: "", allowed: true, fields: [
        { key: "amount", label: "Amount", type: "money", required: true },
        { key: "source", label: "From", type: "select", required: true, options: ["Bank transfer (TEST)"] },
      ] },
    };
    vi.spyOn(api, "screen").mockResolvedValue({ data: list, meta });
    const create = vi.spyOn(api, "create").mockResolvedValue({ data: {} as RecordView, meta });
    render(withSession(<ScreenView screenId="ZP-STR-010" />, me(["area.finance"])));
    fireEvent.click(await screen.findByRole("button", { name: "Add funds" }));
    expect(screen.getByText(/Saved on the console server as a TEST record/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "12.50" } });
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: "Bank transfer (TEST)" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add funds" }).at(-1)!);
    expect(create).toHaveBeenCalledWith("ZP-STR-010", { merchantId: "", values: { amount: "12.50", source: "Bank transfer (TEST)" } });
    expect(localStorage.getItem("zp.console.drafts.ZP-STR-010")).toBeNull(); // nothing saved as a local draft
  });
});
