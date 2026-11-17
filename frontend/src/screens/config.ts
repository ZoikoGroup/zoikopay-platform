/**
 * How each screen is laid out: table columns and detail sections, using the
 * field names its Business Requirements wireframe lists (§07). The backend
 * sends the values; this file only decides presentation.
 */
export type Kind = "text" | "mono" | "money" | "status" | "date" | "list" | "map";

export interface Column { key: string; label: string; kind?: Kind }
export interface Section { title: string; fields: Column[] }
export interface ScreenLayout { columns: Column[]; sections: Section[]; recordNoun: string }

const S = (key: string, label: string, kind: Kind = "text"): Column => ({ key, label, kind });

export const LAYOUTS: Record<string, ScreenLayout> = {
  "ZP-BRW-001": {
    recordNoun: "requirement",
    columns: [S("domain", "Domain"), S("tier", "Tier"), S("gate", "Gate", "mono"), S("owner", "Owner"), S("approval", "Approval")],
    sections: [
      { title: "Requirement", fields: [S("domain", "Domain"), S("tier", "Tier"), S("gate", "Gate", "mono"), S("owner", "Owner"), S("useCases", "Use cases", "list")] },
      { title: "Acceptance proof", fields: [S("implementationEvidence", "Implementation evidence"), S("approval", "Approval")] },
    ],
  },
  "ZP-BRW-002": {
    recordNoun: "application",
    columns: [S("merchant", "Merchant entity"), S("country", "Country"), S("progress", "Progress"), S("riskFindings", "Risk findings")],
    sections: [
      { title: "Applicant", fields: [S("merchant", "Business"), S("legalEntity", "Legal entity", "mono"), S("country", "Country"), S("beneficialOwners", "Beneficial owners"),
        S("documents", "Documents"), S("requestedMethods", "Requested rails", "list")] },
      { title: "Reviewer pane", fields: [S("riskFindings", "Risk findings"), S("missingProof", "Missing proof"), S("capabilityNotice", "Note")] },
    ],
  },
  "ZP-BRW-003": {
    recordNoun: "capability",
    columns: [S("merchant", "Merchant"), S("market", "Market"), S("method", "Method"), S("currency", "Currency", "mono"), S("psp", "PSP", "mono"), S("effectiveTo", "Expires", "mono")],
    sections: [
      { title: "Capability tuple", fields: [S("merchant", "Merchant"), S("entity", "Entity", "mono"), S("market", "Market"), S("method", "Method"), S("currency", "Currency", "mono"),
        S("psp", "PSP", "mono"), S("effectiveFrom", "Effective from", "mono"), S("effectiveTo", "Effective to", "mono")] },
      { title: "Authority", fields: [S("authoritySource", "Authority source"), S("contractRef", "Contract", "mono"), S("riskOwner", "Risk owner"), S("reasonCode", "Reason")] },
      { title: "Scoped approvals", fields: [S("approvals", "Approvals", "map")] },
    ],
  },
  "ZP-BRW-006": {
    recordNoun: "policy",
    columns: [S("policy", "Policy", "mono"), S("policyVersion", "Version", "mono"), S("legalCell", "Legal cell", "mono"), S("changeTicket", "Ticket", "mono"), S("author", "Author")],
    sections: [
      { title: "Policy", fields: [S("policy", "Policy", "mono"), S("policyVersion", "Version", "mono"), S("legalCell", "Legal cell", "mono"), S("changeTicket", "Change ticket", "mono"), S("author", "Author")] },
      { title: "Rules", fields: [S("rules", "Rule predicates", "list"), S("providers", "Provider set", "list")] },
      { title: "Simulation and rollout", fields: [S("simulation", "Simulation trace"), S("canaryScope", "Canary scope"), S("rollbackRef", "Rollback reference", "mono")] },
    ],
  },
  "ZP-BRW-007": {
    recordNoun: "connector",
    columns: [S("provider", "Provider"), S("entity", "Entity", "mono"), S("env", "Env", "mono"), S("health", "Health"), S("evidenceExpiry", "Evidence expiry", "mono")],
    sections: [
      { title: "Connector", fields: [S("provider", "Provider"), S("entity", "Entity", "mono"), S("market", "Market"), S("accountFingerprint", "Account", "mono"),
        S("webhookKeyRef", "Webhook key", "mono"), S("contractExpiry", "Contract expiry", "mono")] },
      { title: "Capabilities", fields: [S("features", "Features", "map")] },
      { title: "Certification", fields: [S("certification", "Status"), S("issues", "Issue queue", "list")] },
    ],
  },
  "ZP-BRW-008": {
    recordNoun: "case",
    columns: [S("caseType", "Type"), S("merchant", "Merchant"), S("amount", "Amount", "money"), S("availableToRefund", "Available", "money"), S("deadline", "Deadline", "mono")],
    sections: [
      { title: "Case summary", fields: [S("caseType", "Case type"), S("paymentId", "Payment", "mono"), S("merchant", "Merchant"), S("captured", "Captured", "money"),
        S("refunded", "Refunded", "money"), S("availableToRefund", "Available to refund", "money")] },
      { title: "Request", fields: [S("amount", "Amount", "money"), S("reasonCode", "Reason code", "mono"), S("deadline", "Deadline", "mono"), S("pspStatus", "PSP status")] },
      { title: "Financial panel", fields: [S("ledgerNote", "Ledger")] },
    ],
  },
  "ZP-BRW-009": {
    recordNoun: "statement",
    columns: [S("merchant", "Merchant"), S("statementDate", "Statement", "mono"), S("expectedNet", "Expected net", "money"), S("bankReceived", "Bank received", "money"), S("residual", "Residual", "money")],
    sections: [
      { title: "Statement", fields: [S("entity", "Entity", "mono"), S("account", "Account", "mono"), S("settlementCurrency", "Currency", "mono"), S("statementDate", "Statement date", "mono"),
        S("importedAt", "Imported", "date")] },
      { title: "Four-way position", fields: [S("gross", "PSP gross", "money"), S("deductions", "Deductions", "money"), S("expectedNet", "Expected net", "money"),
        S("bankReceived", "Bank received", "money"), S("residual", "Residual", "money")] },
      { title: "Close", fields: [S("exceptions", "Exceptions", "list"), S("closeThreshold", "Close threshold", "mono"), S("nextRun", "Next scheduled run", "date")] },
    ],
  },
  "ZP-BRW-010": {
    recordNoun: "payout",
    columns: [S("merchant", "Merchant"), S("amount", "Amount", "money"), S("beneficiary", "Beneficiary"), S("approvalStatus", "Approval", "status"), S("approvalDeadline", "Deadline", "date")],
    sections: [
      { title: "Payout", fields: [S("merchant", "Merchant"), S("region", "Region"), S("partner", "Partner", "mono"), S("amount", "Amount", "money"), S("beneficiary", "Beneficiary (masked)")] },
      { title: "Balances", fields: [S("bankConfirmedAvailable", "Bank-confirmed available", "money"), S("reserve", "Reserve", "money"), S("hold", "Hold", "money")] },
      { title: "Gates and finality", fields: [S("gates", "Gates", "map"), S("finality", "Finality tracker", "map"), S("notice", "Notice")] },
    ],
  },
  "ZP-BRW-011": {
    recordNoun: "case",
    columns: [S("priority", "Priority", "mono"), S("reason", "Reason", "mono"), S("merchant", "Merchant"), S("amount", "Amount", "money"), S("age", "Age", "mono")],
    sections: [
      { title: "Case", fields: [S("reason", "Unknown reason", "mono"), S("priority", "Priority", "mono"), S("paymentId", "Payment", "mono"), S("provider", "Provider", "mono"),
        S("merchant", "Merchant"), S("amount", "Amount", "money")] },
      { title: "Controls", fields: [S("blockedNextAction", "Next action lock"), S("inquiryCadence", "Inquiry cadence"), S("disposition", "Disposition")] },
    ],
  },
  "ZP-BRW-012": {
    recordNoun: "regulatory cell",
    columns: [S("legalEntity", "Legal entity"), S("country", "Country"), S("method", "Method"), S("currency", "Currency", "mono"), S("psp", "PSP", "mono")],
    sections: [
      { title: "Scope", fields: [S("legalEntity", "Legal entity"), S("country", "Country"), S("method", "Rail / method"), S("psp", "PSP", "mono"), S("segment", "Merchant segment"),
        S("currency", "Currency", "mono")] },
      { title: "Authority", fields: [S("authoritySource", "Authority source"), S("dataResidency", "Data residency"), S("contractRight", "Contract right")] },
      { title: "Evidence and gaps", fields: [S("evidence", "Evidence cards", "map"), S("gaps", "Gaps", "list"), S("approvals", "Approvals", "map")] },
    ],
  },
  "ZP-BRW-013": {
    recordNoun: "item",
    columns: [S("kind", "Kind"), S("merchant", "Merchant"), S("name", "Name"), S("value", "Value", "mono"), S("expires", "Expires", "mono")],
    sections: [
      { title: "Details", fields: [S("kind", "Kind"), S("merchant", "Merchant"), S("name", "Name"), S("value", "Value", "mono"), S("scopes", "Scopes / events / contents", "list"),
        S("expires", "Expires", "mono"), S("apiVersion", "API version", "mono")] },
    ],
  },
  "ZP-BRW-014": {
    recordNoun: "release",
    columns: [S("candidate", "Candidate", "mono"), S("legalCell", "Legal cell", "mono"), S("cohort", "Cohort"), S("env", "Env", "mono"), S("changeWindow", "Change window", "mono")],
    sections: [
      { title: "Release", fields: [S("candidate", "Candidate", "mono"), S("legalCell", "Legal cell", "mono"), S("cohort", "Merchant cohort"), S("psp", "PSP", "mono"), S("env", "Environment", "mono"),
        S("changeWindow", "Change window", "mono")] },
      { title: "Gate rail", fields: [S("gates", "Gates", "map")] },
      { title: "Decision", fields: [S("blockers", "Blocker lane", "list"), S("evidencePointer", "Evidence pointer", "mono"), S("rollbackPlan", "Rollback plan")] },
    ],
  },
};
