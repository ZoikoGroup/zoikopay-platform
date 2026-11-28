/**
 * Stripe dashboard parity, frontend only.
 *
 * - CREATE_FORMS: "+ Add customer", "+ Create product", … on the ZP-COM screens.
 * - QUICK_VIEWS: saved-filter tabs above a table (Stripe "Top customers", …),
 *   applied in the browser to the rows the server already returned.
 * - MODULES: Stripe areas with no backend API yet (ZP-STR-0nn). They show an
 *   honest "not connected" state, and anything created there is a LOCAL DRAFT
 *   in this browser only. Nothing is sent to the server or moves money.
 */
import type { CreateSpec } from "../components/LocalDrafts";
import type { FieldValue, RecordView } from "../types/api";
import type { Column, Kind } from "./config";

const C = (key: string, label: string, kind: Kind = "text"): Column => ({ key, label, kind });
const isMoney = (v: FieldValue | undefined): v is { minor: string; currency: string } =>
  !!v && typeof v === "object" && !Array.isArray(v) && "minor" in v && "currency" in v;

const COUNTRIES = ["United Kingdom", "Germany", "France", "Ireland", "Netherlands", "Spain", "United States"];

export const CREATE_FORMS: Record<string, CreateSpec> = {
  "ZP-COM-006": { label: "Create tax rate", prefix: "txr", status: "ACTIVE", fields: [
    { key: "name", label: "Name", type: "text", required: true, hint: "For example VAT" },
    { key: "jurisdiction", label: "Jurisdiction", type: "select", required: true, options: COUNTRIES },
    { key: "rate", label: "Rate (%)", type: "number", required: true },
    { key: "inclusive", label: "Inclusive or exclusive", type: "select", required: true, options: ["Inclusive", "Exclusive"] },
  ] },
};

export interface QuickView {
  key: string;
  label: string;
  match?: (r: RecordView) => boolean;
  /** Shown instead of filtering when the data for this view is not available yet. */
  unavailable?: string;
}

export const QUICK_VIEWS: Record<string, QuickView[]> = {
  "ZP-COM-001": [
    { key: "all", label: "All" },
    { key: "top", label: "Top customers", match: (r) => Number(r.fields.payments) >= 8 },
    { key: "first", label: "First-time customers", match: (r) => Number(r.fields.payments) <= 1 },
    { key: "refunds", label: "High refunds", unavailable: "Refunds per customer are not available from the server yet." },
    { key: "disputes", label: "High disputes", unavailable: "Disputes per customer are not available from the server yet." },
    { key: "balances", label: "Remaining balances", match: (r) => r.status === "DELINQUENT" },
  ],
  "ZP-COM-002": [
    { key: "all", label: "All products" },
    { key: "active", label: "Active", match: (r) => r.status === "ACTIVE" },
    { key: "archived", label: "Archived", match: (r) => r.status === "ARCHIVED" },
    { key: "recurring", label: "Recurring", match: (r) => String(r.fields.billing ?? "").startsWith("Recurring") },
  ],
  "ZP-COM-004": [
    { key: "all", label: "All" },
    { key: "active", label: "Active", match: (r) => r.status === "ACTIVE" },
    { key: "trialing", label: "Trialing", match: (r) => r.status === "TRIALING" },
    { key: "past_due", label: "Past due", match: (r) => r.status === "PAST_DUE" },
    { key: "canceled", label: "Canceled", match: (r) => r.status === "CANCELED" },
  ],
  "ZP-COM-005": [
    { key: "all", label: "All invoices" },
    { key: "draft", label: "Draft", match: (r) => r.status === "DRAFT" },
    { key: "open", label: "Outstanding", match: (r) => r.status === "OPEN" },
    { key: "paid", label: "Paid", match: (r) => r.status === "PAID" },
    { key: "past_due", label: "Past due", match: (r) => r.status === "OPEN" && String(r.fields.dueDate ?? "9999") < new Date().toISOString().slice(0, 10) },
  ],
};

