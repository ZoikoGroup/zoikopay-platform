import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_IDS, MERCHANTS, TENANTS } from "../src/database/fixtures.js";
import * as directory from "../src/integrations/directory.js";
import { TEST_MEMBERSHIPS } from "./memberships.js";

const repo = join(import.meta.dirname, "..", "..");
const seed = readFileSync(join(repo, "scripts", "seed-local.sql"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("local seed matches the console fixtures (Q39 1(a))", () => {
  it("creates every fixture tenant and merchant with the same ID and name", () => {
    for (const t of TENANTS) expect(seed, t.name).toContain(`'${t.id}'`);
    for (const m of MERCHANTS) {
      expect(seed, m.displayName).toContain(`'${m.id}'`);
      expect(seed, m.displayName).toContain(`'${m.displayName}'`);
    }
  });

  it("grants only merchant personas, only to the merchant users, with tenant and merchant as in the fixtures", () => {
    for (const m of TEST_MEMBERSHIPS) {
      const row = new RegExp(`'${m.sub}'[^\\n]*`).exec(seed)?.[0];
      if (m.scope.kind === "internal") {
        expect(row, `${m.username} (staff) must get no grant`).toBeUndefined();
        continue;
      }
      expect(row, m.username).toBeDefined();
      expect(row).toContain(`'${m.personas[0]}'`);
      expect(row).toContain(`'${m.scope.tenantIds[0]}'`);
      if (m.scope.merchantIds !== "*") expect(row).toContain(`'${m.scope.merchantIds[0]}'`);
      else expect(row).toContain("NULL");
    }
    expect(seed).not.toMatch(/SUPER_ADMIN|'PIAM'|'PSEC'|'POR'/);
  });

  it("uses IDs in the real ten_/mer_ UUIDv7 format", () => {
    for (const id of Object.values(FIXTURE_IDS.tenants)) expect(id).toMatch(/^ten_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    for (const id of Object.values(FIXTURE_IDS.merchants)) expect(id).toMatch(/^mer_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  });
});

describe("production code holds no roles of its own (Q39, rules 2 and 3)", () => {
  const src = sources(join(import.meta.dirname, "..", "src"));

  it("has no membership list, fixture directory or wildcard tenant", () => {
    expect(Object.keys(directory)).not.toContain("DEV_MEMBERSHIPS");
    expect(Object.keys(directory)).not.toContain("FixtureDirectory");
    for (const f of src) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/DEV_MEMBERSHIPS|FixtureDirectory|tenantIds:\s*"\*"|tenantIds === "\*"/);
    }
  });

  it("has no Supabase code (Keycloak only, provider-agnostic)", () => {
    for (const f of src) expect(readFileSync(f, "utf8"), f).not.toMatch(/supabase/i);
  });
});
