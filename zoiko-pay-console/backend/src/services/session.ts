import { hasPermission, inScope } from "../authorization/policy.js";
import { STEP_UP_WINDOW_SECONDS } from "../screens/store.js";
import type { CallContext, Services } from "./context.js";

/** Who is signed in and what they may see. The UI uses it for visibility only. */
export function me(_s: Services, ctx: CallContext) {
  const p = ctx.principal;
  return {
    sub: p.sub,
    username: p.username,
    displayName: p.displayName,
    personas: p.personas,
    permissions: [...p.permissions].sort(),
    environment: p.environment,
    environments: p.scope.environments,
    hasAccess: p.personas.length > 0,
    stepUpValidUntil: p.stepUpAt ? new Date((p.stepUpAt + STEP_UP_WINDOW_SECONDS) * 1000).toISOString() : null,
  };
}

/**
 * Header selectors: jurisdictions, merchants and currencies the caller may
 * scope to. Tenant metadata is limited to id and display name. In LIVE (no
 * data source yet) the merchant list is empty.
 */
export function scopeOptions(s: Services, ctx: CallContext) {
  const p = ctx.principal;
  const entities = s.data.legalEntities().filter((e) => p.scope.legalEntityIds.includes(e.id));
  let merchants: { id: string; displayName: string; legalEntityId: string; currencies: string[] }[] = [];
  let liveUnavailable = false;
  try {
    merchants = s.data.merchants(p.environment)
      .filter((m) => inScope(p, { ...m, merchantId: m.id }))
      .map((m) => ({ id: m.id, displayName: m.displayName, legalEntityId: m.legalEntityId, currencies: m.currencies }));
  } catch {
    liveUnavailable = true;
  }
  const currencies = [...new Set(merchants.flatMap((m) => m.currencies))].sort();
  return {
    environment: p.environment,
    environments: p.scope.environments,
    legalEntities: entities,
    merchants,
    currencies: currencies.length ? currencies : [...new Set(entities.map((e) => e.baseCurrency))],
    liveUnavailable,
    canSeeMerchantList: hasPermission(p, "metrics.counts.view") || hasPermission(p, "payments.read"),
  };
}