/** Highest total spent first, for the "Top customers" view (per currency, exact BigInt comparison). */
export function byTotalSpent(a: RecordView, b: RecordView): number {
  const x = a.fields.totalSpent, y = b.fields.totalSpent;
  if (!isMoney(x) || !isMoney(y)) return 0;
  const d = BigInt(y.minor) - BigInt(x.minor);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

// --------------------------------------------------------------------------
// Stripe areas with no backend yet (frontend preview + local drafts).

export interface ModuleDef {
  id: string;
  title: string;
  intent: string;
  noun: string;
  columns: Column[];
  create?: CreateSpec;
  /** Approval-type records: the draft waits for a second person (shown, not enforced: no server). */
  note?: string;
  /** Demo values shown until a service provides real records. */
  demo?: DemoRow[];
  /** Demo actions on a row (this browser only). */
  actions?: LocalAction[];
  /** A Stripe-style preview shown above the table. */
  extra?: "checkout" | "cards" | "sigma" | "pricing" | "capital" | "keys";
}

export interface DemoRow { id: string; status: string; fields: Record<string, FieldValue> }

/**
 * A demo action: changes the row's status in this browser only, and can add a
 * demo event to Workbench → Events. Nothing reaches the server or moves money.
 */
export interface LocalAction {
  label: string;
  from: string[];
  to: string;
  danger?: boolean;
  emit?: string;
  toast?: string;
  match?: (fields: Record<string, FieldValue>) => boolean;
}

const M = (id: string, title: string, noun: string, intent: string, columns: Column[], create?: CreateSpec, note?: string): ModuleDef =>
  ({ id, title, noun, intent, columns, ...(create ? { create } : {}), ...(note ? { note } : {}) });
const APPROVAL = "Money movement needs a second person to approve it with a password. That approval needs the payouts service, which is not connected, so this draft cannot be approved here.";

export const MODULES: Record<string, ModuleDef> = Object.fromEntries([
  // Product catalogue tabs
  M("ZP-STR-001", "Coupons", "coupon", "Discounts customers can apply to invoices, subscriptions and checkout.",
    [C("merchant", "Merchant"), C("name", "Name"), C("discountType", "Type"), C("value", "Value", "mono"), C("duration", "Duration")],
    { label: "Create coupon", prefix: "coupon", status: "ACTIVE", fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "discountType", label: "Type", type: "select", required: true, options: ["Percentage discount", "Fixed amount discount"] },
      { key: "value", label: "Percent or amount", type: "number", required: true },
      { key: "duration", label: "Duration", type: "select", required: true, options: ["Once", "Multiple months", "Forever"] },
      { key: "redeemBy", label: "Redeem by", type: "date" },
    ] }),
  M("ZP-STR-002", "Shipping Rates", "shipping rate", "Shipping options and prices offered at checkout.",
    [C("merchant", "Merchant"), C("name", "Name"), C("amount", "Amount", "money"), C("delivery", "Delivery estimate"), C("taxBehavior", "Tax")],
    { label: "Create shipping rate", prefix: "shr", status: "ACTIVE", fields: [
      { key: "name", label: "Name", type: "text", required: true, hint: "For example Standard (3–5 days)" },
      { key: "amount", label: "Amount", type: "money", required: true },
      { key: "delivery", label: "Delivery estimate", type: "text" },
      { key: "taxBehavior", label: "Tax", type: "select", options: ["Inclusive", "Exclusive", "Unspecified"] },
    ] }),
  M("ZP-STR-003", "Pricing Tables", "pricing table", "Embeddable tables that show product prices and let customers subscribe.",
    [C("merchant", "Merchant"), C("name", "Name"), C("products", "Products"), C("interval", "Interval")],
    { label: "Create pricing table", prefix: "prctbl", status: "DRAFT", fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "products", label: "Products (comma-separated)", type: "text", required: true },
      { key: "interval", label: "Default interval", type: "select", options: ["Monthly", "Yearly"] },
    ] }),
  M("ZP-STR-004", "Features", "feature", "Product features (entitlements) that a subscription unlocks.",
    [C("merchant", "Merchant"), C("name", "Name"), C("lookupKey", "Lookup key", "mono"), C("products", "Attached products")],
    { label: "Create feature", prefix: "feat", status: "ACTIVE", fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "lookupKey", label: "Lookup key", type: "text", required: true, hint: "For example premium_support" },
      { key: "products", label: "Attached products", type: "text" },
    ] }),
  // Billing
  M("ZP-STR-005", "Simulations (Test Clocks)", "test clock", "Move time forward in TEST to see how subscriptions renew, trial and fail.",
    [C("merchant", "Merchant"), C("name", "Name"), C("frozenTime", "Clock time", "mono")],
    { label: "Create test clock", prefix: "clock", status: "READY", fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "frozenTime", label: "Start the clock at", type: "date", required: true },
    ] }),
  M("ZP-STR-006", "Subscription Migrations", "migration", "Move subscriptions from another billing system.",
    [C("merchant", "Merchant"), C("source", "From"), C("count", "Subscriptions", "mono")],
    { label: "Start migration", prefix: "mig", status: "DRAFT", fields: [
      { key: "source", label: "From", type: "select", required: true, options: ["CSV file", "Another billing provider"] },
      { key: "count", label: "Number of subscriptions", type: "number", required: true },
    ] }),
  M("ZP-STR-007", "Usage-based Billing", "meter", "Meters that count usage (API calls, seats, GB) and bill for it.",
    [C("merchant", "Merchant"), C("name", "Meter"), C("eventName", "Event name", "mono"), C("aggregation", "Aggregation")],
    { label: "Create meter", prefix: "mtr", status: "ACTIVE", fields: [
      { key: "name", label: "Meter name", type: "text", required: true },
      { key: "eventName", label: "Event name", type: "text", required: true, hint: "For example api_requests" },
      { key: "aggregation", label: "Aggregation", type: "select", required: true, options: ["Sum", "Count", "Last value"] },
    ] }),
  M("ZP-STR-008", "Revenue Recovery", "retry rule", "Automatic retries and reminder emails for failed subscription payments.",
    [C("merchant", "Merchant"), C("name", "Rule"), C("retries", "Retries", "mono"), C("window", "Retry window"), C("finalAction", "If all retries fail")],
    { label: "Create retry rule", prefix: "rr", status: "ACTIVE", fields: [
      { key: "name", label: "Rule name", type: "text", required: true },
      { key: "retries", label: "Number of retries", type: "number", required: true },
      { key: "window", label: "Retry window", type: "select", required: true, options: ["1 week", "2 weeks", "3 weeks", "1 month"] },
      { key: "finalAction", label: "If all retries fail", type: "select", required: true, options: ["Cancel subscription", "Mark unpaid", "Leave past due"] },
    ] }),
  M("ZP-STR-009", "Retention", "retention offer", "Offers shown when a customer tries to cancel.",
    [C("merchant", "Merchant"), C("name", "Offer"), C("discount", "Discount"), C("appliesTo", "Applies to")],
    { label: "Create retention offer", prefix: "ret", status: "ACTIVE", fields: [
      { key: "name", label: "Offer name", type: "text", required: true },
      { key: "discount", label: "Discount", type: "select", required: true, options: ["10% for 3 months", "25% for 3 months", "1 month free"] },
      { key: "appliesTo", label: "Applies to", type: "text", hint: "Plan or product" },
    ] }),
  // Money movement
  M("ZP-STR-010", "Top-ups (Add Funds)", "top-up", "Add funds to the balance from a bank account.",
    [C("merchant", "Merchant"), C("amount", "Amount", "money"), C("source", "From"), C("description", "Description")],
    { label: "Add funds", prefix: "tu", status: "REQUIRES_APPROVAL", fields: [
      { key: "amount", label: "Amount", type: "money", required: true },
      { key: "source", label: "From", type: "select", required: true, options: ["Bank transfer (TEST)", "Linked account (TEST)"] },
      { key: "description", label: "Description", type: "text" },
    ] }, APPROVAL),
  M("ZP-STR-011", "Transfers", "transfer", "Move funds from your balance to another account or connected merchant.",
    [C("merchant", "Merchant"), C("amount", "Amount", "money"), C("destination", "Destination"), C("description", "Description")],
    { label: "Transfer", prefix: "tr", status: "REQUIRES_APPROVAL", fields: [
      { key: "amount", label: "Amount", type: "money", required: true },
      { key: "destination", label: "Destination", type: "text", required: true, hint: "Account or merchant name" },
      { key: "description", label: "Description", type: "text" },
    ] }, APPROVAL),
  M("ZP-STR-012", "Collected Fees", "collected fee", "Platform fees collected on payments made through connected merchants.",
    [C("merchant", "Merchant"), C("payment", "Payment", "mono"), C("amount", "Fee", "money")]),
  M("ZP-STR-013", "Settlement Currencies", "settlement currency", "Extra currencies the balance can hold and pay out in.",
    [C("merchant", "Merchant"), C("currency", "Currency", "mono"), C("account", "Bank account")],
    { label: "Add settlement currency", prefix: "sc", status: "PENDING_VERIFICATION", fields: [
      { key: "currency", label: "Currency", type: "select", required: true, options: ["GBP", "EUR", "USD"] },
      { key: "account", label: "Bank account (last 4 digits)", type: "text", required: true },
    ] }, "A new currency's bank account must be verified before it can receive payouts."),
  M("ZP-STR-014", "Payout Schedule", "payout schedule", "How often available funds are paid out automatically.",
    [C("merchant", "Merchant"), C("schedule", "Pay out"), C("delay", "Delay"), C("minimum", "Minimum balance", "money")],
    { label: "Change payout schedule", prefix: "psch", status: "REQUIRES_APPROVAL", fields: [
      { key: "schedule", label: "Pay out", type: "select", required: true, options: ["Every day", "Every week (Monday)", "Every month (1st)", "Manually"] },
      { key: "delay", label: "Delay", type: "select", options: ["2 business days", "7 days", "14 days"] },
      { key: "minimum", label: "Minimum balance to keep", type: "money" },
    ] }, "Changing where or how often money is paid out needs a second person's approval."),
  // Payment products
  M("ZP-STR-015", "Checkout", "checkout session", "Hosted payment pages that take a payment or start a subscription.",
    [C("merchant", "Merchant"), C("mode", "Mode"), C("amount", "Amount", "money"), C("successUrl", "Success URL", "mono")],
    { label: "Create checkout session", prefix: "cs", status: "OPEN", fields: [
      { key: "mode", label: "Mode", type: "select", required: true, options: ["Payment", "Subscription", "Setup"] },
      { key: "amount", label: "Amount", type: "money", required: true },
      { key: "successUrl", label: "Success URL", type: "url" },
    ] }),
  M("ZP-STR-016", "Terminal", "reader", "Card readers for in-person payments.",
    [C("merchant", "Merchant"), C("label", "Label"), C("device", "Device"), C("location", "Location")],
    { label: "Register reader", prefix: "tmr", status: "OFFLINE", fields: [
      { key: "label", label: "Label", type: "text", required: true },
      { key: "device", label: "Device", type: "select", required: true, options: ["Countertop reader", "Mobile reader", "Simulated reader (TEST)"] },
      { key: "location", label: "Location", type: "text", required: true },
    ] }),
  M("ZP-STR-017", "Agentic Commerce", "agent connection", "Let AI shopping agents buy from your catalogue with a spending limit.",
    [C("merchant", "Merchant"), C("agent", "Agent"), C("limit", "Spending limit", "money"), C("scope", "Scope")],
    { label: "Connect agent", prefix: "agt", status: "DISABLED", fields: [
      { key: "agent", label: "Agent name", type: "text", required: true },
      { key: "limit", label: "Spending limit per order", type: "money", required: true },
      { key: "scope", label: "Scope", type: "select", required: true, options: ["Whole catalogue", "Selected products"] },
    ] }),
  M("ZP-STR-018", "Link", "Link customer", "Customers who saved their payment details for one-click checkout.",
    [C("merchant", "Merchant"), C("customer", "Customer"), C("methods", "Saved methods", "mono")]),
  M("ZP-STR-019", "Standalone 3DS", "3DS authentication", "3-D Secure card authentication without a payment.",
    [C("merchant", "Merchant"), C("card", "Card", "mono"), C("amount", "Amount", "money"), C("outcome", "Outcome")]),
  // Reporting
  M("ZP-STR-020", "Custom Metrics", "custom metric", "Your own metrics built from payments, refunds and fees.",
    [C("merchant", "Merchant"), C("name", "Metric"), C("formula", "Formula", "mono"), C("value", "Current value", "mono")],
    { label: "Create metric", prefix: "cm", status: "ACTIVE", fields: [
      { key: "name", label: "Metric name", type: "text", required: true },
      { key: "formula", label: "Formula", type: "text", required: true, hint: "For example refunds ÷ payments" },
    ] }),
  M("ZP-STR-021", "Sigma (Saved Queries)", "saved query", "SQL queries over your payment data. Saved here only: this console does not run SQL.",
    [C("merchant", "Merchant"), C("name", "Query"), C("schedule", "Schedule"), C("sql", "SQL", "mono")],
    { label: "Save query", prefix: "sq", status: "SAVED", fields: [
      { key: "name", label: "Query name", type: "text", required: true },
      { key: "sql", label: "SQL", type: "textarea", required: true },
      { key: "schedule", label: "Schedule", type: "select", options: ["Not scheduled", "Daily", "Weekly", "Monthly"] },
    ] }),
  M("ZP-STR-022", "Revenue Recognition", "revenue period", "Recognised and deferred revenue per accounting period.",
    [C("merchant", "Merchant"), C("period", "Period", "mono"), C("recognised", "Recognised", "money"), C("deferred", "Deferred", "money")]),
  M("ZP-STR-023", "Data Management", "data pipeline", "Send your payment data to a data warehouse, or import data.",
    [C("merchant", "Merchant"), C("name", "Pipeline"), C("destination", "Destination"), C("frequency", "Frequency")],
    { label: "Add data pipeline", prefix: "dp", status: "PAUSED", fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "destination", label: "Destination", type: "select", required: true, options: ["Data warehouse", "Cloud storage (CSV)", "Import from file"] },
      { key: "frequency", label: "Frequency", type: "select", options: ["Every 6 hours", "Daily", "Weekly"] },
    ] }),
  // Treasury & Capital
  M("ZP-STR-024", "Treasury Accounts", "financial account", "Accounts that hold, send and receive funds.",
    [C("merchant", "Merchant"), C("nickname", "Account"), C("currency", "Currency", "mono"), C("balance", "Balance", "money")],
    { label: "Open financial account", prefix: "fa", status: "REQUIRES_APPROVAL", fields: [
      { key: "nickname", label: "Nickname", type: "text", required: true },
      { key: "currency", label: "Currency", type: "select", required: true, options: ["GBP", "EUR", "USD"] },
    ] }, APPROVAL),
  M("ZP-STR-025", "Issuing (Cards)", "card", "Virtual and physical cards for spending from your balance.",
    [C("merchant", "Merchant"), C("cardholder", "Cardholder"), C("type", "Type"), C("limit", "Spending limit", "money")],
    { label: "Create card", prefix: "ic", status: "INACTIVE", fields: [
      { key: "cardholder", label: "Cardholder", type: "text", required: true },
      { key: "type", label: "Type", type: "select", required: true, options: ["Virtual", "Physical"] },
      { key: "limit", label: "Monthly spending limit", type: "money", required: true },
    ] }, "A new card stays inactive until a second person activates it."),
  M("ZP-STR-026", "Capital", "financing offer", "Business financing offers based on your payment volume.",
    [C("merchant", "Merchant"), C("amount", "Offer", "money"), C("fee", "Fixed fee", "money"), C("expires", "Expires", "mono")]),
  M("ZP-STR-027", "Financial Connections", "linked account", "Bank accounts linked for payouts, top-ups and verification.",
    [C("merchant", "Merchant"), C("institution", "Bank"), C("last4", "Account", "mono")],
    { label: "Link bank account", prefix: "fca", status: "PENDING_VERIFICATION", fields: [
      { key: "institution", label: "Bank name", type: "text", required: true },
      { key: "last4", label: "Account (last 4 digits)", type: "text", required: true },
    ] }),
  // More
  M("ZP-STR-028", "Identity", "verification session", "Verify a person's identity document and selfie.",
    [C("merchant", "Merchant"), C("type", "Check"), C("reference", "Reference", "mono")],
    { label: "Create verification", prefix: "vs", status: "REQUIRES_INPUT", fields: [
      { key: "type", label: "Check", type: "select", required: true, options: ["Identity document", "Document and selfie", "ID number"] },
      { key: "reference", label: "Your reference", type: "text", required: true },
    ] }),
  M("ZP-STR-029", "Profiles", "business profile", "Your public business details shown to customers.",
    [C("merchant", "Merchant"), C("publicName", "Public name"), C("supportEmail", "Support email"), C("website", "Website", "mono")],
    { label: "Create profile", prefix: "prof", status: "UNVERIFIED", fields: [
      { key: "publicName", label: "Public business name", type: "text", required: true },
      { key: "supportEmail", label: "Support email", type: "email", required: true },
      { key: "website", label: "Website", type: "url" },
    ] }),
  M("ZP-STR-030", "Climate", "climate contribution", "Give a share of revenue to carbon removal.",
    [C("merchant", "Merchant"), C("share", "Share of revenue")],
    { label: "Set contribution", prefix: "clim", status: "ACTIVE", fields: [
      { key: "share", label: "Share of revenue", type: "select", required: true, options: ["0.5%", "1%", "2%"] },
    ] }),
  M("ZP-STR-031", "Atlas", "company", "Start a new company (incorporation).",
    [C("merchant", "Merchant"), C("company", "Company"), C("jurisdiction", "Jurisdiction")],
    { label: "Start a company", prefix: "atl", status: "DRAFT", fields: [
      { key: "company", label: "Company name", type: "text", required: true },
      { key: "jurisdiction", label: "Jurisdiction", type: "select", required: true, options: ["United Kingdom", "Ireland", "United States (Delaware)"] },
    ] }),
  // Workbench
  M("ZP-STR-032", "Events", "event", "Every event sent to your webhook endpoints, with delivery status.",
    [C("merchant", "Merchant"), C("type", "Event type", "mono"), C("resource", "Resource", "mono"), C("delivered", "Delivery")]),
  M("ZP-STR-033", "Logs", "request log", "API requests made with your keys: method, path and response code.",
    [C("merchant", "Merchant"), C("method", "Method", "mono"), C("path", "Path", "mono"), C("code", "Response", "mono")]),
  M("ZP-STR-034", "API Keys", "API key", "Keys your servers use to call the API. Demo keys only.",
    [C("name", "Name"), C("token", "Token", "mono"), C("lastUsed", "Last used", "mono")],
    { label: "Create restricted key", prefix: "rk", status: "ACTIVE", fields: [
      { key: "name", label: "Key name", type: "text", required: true },
      { key: "permissions", label: "Permissions", type: "select", required: true, options: ["Charges: read", "Customers: write", "All resources: read"] },
    ] }),
].map((m) => [m.id, m]));

