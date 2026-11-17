import type { Membership } from "../authorization/principal.js";

/**
 * Membership directory: who may do what, where.
 *
 * In production this is owned by Zoiko Pay (BC-01 merchant membership and
 * BC-02/BC-08 entitlements), never by the identity provider. That service does
 * not exist yet, so this development directory stands in for it. Entries are
 * keyed by the Keycloak user id (`sub`), which is fixed in the local realm
 * import (deploy/compose/keycloak/zoikopay-realm.json).
 *
 * DEVELOPMENT FIXTURE: fictional people, local realm only.
 */
export interface MembershipDirectory {
  find(sub: string): Membership | undefined;
  all(): Membership[];
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BOTH_CELLS = ["cell_uk_01", "cell_eu_01"];

export const DEV_MEMBERSHIPS: Membership[] = [
  { sub: id(1), username: "super.admin", displayName: "Avery Stone", personas: ["SUPER_ADMIN"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST", "LIVE"] } },
  { sub: id(2), username: "ops.agent", displayName: "Rowan Hale", personas: ["POR"],
    scope: { kind: "internal", legalEntityIds: ["cell_uk_01"], tenantIds: "*", merchantIds: "*", environments: ["TEST"] } },
  { sub: id(3), username: "fin.controller.a", displayName: "Jordan Pike", personas: ["PFIN"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST", "LIVE"] } },
  { sub: id(4), username: "fin.controller.b", displayName: "Sam Okafor", personas: ["PFIN"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST"] } },
  { sub: id(5), username: "risk.analyst", displayName: "Morgan Reyes", personas: ["PRISK"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST"] } },
  { sub: id(6), username: "support.agent", displayName: "Casey Lund", personas: ["PSUP"],
    scope: { kind: "internal", legalEntityIds: [], tenantIds: [], merchantIds: [], environments: ["TEST"] } },
  { sub: id(7), username: "security.officer", displayName: "Riley Ward", personas: ["PSEC"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST", "LIVE"] } },
  { sub: id(8), username: "iam.admin", displayName: "Quinn Abara", personas: ["PIAM"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST"] } },
  { sub: id(9), username: "sre.oncall", displayName: "Drew Castillo", personas: ["PSRE"],
    scope: { kind: "internal", legalEntityIds: [], tenantIds: [], merchantIds: [], environments: ["TEST", "LIVE"] } },
  { sub: id(10), username: "merchant.owner", displayName: "Harper Vale", personas: ["MOWN"],
    scope: { kind: "merchant", legalEntityIds: BOTH_CELLS, tenantIds: ["ten_northwind"], merchantIds: "*", environments: ["TEST"] } },
  { sub: id(11), username: "merchant.ops", displayName: "Emery Holt", personas: ["MOPS"],
    scope: { kind: "merchant", legalEntityIds: ["cell_uk_01"], tenantIds: ["ten_northwind"], merchantIds: ["mer_northwind_uk"], environments: ["TEST"] } },
  { sub: id(12), username: "merchant.viewer", displayName: "Finley Moss", personas: ["MVIEW"],
    scope: { kind: "merchant", legalEntityIds: BOTH_CELLS, tenantIds: ["ten_alder"], merchantIds: "*", environments: ["TEST"] } },
  { sub: id(13), username: "compliance.officer", displayName: "Kai Brennan", personas: ["PCOMP"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST"] } },
  { sub: id(14), username: "merchant.finance", displayName: "Ari Lowe", personas: ["MFIN"],
    scope: { kind: "merchant", legalEntityIds: BOTH_CELLS, tenantIds: ["ten_northwind"], merchantIds: "*", environments: ["TEST"] } },
  { sub: id(15), username: "merchant.dev", displayName: "Noa Sato", personas: ["MDEV"],
    scope: { kind: "merchant", legalEntityIds: ["cell_uk_01"], tenantIds: ["ten_northwind"], merchantIds: ["mer_northwind_uk"], environments: ["TEST"] } },
  { sub: id(16), username: "recon.analyst", displayName: "Tali Ross", personas: ["PRECON"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST"] } },
  { sub: id(17), username: "partner.ops", displayName: "Remy Clarke", personas: ["PPSP"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST"] } },
  // Second IAM administrator: role grants need an independent checker (02-02 TENANT.ROLE.GRANT).
  { sub: id(18), username: "iam.admin.b", displayName: "Jules Navarro", personas: ["PIAM"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: "*", merchantIds: "*", environments: ["TEST"] } },
];

export class FixtureDirectory implements MembershipDirectory {
  private readonly bySub = new Map(DEV_MEMBERSHIPS.map((m) => [m.sub, m]));
  find(sub: string): Membership | undefined {
    return this.bySub.get(sub);
  }
  all(): Membership[] {
    return [...this.bySub.values()];
  }
}

export const devUserId = id;
