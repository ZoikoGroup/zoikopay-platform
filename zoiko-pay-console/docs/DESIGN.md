# Zoiko Pay Console: research and design direction

## 1. Market research findings

I reviewed the public documentation of five payment-operations products. The
aim was to learn their operating patterns, not to copy their interfaces.

| Product | Pattern observed | What the console takes from it |
|---|---|---|
| Stripe Dashboard | Home page of configurable performance widgets; payments live under a Transactions area with tabs; financial reports are computed on a daily cycle, so very recent activity can lag. | KPI cards with an explicit "as of" time and data source on every figure, so lag is never hidden. |
| Adyen Customer Area | Menu reorganized into Payments (payment list), Risk & disputes (disputes, case management, risk profiles and lists) and account holders; risk scores shown on payment details; recommends separating duties (e.g. the person who initiates payouts cannot edit the bank account). | Risk and payment detail in one evidence drawer; separation of duties enforced server-side, not just advised. |
| Checkout.com | Global search on every page with results grouped as you type; disputes reachable from both a Disputes page and payment details; pages pinnable to the left menu; role-gated pages. | Global search with grouped results (`/` to focus); role-gated navigation. |
| Modern Treasury | Approval rules (conditions + approvers); a "Pending my approval" tab separate from "Pending all"; the platform blocks reviewing a payment you created. | Payout queue with "Awaiting my approval", "All pending" and "Decided" tabs; maker cannot check their own payout. |
| Airwallex | Transfer approval workflows; admins control whether the creator can approve; transfers keep the workflow that was active when submitted; mobile bulk approvals. | Approval binds to the exact payout version reviewed (stale versions are refused). Bulk and mobile approval deliberately **not** adopted: the specs block sensitive approval on phones. |

Sources:
- [Stripe: Web Dashboard basics](https://docs.stripe.com/dashboard/basics), [Stripe: Dashboard update May 2024](https://support.stripe.com/questions/dashboard-update-may-2024)
- [Adyen: new Customer Area menu](https://docs.adyen.com/new-customer-area-menu), [Adyen: manage payments](https://docs.adyen.com/account/manage-payments)
- [Checkout.com: use the Dashboard](https://www.checkout.com/docs/business-operations/use-the-dashboard), [Checkout.com: disputes](https://www.checkout.com/docs/business-operations/use-the-dashboard/disputes)
- [Modern Treasury: approval rules](https://docs.moderntreasury.com/payments/docs/approval-rules-overview), [Modern Treasury: making approvals](https://docs.moderntreasury.com/payments/docs/making-approvals)
- [Airwallex: manage approvals for transfers](https://www.airwallex.com/docs/payouts/transfers/manage-transfers/manage-approvals-for-transfers)

### Where Zoiko Pay differs

None of the five lead with **evidence and governance**. The Zoiko Pay specs
do, and the console follows them:

- **Provenance on every fact.** Each timeline event says whether it is
  provider-confirmed, an internal record or pending evidence (Business
  Requirements §07). A succeeded payment is never presented as bank settlement
  (06-01).
- **Unknown is not failed.** A timed-out provider call stays `PROCESSING` with
  a pending-evidence marker (06-01). It is never shown as a failure.
- **A restricted Super Admin.** The coordination role sees health and counts,
  never transactions or money amounts (03-05 §10.1). Restricted figures render
  as a locked card that states why.

The console has the sign-in page, the Overview dashboard, the 12 §07 areas
(payout approval and audits among them) and three areas outside §07: Access,
Exceptional access and Super Admin. Super Admin has no Overview; they land on
the Super Admin page, which is their default dashboard (03-05 §10.1,
OPEN_QUESTIONS Q24).

## 2. Design direction: "monochrome command centre"

**Intent:** a serious global financial instrument. Quiet, exact and
information-dense. No decoration that does not carry meaning.

**Strict two-colour palette.** Only `#000000` and `#ffffff`. Depth comes from
white at controlled opacity (2.5% to 40%) layered over black. An automated
test (`frontend/src/test/monochrome.test.ts`) fails the build if any other
colour appears in a stylesheet or component. Text opacity never drops below
0.58 (≥ 6:1 contrast on black; WCAG 2.2 AA needs 4.5:1).

**Status without colour.** Five glyphs, always paired with a text label:

| Tone | Glyph | Examples |
|---|---|---|
| Positive | filled circle with check | SUCCEEDED, APPROVED, ACTIVE |
| Attention | filled diamond with "!", bold underlined label | FAILED, OUTCOME_UNKNOWN, DENIED |
| Pending | half-filled circle | PROCESSING, REQUIRES_*, PENDING |
| Ended | hollow circle with dash, dimmed | CANCELED, EXPIRED, REVOKED |
| Neutral | hollow circle | anything else |

Charts use the same idea: a white volume line over translucent count bars;
succeeded is solid white and failed is a diagonal hatch.

**Typography.** Inter Variable for interface text; JetBrains Mono for IDs,
codes and hashes; tabular numerals for every amount and time. Uppercase
eyebrows with wide tracking label sections.

**Signature element.** A dotted world map, at 16% opacity behind the welcome
panel, marking the two legal cells (UK, EU) and the corridor between them. It
is decorative and hidden from assistive technology.

**Layout.** 248 px sidebar (64 px rail when collapsed or on tablet; an
off-canvas drawer on phone), a sticky header, then a scope bar (environment,
merchant, jurisdiction, currency). Content is capped at 1480 px on a 12-column
grid.

**Interaction.** Hover only lightens a surface; selection inverts to white
with black text; focus is a black-then-white double ring. Drawers and dialogs
trap focus and close on Escape. Motion is limited to fades and is disabled
under `prefers-reduced-motion`.

## 3. Spec conflict recorded

The Business Requirements (§07, global shell) specify "Zoiko Pay official
navy/green". The console brief mandates black and white only. The console
follows the brief; see `docs/OPEN_QUESTIONS.md` Q16.