/**
 * Modules the console server now serves as TEST fixtures (backend/src/screens/finance.ts):
 * they use the normal screen view, server create forms and server-checked actions
 * (maker-checker, password re-entry) instead of browser-only demo values.
 */
/** Finance screens (backend/src/screens/finance.ts): money requests need a second approver. */
export const SERVER_FINANCE = new Set([
  "ZP-STR-010", "ZP-STR-011", "ZP-STR-012", "ZP-STR-013", "ZP-STR-014",
  "ZP-STR-020", "ZP-STR-021", "ZP-STR-022", "ZP-STR-023",
  "ZP-STR-024", "ZP-STR-025", "ZP-STR-026", "ZP-STR-027",
]);
/** Billing tools (backend/src/screens/billing.ts). */
export const SERVER_BILLING = new Set([
  "ZP-STR-001", "ZP-STR-002", "ZP-STR-003", "ZP-STR-004", "ZP-STR-005", "ZP-STR-006", "ZP-STR-007", "ZP-STR-008", "ZP-STR-009",
]);
/** Developer workbench (backend/src/screens/developers.ts). */
export const SERVER_DEVELOPERS = new Set(["ZP-STR-032", "ZP-STR-033", "ZP-STR-034"]);
export const SERVER_MODULES = new Set([...SERVER_FINANCE, ...SERVER_BILLING, ...SERVER_DEVELOPERS]);

