import type { Membership, SessionUser } from "../src/authorization/principal.js";
import { FIXTURE_IDS, localUserId as id } from "../src/database/fixtures.js";
import type { MembershipDirectory } from "../src/integrations/directory.js";

/**
 * TEST-ONLY memberships for unit tests of the console's authorization logic.
 *
 * Production code has no membership list: roles come from merchant.memberships
 * through the Go gateway (GatewayDirectory, OPEN_QUESTIONS Q39), and platform
 * staff get nothing there yet (36.1, 39.3). Staff rows here exist only so the
 * staff screens' own rules (Super Admin, exceptional access, maker-checker)
 * keep their tests until staff access is built. No row has a wildcard
 * tenant: staff rows list the fixture tenants explicitly.
 */
const T = FIXTURE_IDS.tenants;
const M = FIXTURE_IDS.merchants;
const ALL_TENANTS = [T.northwind, T.alder, T.kestrel];
const BOTH_CELLS = ["cell_uk_01", "cell_eu_01"];

export const TEST_MEMBERSHIPS: Membership[] = [
  { sub: id(1), username: "super.admin", displayName: "Avery Stone", personas: ["SUPER_ADMIN"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST", "LIVE"] } },
  { sub: id(2), username: "ops.agent", displayName: "Rowan Hale", personas: ["POR"],
    scope: { kind: "internal", legalEntityIds: ["cell_uk_01"], tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST"] } },
  { sub: id(3), username: "fin.controller.a", displayName: "Jordan Pike", personas: ["PFIN"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST", "LIVE"] } },
  { sub: id(4), username: "fin.controller.b", displayName: "Sam Okafor", personas: ["PFIN"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST"] } },
  { sub: id(5), username: "risk.analyst", displayName: "Morgan Reyes", personas: ["PRISK"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST"] } },
  { sub: id(6), username: "support.agent", displayName: "Casey Lund", personas: ["PSUP"],
    scope: { kind: "internal", legalEntityIds: [], tenantIds: [], merchantIds: [], environments: ["TEST"] } },
  { sub: id(7), username: "security.officer", displayName: "Riley Ward", personas: ["PSEC"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST", "LIVE"] } },
  { sub: id(8), username: "iam.admin", displayName: "Quinn Abara", personas: ["PIAM"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST"] } },
  { sub: id(9), username: "sre.oncall", displayName: "Drew Castillo", personas: ["PSRE"],
    scope: { kind: "internal", legalEntityIds: [], tenantIds: [], merchantIds: [], environments: ["TEST", "LIVE"] } },
  { sub: id(10), username: "merchant.owner", displayName: "Harper Vale", personas: ["MOWN"],
    scope: { kind: "merchant", legalEntityIds: BOTH_CELLS, tenantIds: [T.northwind], merchantIds: "*", environments: ["TEST"] } },
  { sub: id(11), username: "merchant.ops", displayName: "Emery Holt", personas: ["MOPS"],
    scope: { kind: "merchant", legalEntityIds: ["cell_uk_01"], tenantIds: [T.northwind], merchantIds: [M.northwindUk], environments: ["TEST"] } },
  { sub: id(12), username: "merchant.viewer", displayName: "Finley Moss", personas: ["MVIEW"],
    scope: { kind: "merchant", legalEntityIds: BOTH_CELLS, tenantIds: [T.alder], merchantIds: "*", environments: ["TEST"] } },
  { sub: id(13), username: "compliance.officer", displayName: "Kai Brennan", personas: ["PCOMP"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST"] } },
  { sub: id(14), username: "merchant.finance", displayName: "Ari Lowe", personas: ["MFIN"],
    scope: { kind: "merchant", legalEntityIds: BOTH_CELLS, tenantIds: [T.northwind], merchantIds: "*", environments: ["TEST"] } },
  { sub: id(15), username: "merchant.dev", displayName: "Noa Sato", personas: ["MDEV"],
    scope: { kind: "merchant", legalEntityIds: ["cell_uk_01"], tenantIds: [T.northwind], merchantIds: [M.northwindUk], environments: ["TEST"] } },
  { sub: id(16), username: "recon.analyst", displayName: "Tali Ross", personas: ["PRECON"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST"] } },
  { sub: id(17), username: "partner.ops", displayName: "Remy Clarke", personas: ["PPSP"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST"] } },
  { sub: id(18), username: "iam.admin.b", displayName: "Jules Navarro", personas: ["PIAM"],
    scope: { kind: "internal", legalEntityIds: BOTH_CELLS, tenantIds: ALL_TENANTS, merchantIds: "*", environments: ["TEST"] } },
];

/** Every local realm user: what the fake identity provider accepts. */
export const LOCAL_USERS = TEST_MEMBERSHIPS.map(({ sub, username, displayName }) => ({ sub, username, displayName }));

/**
 * TEST-ONLY directory over TEST_MEMBERSHIPS. Like the real one, it is read on
 * every request; `revoke` takes effect on the next one.
 */
export class TestDirectory implements MembershipDirectory {
  calls = 0;
  private readonly revoked = new Set<string>();
  constructor(private readonly list: Membership[] = TEST_MEMBERSHIPS) {}

  async current(user: SessionUser): Promise<Membership | undefined> {
    this.calls += 1;
    return this.find(user.sub);
  }
  find(sub: string): Membership | undefined {
    return this.revoked.has(sub) ? undefined : this.list.find((m) => m.sub === sub);
  }
  all(): Membership[] {
    return this.list.filter((m) => !this.revoked.has(m.sub));
  }
  revoke(username: string): void {
    const m = this.list.find((x) => x.username === username);
    if (!m) throw new Error(`unknown test user ${username}`);
    this.revoked.add(m.sub);
  }
}
