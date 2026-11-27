/**
 * Screen registry. Titles, personas, release tier and intent are quoted from
 * the Business Requirements (01-05) section 07, screens ZP-BRW-001 … 014.
 * Persona codes are the BR's own; see OPEN_QUESTIONS Q12 for the mapping to
 * the 02-02 codes the backend enforces.
 */
import { MODULES, SERVER_MODULES } from "../screens/parity";

export interface ScreenSpec {
  id: string;
  title: string;
  personas: string;
  tier: string;
  intent: string;
}

export const SCREENS: Record<string, ScreenSpec> = {
  "ZP-BRW-001": { id: "ZP-BRW-001", title: "Business Requirement & Use-Case Control Center", personas: "PAY-PROD, QA, CTO, AUD-RO", tier: "Internal / foundation",
    intent: "Trace every requirement → business outcome → wireframe → API → test → gate; distinguish design evidence from implementation." },
  "ZP-BRW-002": { id: "ZP-BRW-002", title: "Merchant Application & KYB Review", personas: "MER-OWNER, PAY-COMP, PAY-RISK", tier: "Merchant + internal / P0",
    intent: "Collect merchant information and turn it into a reviewable, scoped decision, never directly into payment execution." },
  "ZP-BRW-003": { id: "ZP-BRW-003", title: "Merchant Capabilities & Legal Cell Activation", personas: "PAY-COMP, PAY-OPS, MER-OWNER", tier: "Internal approval / P0",
    intent: "Expose exact allowed jurisdiction/rail/method/currency/PSP scopes and expiration, including a visible default OFF." },
  "ZP-BRW-004": { id: "ZP-BRW-004", title: "Payment Intent & Checkout Integration", personas: "MER-DEV, MER-OPS", tier: "Merchant / P0",
    intent: "Create an auditable payment intent, expose allowed method, consent and customer action without introducing card-data scope." },
  "ZP-BRW-005": { id: "ZP-BRW-005", title: "Payment Explorer & Evidence Timeline", personas: "MER-OPS, PAY-OPS, MER-FIN", tier: "Merchant + internal / P0",
    intent: "Inspect separate intent, attempt, authorization, capture, provider settlement, bank and ledger states with confidence and evidence." },
  "ZP-BRW-006": { id: "ZP-BRW-006", title: "Routing Policy Studio & Simulation", personas: "PAY-PROD, PAY-OPS, PAY-COMP", tier: "Internal / P1",
    intent: "Draft deterministic routing policies, simulate eligible paths and enforce approval before activation." },
  "ZP-BRW-007": { id: "ZP-BRW-007", title: "Provider Capability & Connector Console", personas: "PAY-OPS, PAY-SEC, PAY-COMP", tier: "Internal / P0",
    intent: "Register partner contracts and the exact operations supported by each credential, version and environment." },
  "ZP-BRW-008": { id: "ZP-BRW-008", title: "Refunds, Voids & Dispute Operations", personas: "MER-OPS, PAY-OPS, MER-FIN", tier: "Merchant + internal / P0/P1",
    intent: "Manage an evidence-linked money-return operation without conflating pre-capture void, refund and dispute chargeback." },
  "ZP-BRW-009": { id: "ZP-BRW-009", title: "Settlement & Four-Way Reconciliation", personas: "PAY-FIN, MER-FIN, AUD-RO", tier: "Finance / P0",
    intent: "Show independent PSP gross, PSP balance, bank cash and Pay subledger positions with CoreX posting/control status." },
  "ZP-BRW-010": { id: "ZP-BRW-010", title: "Payout Eligibility & Approval Queue", personas: "MER-FIN, PAY-FIN, PAY-COMP", tier: "Conditional / C",
    intent: "Control merchant disbursements only when contracted payout rights, confirmed funds and approved beneficiary are present." },
  "ZP-BRW-011": { id: "ZP-BRW-011", title: "Unknown Outcome & Break Investigation Center", personas: "PAY-OPS, PAY-FIN, PAY-RISK", tier: "Internal / P0",
    intent: "Resolve ambiguous outcomes and money breaks with evidence without manufacturing a “success” state." },
  "ZP-BRW-012": { id: "ZP-BRW-012", title: "Compliance & Market Enablement Workbench", personas: "PAY-COMP, PAY-RISK, PAY-SEC", tier: "Internal / P0",
    intent: "Operate the signed legal-entity, jurisdiction, merchant, PSP, payment method and currency entitlement graph." },
  "ZP-BRW-013": { id: "ZP-BRW-013", title: "Merchant Developer Hub & Reporting", personas: "MER-DEV, MER-FIN, MER-OWNER", tier: "Merchant / P0/P1",
    intent: "Provide API references, scoped key lifecycle, signed webhook tests and reconciled evidence-grade reporting." },
  "ZP-BRW-014": { id: "ZP-BRW-014", title: "Acceptance & Release Gate Control Room", personas: "PAY-QA, CTO, PAY-COMP, PAY-FIN", tier: "Internal / P0",
    intent: "Tie every BR, UC, UI contract, fraud/regulatory decision, provider certification and financial oracle to G0–G7." },
  // Stripe-parity screens (not in Business Requirements §07). Read-only TEST fixtures.
  "ZP-COM-001": { id: "ZP-COM-001", title: "Customers", personas: "MER-OPS, PAY-OPS, MER-FIN, MER-DEV", tier: "Stripe parity / TEST",
    intent: "See who pays each merchant: masked contact, country, number of payments and total spent." },
  "ZP-COM-002": { id: "ZP-COM-002", title: "Product Catalogue", personas: "MER-OPS, PAY-OPS, MER-FIN, MER-DEV", tier: "Stripe parity / TEST",
    intent: "List what each merchant sells, with price, one-off or recurring billing, and tax code." },
  "ZP-COM-003": { id: "ZP-COM-003", title: "Payment Links", personas: "MER-OPS, PAY-OPS, MER-FIN, MER-DEV", tier: "Stripe parity / TEST",
    intent: "Shareable links that take a payment without a website, with payments taken and amount collected." },
  "ZP-COM-004": { id: "ZP-COM-004", title: "Subscriptions", personas: "MER-OPS, PAY-OPS, MER-FIN, MER-DEV", tier: "Stripe parity / TEST",
    intent: "Recurring payments: customer, plan, interval, next billing date and state (active, trialing, past due, canceled)." },
  "ZP-COM-005": { id: "ZP-COM-005", title: "Invoices", personas: "MER-OPS, PAY-OPS, MER-FIN, MER-DEV", tier: "Stripe parity / TEST",
    intent: "Invoices sent to customers: amount due, amount paid, due date and state (draft, open, paid, void, uncollectible)." },
  "ZP-COM-006": { id: "ZP-COM-006", title: "Tax Rates", personas: "MER-FIN, PAY-OPS", tier: "Stripe parity / TEST",
    intent: "Tax rates per jurisdiction applied to products and invoices. Fixture table, not tax advice." },
  // Stripe areas with no backend API yet (frontend preview; local drafts only). See screens/parity.ts.
  ...Object.fromEntries(Object.values(MODULES).map((m) => [m.id, SERVER_MODULES.has(m.id)
    ? { id: m.id, title: m.title, personas: "PFIN, MFIN, PRECON", tier: "Stripe parity / TEST fixtures", intent: m.intent }
    : { id: m.id, title: m.title, personas: "Frontend preview", tier: "Stripe parity / not connected", intent: m.intent }])),
};