/** Sidebar/area groups for the modules (each becomes one side-rail area). */
export const MODULE_GROUPS = {
  billing: ["ZP-STR-005", "ZP-STR-006", "ZP-STR-007", "ZP-STR-008", "ZP-STR-009"],
  money: ["ZP-STR-010", "ZP-STR-011", "ZP-STR-012", "ZP-STR-013", "ZP-STR-014"],
  paymentProducts: ["ZP-STR-015", "ZP-STR-016", "ZP-STR-017", "ZP-STR-018", "ZP-STR-019"],
  reporting: ["ZP-STR-020", "ZP-STR-021", "ZP-STR-022", "ZP-STR-023"],
  treasury: ["ZP-STR-024", "ZP-STR-025", "ZP-STR-026", "ZP-STR-027"],
  moreProducts: ["ZP-STR-028", "ZP-STR-029", "ZP-STR-030", "ZP-STR-031"],
  workbench: ["ZP-STR-032", "ZP-STR-033", "ZP-STR-034"],
} satisfies Record<string, string[]>;

// --------------------------------------------------------------------------
// Demo values and demo actions (frontend only; this browser only).

const g = (pounds: number): FieldValue => ({ minor: String(Math.round(pounds * 100)), currency: "GBP" });
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const NW = "Northwind Outfitters UK", AB = "Alder Books", KS = "Kestrel Studio UK";
const row = (id: string, status: string, fields: Record<string, FieldValue>): DemoRow => ({ id, status, fields });
const on = (label: string, from: string, to: string, extra: Partial<LocalAction> = {}): LocalAction => ({ label, from: [from], to, ...extra });

