import type { Permission, Persona } from "../authorization/permissions.js";
import type { FixtureDataset } from "../database/fixtures.js";
import type { Environment } from "../types/domain.js";

export interface Money {
  minor: string;
  currency: string;
}

export type FieldValue = string | number | boolean | null | Money | string[] | Record<string, string>;

/** One row on a console screen. Mock data until the owning Go service exists. */
export interface ScreenRecord {
  id: string;
  status: string;
  version: number;
  /** Ownership for scope checks. Platform-level records (routing, connectors, releases) leave these empty. */
  tenantId?: string;
  merchantId?: string;
  legalEntityId?: string;
  environment: Environment;
  /** Who raised it; used for "requester cannot final-approve". Never sent to the browser. */
  requestedBySub?: string;
  requestedByName?: string;
  fields: Record<string, FieldValue>;
  timeline: { at: string; event: string; actor: string; note?: string }[];
  updatedAt: string;
}

/**
 * A state-changing action, with the rule the spec gives for it. The server
 * enforces every condition; the UI only explains them.
 */
export interface ActionRule {
  label: string;
  /** Statuses the action may start from. */
  from: string[];
  /** Resulting status. */
  to: string;
  /** Personas (02-02 codes) allowed to perform it. */
  deciders: Persona[];
  /** The requester of the record may not perform it (maker-checker). */
  separation: boolean;
  /** A written reason is mandatory. */
  reasonRequired: boolean;
  /** A fresh password re-entry is mandatory (money-affecting decisions). */
  stepUp: boolean;
  /** Extra precondition; returns a refusal message, or null when allowed. */
  guard?: (r: ScreenRecord) => string | null;
  /** Spec reference shown with the action. */
  source: string;
  /** Field changes that follow from the decision (e.g. a gate passing). */
  effect?: (fields: ScreenRecord["fields"]) => ScreenRecord["fields"];
}

export interface ScreenDef {
  id: string;
  title: string;
  /** Side-rail permission required to see the screen at all. */
  area: Permission;
  /** Whether records belong to a tenant/merchant (scope-checked) or to the platform. */
  scoped: boolean;
  /** Mock records for TEST, derived from the same dataset as the dashboard. */
  generate: (ctx: { now: number; base: FixtureDataset }) => ScreenRecord[];
  summary: (rows: ScreenRecord[]) => { label: string; value: string }[];
  actions: Record<string, ActionRule>;
}
