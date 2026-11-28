/**
 * Per-user console preferences (Stripe "Settings": personal details, invoice
 * branding, customer portal) and the setup-guide progress.
 *
 * TEST/DEVELOPMENT ONLY: kept in memory per signed-in user, never shared
 * between users, lost on restart. Every change is validated here and audited.
 * Nothing is emailed, published or sent to an identity provider.
 */
import { AppError } from "../types/errors.js";
import { auditActor, type CallContext, type Services } from "./context.js";

type Check = (v: string) => string | null;
const text: Check = (v) => (v.length <= 200 ? null : "Use at most 200 characters.");
const oneOf = (...options: string[]): Check => (v) => (options.includes(v) ? null : "Choose one of the listed options.");
const email: Check = (v) => (/^[^\s@]{1,64}@[^\s@]{1,120}\.[a-z]{2,24}$/i.test(v) ? null : "Enter a valid email address.");
const phone: Check = (v) => (/^[+0-9 ()-]{6,24}$/.test(v) ? null : "Enter a phone number, for example +44 20 7946 0000.");
const https: Check = (v) => (/^https:\/\/[^\s/$.?#][^\s]{2,190}$/i.test(v) ? null : "Use an https:// address.");
const colour: Check = (v) => (/^#[0-9a-f]{6}$/i.test(v) ? null : "Use a colour like #008333.");

/** The only sections and fields a user may store. Anything else is refused. */
export const PREFERENCE_SECTIONS: Record<string, Record<string, Check>> = {
  personal: { backupEmail: email, phone, trustedLocation: text, connectedAccount: oneOf("None", "Google", "Microsoft") },
  branding: { brandColor: colour, invoicePrefix: (v) => (/^[A-Z0-9]{1,8}$/.test(v) ? null : "Use 1–8 capital letters or digits."), footer: text,
    reminders: oneOf("Off", "3 days before due", "On the due date", "7 days after due") },
  portal: { portal: oneOf("Off", "On"), canCancel: oneOf("No", "Yes, at period end", "Yes, immediately"), returnUrl: https },
};

export class PreferenceStore {
  private readonly byUser = new Map<string, Record<string, Record<string, string>>>();

  get(ctx: CallContext): Record<string, Record<string, string>> {
    return structuredClone(this.byUser.get(ctx.principal.sub) ?? {});
  }

  set(s: Services, ctx: CallContext, section: string, input: Record<string, string>): Record<string, string> {
    const rules = PREFERENCE_SECTIONS[section];
    const deny = (err: AppError): never => {
      s.audit.append({ ...auditActor(ctx), action: `preferences.${section}.update`, outcome: "DENIED", detail: { code: err.code, why: err.detail ?? err.title } });
      throw err;
    };
    if (!rules) return deny(new AppError(404, "NOT_FOUND", "Settings section not found"));
    const clean: Record<string, string> = {};
    for (const [key, raw] of Object.entries(input)) {
      const rule = rules[key];
      if (!rule) return deny(new AppError(400, "VALIDATION_FAILED", "Unknown setting", `“${key}” is not part of ${section}.`));
      const v = raw.trim();
      if (!v) continue; // empty clears the value
      const why = rule(v);
      if (why) return deny(new AppError(400, "VALIDATION_FAILED", `Check “${key}”`, why));
      clean[key] = v;
    }
    const all = this.byUser.get(ctx.principal.sub) ?? {};
    all[section] = clean;
    this.byUser.set(ctx.principal.sub, all);
    s.audit.append({ ...auditActor(ctx), action: `preferences.${section}.update`, outcome: "SUCCEEDED", detail: { fields: Object.keys(clean).join(",") } });
    return { ...clean };
  }
}

/**
 * Setup-guide progress, worked out from what this user has already done
 * (their own successful audit entries), so steps tick themselves.
 */
const STEPS: Record<string, string[]> = {
  details: ["preferences.personal.update"],
  bank: ["screen.ZP-STR-027.create", "screen.ZP-STR-013.create"],
  apikey: ["screen.ZP-STR-034.create", "screen.ZP-STR-034.roll"],
  webhook: ["screen.ZP-BRW-013.create", "screen.ZP-BRW-013.send_test"],
  product: ["screen.ZP-COM-002.create"],
  payment: ["sandbox.payment_intent.preview", "screen.ZP-STR-015.simulate_payment"],
};

export function setupProgress(s: Services, ctx: CallContext): Record<string, boolean> {
  const mine = s.audit.list({ actorSub: ctx.principal.sub, outcome: "SUCCEEDED" });
  const done = new Set(mine.map((e) => e.action));
  return Object.fromEntries(Object.entries(STEPS).map(([step, actions]) => [step, actions.some((a) => done.has(a))]));
}