const DEMO: Record<string, Pick<ModuleDef, "demo" | "actions" | "extra">> = {
  "ZP-STR-001": { demo: [
    row("coupon_welcome20", "ACTIVE", { merchant: NW, name: "WELCOME20", discountType: "Percentage discount", value: "20%", duration: "Once" }),
    row("coupon_annual15", "ACTIVE", { merchant: KS, name: "ANNUAL15", discountType: "Percentage discount", value: "15%", duration: "Forever" }),
    row("coupon_spring5", "EXPIRED", { merchant: AB, name: "SPRING5", discountType: "Fixed amount discount", value: "£5.00", duration: "Once" }),
  ], actions: [on("Expire coupon", "ACTIVE", "EXPIRED", { danger: true, emit: "coupon.deleted" })] },
  "ZP-STR-002": { demo: [
    row("shr_standard", "ACTIVE", { merchant: NW, name: "Standard (3–5 days)", amount: g(4.95), delivery: "3–5 business days", taxBehavior: "Inclusive" }),
    row("shr_express", "ACTIVE", { merchant: NW, name: "Express (next day)", amount: g(9.95), delivery: "1 business day", taxBehavior: "Inclusive" }),
    row("shr_free", "ARCHIVED", { merchant: AB, name: "Free over £50", amount: g(0.01), delivery: "5–7 business days", taxBehavior: "Unspecified" }),
  ], actions: [on("Archive", "ACTIVE", "ARCHIVED"), on("Unarchive", "ARCHIVED", "ACTIVE")] },
  "ZP-STR-003": { extra: "pricing", demo: [
    row("prctbl_web", "ACTIVE", { merchant: KS, name: "Website pricing", products: "Studio Pro, Studio Team", interval: "Monthly" }),
    row("prctbl_launch", "DRAFT", { merchant: AB, name: "Launch offer", products: "Reader Plus", interval: "Yearly" }),
  ], actions: [on("Publish", "DRAFT", "ACTIVE", { emit: "pricing_table.updated" })] },
  "ZP-STR-004": { demo: [
    row("feat_priority", "ACTIVE", { merchant: KS, name: "Priority support", lookupKey: "priority_support", products: "Studio Team" }),
    row("feat_sso", "ACTIVE", { merchant: KS, name: "Single sign-on", lookupKey: "sso", products: "Studio Team" }),
    row("feat_offline", "ACTIVE", { merchant: AB, name: "Offline reading", lookupKey: "offline_reading", products: "Reader Plus" }),
  ] },
  "ZP-STR-005": { demo: [
    row("clock_renewal", "READY", { merchant: KS, name: "Renewal test", frozenTime: ago(0) }),
    row("clock_trial", "READY", { merchant: AB, name: "Trial ends", frozenTime: ago(-7) }),
  ], actions: [on("Advance 1 month", "READY", "READY", { emit: "test_helpers.test_clock.advanced", toast: "Clock moved forward 1 month. Renewal invoices created (demo)." })] },
  "ZP-STR-006": { demo: [
    row("mig_csv", "COMPLETED", { merchant: NW, source: "CSV file", count: "48" }),
    row("mig_other", "PROCESSING", { merchant: AB, source: "Another billing provider", count: "112" }),
  ] },
  "ZP-STR-007": { demo: [
    row("mtr_api", "ACTIVE", { merchant: KS, name: "API requests", eventName: "api_request", aggregation: "Sum" }),
    row("mtr_seats", "ACTIVE", { merchant: KS, name: "Active seats", eventName: "seat_active", aggregation: "Last value" }),
  ], actions: [on("Record 1,000 events", "ACTIVE", "ACTIVE", { emit: "billing.meter_event", toast: "Recorded 1,000 events (demo)" }), on("Deactivate", "ACTIVE", "INACTIVE")] },
  "ZP-STR-008": { demo: [
    row("rr_smart", "ACTIVE", { merchant: KS, name: "Smart retries", retries: "8", window: "2 weeks", finalAction: "Cancel subscription" }),
    row("rr_books", "PAUSED", { merchant: AB, name: "Gentle reminders", retries: "4", window: "1 week", finalAction: "Leave past due" }),
  ], actions: [on("Pause", "ACTIVE", "PAUSED"), on("Resume", "PAUSED", "ACTIVE")] },
  "ZP-STR-009": { demo: [
    row("ret_stay25", "ACTIVE", { merchant: KS, name: "Stay for 25% off", discount: "25% for 3 months", appliesTo: "Studio Pro" }),
    row("ret_free", "PAUSED", { merchant: AB, name: "One month on us", discount: "1 month free", appliesTo: "Reader Plus" }),
  ], actions: [on("Pause", "ACTIVE", "PAUSED"), on("Resume", "PAUSED", "ACTIVE")] },
  "ZP-STR-010": { demo: [
    row("tu_reserve", "SUCCEEDED", { merchant: NW, amount: g(5000), source: "Bank transfer (TEST)", description: "Refund reserve" }),
    row("tu_buffer", "REQUIRES_APPROVAL", { merchant: AB, amount: g(1200), source: "Linked account (TEST)", description: "Dispute buffer" }),
  ], actions: [on("Approve (demo)", "REQUIRES_APPROVAL", "SUCCEEDED", { emit: "topup.succeeded" }), on("Cancel", "REQUIRES_APPROVAL", "CANCELED", { danger: true })] },
  "ZP-STR-011": { demo: [
    row("tr_share1", "PAID", { merchant: NW, amount: g(845.2), destination: "Alder Books", description: "Marketplace share" }),
    row("tr_share2", "REQUIRES_APPROVAL", { merchant: KS, amount: g(310), destination: "Kestrel Studio EU", description: "Internal transfer" }),
  ], actions: [on("Approve (demo)", "REQUIRES_APPROVAL", "PAID", { emit: "transfer.created" }), on("Cancel", "REQUIRES_APPROVAL", "CANCELED", { danger: true })] },
  "ZP-STR-012": { demo: [
    row("fee_1", "COLLECTED", { merchant: AB, payment: "pi_demo_8F2k", amount: g(3.12) }),
    row("fee_2", "COLLECTED", { merchant: NW, payment: "pi_demo_Q7wz", amount: g(7.4) }),
    row("fee_3", "REFUNDED", { merchant: KS, payment: "pi_demo_L0pa", amount: g(1.95) }),
  ] },
  "ZP-STR-013": { demo: [
    row("sc_gbp", "ACTIVE", { merchant: NW, currency: "GBP", account: "Northwind Bank ••6789" }),
    row("sc_usd", "PENDING_VERIFICATION", { merchant: AB, currency: "USD", account: "Harbour Bank ••4410" }),
  ], actions: [on("Mark verified (demo)", "PENDING_VERIFICATION", "ACTIVE")] },
  "ZP-STR-014": { demo: [
    row("psch_nw", "ACTIVE", { merchant: NW, schedule: "Every day", delay: "2 business days", minimum: g(500) }),
    row("psch_ab", "REQUIRES_APPROVAL", { merchant: AB, schedule: "Every week (Monday)", delay: "7 days", minimum: g(250) }),
  ], actions: [on("Approve (demo)", "REQUIRES_APPROVAL", "ACTIVE", { emit: "account.updated" })] },
  "ZP-STR-015": { extra: "checkout", demo: [
    row("cs_demo_1", "COMPLETE", { merchant: KS, mode: "Subscription", amount: g(29), successUrl: "https://kestrel.example/thanks" }),
    row("cs_demo_2", "OPEN", { merchant: NW, mode: "Payment", amount: g(129), successUrl: "https://northwind.example/done" }),
    row("cs_demo_3", "EXPIRED", { merchant: AB, mode: "Payment", amount: g(25), successUrl: "https://alder.example/ok" }),
  ], actions: [on("Expire session", "OPEN", "EXPIRED", { danger: true, emit: "checkout.session.expired" })] },
  "ZP-STR-016": { demo: [
    row("tmr_counter", "ONLINE", { merchant: NW, label: "Front counter", device: "Countertop reader", location: "London store" }),
    row("tmr_popup", "OFFLINE", { merchant: NW, label: "Pop-up stand", device: "Mobile reader", location: "Weekend market" }),
  ], actions: [on("Simulate a card tap", "ONLINE", "ONLINE", { emit: "payment_intent.succeeded", toast: "Card tapped: £18.40 approved (demo)" }), on("Bring online", "OFFLINE", "ONLINE")] },
  "ZP-STR-017": { demo: [
    row("agt_shop", "ENABLED", { merchant: NW, agent: "Shopping assistant", limit: g(250), scope: "Whole catalogue" }),
    row("agt_books", "DISABLED", { merchant: AB, agent: "Reading companion", limit: g(40), scope: "Selected products" }),
  ], actions: [on("Disable", "ENABLED", "DISABLED"), on("Enable", "DISABLED", "ENABLED")] },
  "ZP-STR-018": { demo: [
    row("link_c1", "ACTIVE", { merchant: NW, customer: "a••••@example.com", methods: "2" }),
    row("link_c2", "ACTIVE", { merchant: AB, customer: "m••••@example.com", methods: "1" }),
  ] },
  "ZP-STR-019": { demo: [
    row("3ds_1", "AUTHENTICATED", { merchant: NW, card: "VISA •• 4242", amount: g(129), outcome: "Authenticated" }),
    row("3ds_2", "FAILED", { merchant: KS, card: "MC •• 4444", amount: g(450), outcome: "Customer did not finish" }),
  ] },
  "ZP-STR-020": { demo: [
    row("cm_refund", "ACTIVE", { merchant: NW, name: "Refund rate", formula: "refunds ÷ payments", value: "3.8%" }),
    row("cm_aov", "ACTIVE", { merchant: AB, name: "Average order value", formula: "volume ÷ payments", value: "£42.10" }),
  ] },
  "ZP-STR-021": { extra: "sigma", demo: [
    row("sq_monthly", "SCHEDULED", { merchant: NW, name: "Gross volume by month", schedule: "Monthly", sql: "SELECT month, sum(amount) FROM charges …" }),
    row("sq_failed", "SAVED", { merchant: AB, name: "Customers with failed payments", schedule: "Not scheduled", sql: "SELECT email, count(*) FROM charges …" }),
  ], actions: [on("Schedule daily", "SAVED", "SCHEDULED"), on("Unschedule", "SCHEDULED", "SAVED")] },
  "ZP-STR-022": { demo: [
    row("rev_2026_09", "CLOSED", { merchant: KS, period: "2026-09", recognised: g(18240), deferred: g(2310) }),
    row("rev_2026_10", "CLOSED", { merchant: KS, period: "2026-10", recognised: g(19880), deferred: g(2655) }),
    row("rev_2026_11", "OPEN", { merchant: KS, period: "2026-11", recognised: g(14120), deferred: g(3920) }),
  ], actions: [on("Close period", "OPEN", "CLOSED", { emit: "reporting.period.closed" })] },
  "ZP-STR-023": { demo: [
    row("dp_wh", "ACTIVE", { merchant: NW, name: "Nightly warehouse sync", destination: "Data warehouse", frequency: "Daily" }),
    row("dp_csv", "PAUSED", { merchant: AB, name: "Finance CSV drop", destination: "Cloud storage (CSV)", frequency: "Weekly" }),
  ], actions: [on("Pause", "ACTIVE", "PAUSED"), on("Resume", "PAUSED", "ACTIVE")] },
  "ZP-STR-024": { demo: [
    row("fa_ops", "OPEN", { merchant: NW, nickname: "Operating account", currency: "GBP", balance: g(24500) }),
    row("fa_tax", "OPEN", { merchant: NW, nickname: "Tax reserve", currency: "GBP", balance: g(6800) }),
  ], actions: [on("Approve (demo)", "REQUIRES_APPROVAL", "OPEN")] },
  "ZP-STR-025": { extra: "cards", demo: [
    row("ic_jordan", "ACTIVE", { merchant: NW, cardholder: "Jordan Pike", type: "Virtual", limit: g(2000), last4: "4417" }),
    row("ic_sam", "ACTIVE", { merchant: NW, cardholder: "Sam Okafor", type: "Physical", limit: g(5000), last4: "9021" }),
    row("ic_mkt", "INACTIVE", { merchant: KS, cardholder: "Marketing team", type: "Virtual", limit: g(1000), last4: "1180" }),
  ], actions: [on("Activate", "INACTIVE", "ACTIVE"), on("Freeze", "ACTIVE", "INACTIVE"), { label: "Cancel card", from: ["ACTIVE", "INACTIVE"], to: "CANCELED", danger: true }] },
  "ZP-STR-026": { extra: "capital", demo: [
    row("offer_nw", "OFFERED", { merchant: NW, amount: g(45000), fee: g(4050), expires: ago(-21) }),
  ], actions: [on("Accept offer (demo)", "OFFERED", "ACCEPTED", { emit: "capital.financing_offer.accepted", toast: "Offer accepted (demo). No money moves." })] },
  "ZP-STR-027": { demo: [
    row("fca_nw", "ACTIVE", { merchant: NW, institution: "Northwind Bank", last4: "6789" }),
    row("fca_ab", "ACTIVE", { merchant: AB, institution: "Harbour Bank", last4: "4410" }),
  ], actions: [on("Disconnect", "ACTIVE", "DISCONNECTED", { danger: true })] },
  "ZP-STR-028": { demo: [
    row("vs_1", "VERIFIED", { merchant: NW, type: "Document and selfie", reference: "user_1040" }),
    row("vs_2", "REQUIRES_INPUT", { merchant: AB, type: "Identity document", reference: "user_1041" }),
    row("vs_3", "PROCESSING", { merchant: KS, type: "ID number", reference: "user_1042" }),
  ], actions: [{ label: "Simulate verified", from: ["REQUIRES_INPUT", "PROCESSING"], to: "VERIFIED", emit: "identity.verification_session.verified" }] },
  "ZP-STR-029": { demo: [
    row("prof_nw", "VERIFIED", { merchant: NW, publicName: "Northwind Outfitters", supportEmail: "s••••@northwind.example", website: "https://northwind.example" }),
    row("prof_ab", "UNVERIFIED", { merchant: AB, publicName: "Alder Books", supportEmail: "h••••@alder.example", website: "https://alder.example" }),
  ], actions: [on("Mark verified (demo)", "UNVERIFIED", "VERIFIED")] },
  "ZP-STR-030": { demo: [
    row("clim_nw", "ACTIVE", { merchant: NW, share: "1%" }),
    row("clim_ks", "PAUSED", { merchant: KS, share: "0.5%" }),
  ], actions: [on("Pause", "ACTIVE", "PAUSED"), on("Resume", "PAUSED", "ACTIVE")] },
  "ZP-STR-031": { demo: [
    row("atl_robotics", "DRAFT", { merchant: KS, company: "Kestrel Labs Ltd", jurisdiction: "United Kingdom" }),
  ], actions: [on("File company (demo)", "DRAFT", "FILED", { emit: "atlas.company.filed" })] },
  "ZP-STR-032": { demo: [
    row("evt_demo_a1", "DELIVERED", { merchant: NW, type: "payment_intent.succeeded", resource: "pi_demo_8F2k", delivered: "200 OK" }),
    row("evt_demo_a2", "DELIVERED", { merchant: AB, type: "charge.refunded", resource: "ch_demo_Q7wz", delivered: "200 OK" }),
    row("evt_demo_a3", "FAILED", { merchant: KS, type: "invoice.payment_failed", resource: "in_demo_L0pa", delivered: "500 Server error" }),
    row("evt_demo_a4", "DELIVERED", { merchant: NW, type: "customer.created", resource: "cus_demo_77ab", delivered: "200 OK" }),
  ], actions: [on("Resend", "FAILED", "DELIVERED", { toast: "Event resent: 200 OK (demo)" })] },
  "ZP-STR-033": { demo: [
    row("req_demo_1", "SUCCEEDED", { merchant: NW, method: "POST", path: "/v1/payment_intents", code: "200" }),
    row("req_demo_2", "FAILED", { merchant: NW, method: "POST", path: "/v1/payment_intents", code: "402" }),
    row("req_demo_3", "SUCCEEDED", { merchant: AB, method: "GET", path: "/v1/customers", code: "200" }),
    row("req_demo_4", "FAILED", { merchant: KS, method: "GET", path: "/v1/invoices/in_x", code: "404" }),
  ] },
  "ZP-STR-034": { extra: "keys", demo: [
    row("rk_analytics", "ACTIVE", { name: "Analytics read-only", token: "rk_test_••••7Qm2", lastUsed: ago(1) }),
  ], actions: [on("Revoke", "ACTIVE", "REVOKED", { danger: true, emit: "api_key.revoked" })] },
};
for (const [id, d] of Object.entries(DEMO)) { const m = MODULES[id]; if (m) Object.assign(m, d); }

/** Demo actions on records that come from the server (status changes stay in this browser). */
export const LOCAL_ACTIONS: Record<string, LocalAction[]> = {
  // ZP-COM-002 … 006 actions now run on the console server (TEST fixtures).
  // Payments (ZP-BRW-005) use the payment drawer's own demo buttons.
  "ZP-BRW-005": [
    on("Capture (demo)", "REQUIRES_CAPTURE", "SUCCEEDED", { emit: "payment_intent.succeeded" }),
  ],
};
