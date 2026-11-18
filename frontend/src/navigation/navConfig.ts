import type { ComponentType } from "react";
import {
  AuditsGlyph, DevelopersGlyph, FinanceGlyph, MerchantsGlyph, OverviewGlyph, PartnersGlyph, PaymentsGlyph, PayoutsGlyph, RefundsGlyph,
  AccessGlyph, ExceptionalGlyph, PlatformGlyph, ReleaseGlyph, RiskGlyph, RoutingGlyph, type GlyphProps,
} from "./icons";
import type { Me, Permission } from "../types/api";

export interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: ComponentType<GlyphProps>;
  /** Sidebar section heading. Items keep the documents' order. */
  group: "Workspace" | "Financial Operations" | "Platform";
  /** Visible if the user holds this permission. The server decides who holds it. */
  permission: Permission;
  /** Business Requirements screens shown in this area. */
  screens: string[];
}

/**
 * The side rail exactly as Business Requirements (01-05) §07 lists it:
 * "Overview, Merchants, Payment Operations, Routing, Partners, Refunds &
 * Disputes, Finance, Payouts, Risk & Compliance, Developers, Audits, QA &
 * Release. Hide items by persona, enforce authorization server-side."
 */
export const NAV: NavItem[] = [
  { key: "overview", label: "Overview", path: "/", icon: OverviewGlyph, group: "Workspace", permission: "overview.view", screens: [] },
  { key: "merchants", label: "Merchants", path: "/merchants", icon: MerchantsGlyph, group: "Workspace", permission: "area.merchants", screens: ["ZP-BRW-002", "ZP-BRW-003"] },
  { key: "payments", label: "Payment Operations", path: "/payments", icon: PaymentsGlyph, group: "Workspace", permission: "area.payment_operations", screens: ["ZP-BRW-005", "ZP-BRW-004"] },
  { key: "routing", label: "Routing", path: "/routing", icon: RoutingGlyph, group: "Workspace", permission: "area.routing", screens: ["ZP-BRW-006"] },
  { key: "partners", label: "Partners", path: "/partners", icon: PartnersGlyph, group: "Workspace", permission: "area.partners", screens: ["ZP-BRW-007"] },
  { key: "refunds", label: "Refunds & Disputes", path: "/refunds", icon: RefundsGlyph, group: "Financial Operations", permission: "area.refunds_disputes", screens: ["ZP-BRW-008"] },
  { key: "finance", label: "Finance", path: "/finance", icon: FinanceGlyph, group: "Financial Operations", permission: "area.finance", screens: ["ZP-BRW-009", "ZP-BRW-011"] },
  { key: "payouts", label: "Payouts", path: "/payouts", icon: PayoutsGlyph, group: "Financial Operations", permission: "area.payouts", screens: ["ZP-BRW-010"] },
  { key: "risk", label: "Risk & Compliance", path: "/risk", icon: RiskGlyph, group: "Financial Operations", permission: "area.risk_compliance", screens: ["ZP-BRW-012"] },
  { key: "developers", label: "Developers", path: "/developers", icon: DevelopersGlyph, group: "Platform", permission: "area.developers", screens: ["ZP-BRW-013", "ZP-BRW-004"] },
  { key: "audits", label: "Audits", path: "/audits", icon: AuditsGlyph, group: "Platform", permission: "area.audits", screens: [] },
  { key: "release", label: "QA & Release", path: "/release", icon: ReleaseGlyph, group: "Platform", permission: "area.qa_release", screens: ["ZP-BRW-014", "ZP-BRW-001"] },
  // Not in the §07 rail (OPEN_QUESTIONS Q18): role administration, 02-02 ZP-PER-WF-002.
  { key: "access", label: "Access", path: "/access", icon: AccessGlyph, group: "Platform", permission: "area.access", screens: ["ZP-PER-WF-002"] },
  // Not in the §07 rail (Q18, ADR 0004): exceptional access, 02-02 WF-007 and WF-011.
  { key: "exceptional", label: "Exceptional access", path: "/exceptional", icon: ExceptionalGlyph, group: "Platform", permission: "area.exceptional", screens: ["ZP-PER-WF-007", "ZP-PER-WF-011"] },
  // Not in the §07 rail: the Super Admin coordination page from 03-05 §10.1 (OPEN_QUESTIONS Q18).
  { key: "platform", label: "Super Admin", path: "/platform", icon: PlatformGlyph, group: "Platform", permission: "area.platform", screens: [] },
  { key: "operations", label: "Operations", path: "/operations", icon: PlatformGlyph, group: "Platform", permission: "health.view", screens: [] },
  { key: "reports", label: "Reports & Analytics", path: "/reports", icon: AuditsGlyph, group: "Platform", permission: "overview.view", screens: [] },
  { key: "settings", label: "Settings", path: "/settings", icon: PlatformGlyph, group: "Platform", permission: "overview.view", screens: [] },
];

export function isVisible(item: NavItem, me: Pick<Me, "permissions">): boolean {
  return me.permissions.includes(item.permission);
}

/** Only the items this user's role may see. */
export function visibleNav(me: Pick<Me, "permissions">): NavItem[] {
  return NAV.filter((i) => isVisible(i, me));
}

/** The side-rail area that shows a given screen (for search and notification links). */
export function areaForScreen(screenId: string): NavItem | undefined {
  return NAV.find((i) => i.screens.includes(screenId));
}

export function findNav(pathname: string): NavItem | undefined {
  return NAV.find((item) => (item.path === "/" ? pathname === "/" : pathname === item.path || pathname.startsWith(`${item.path}/`)));
}
