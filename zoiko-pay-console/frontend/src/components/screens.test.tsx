import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { me, withSession } from "../test/fixtures";
import type { ActionView, RecordView } from "../types/api";
import { ActionDialog } from "./ActionDialogs";
import { FieldDisplay } from "./ScreenView";

afterEach(() => vi.unstubAllGlobals());

const record: RecordView = {
  id: "po_test", status: "REQUIRES_APPROVAL", version: 3, environment: "TEST", isOwnRequest: false, requestedByName: "Jordan Pike",
  fields: {}, updatedAt: new Date().toISOString(), actions: [],
};
const approve: ActionView = { name: "approve", label: "Approve", reasonRequired: false, stepUp: true, source: "04-05 §8", allowed: true };
const reject: ActionView = { name: "reject", label: "Reject", reasonRequired: true, stepUp: false, source: "04-05 §7", allowed: true };
const soon = () => new Date(Date.now() + 4 * 60_000).toISOString();

describe("ActionDialog", () => {
  it("asks for the password first when the action needs step-up", () => {
    render(withSession(<ActionDialog screenId="ZP-BRW-010" record={record} action={approve} onClose={() => undefined} onDone={() => undefined} />, me(["area.payouts"])));
    fireEvent.click(screen.getByRole("button", { name: /Confirm password to continue/ }));
    expect(screen.getByRole("alertdialog", { name: "Confirm your password" })).toBeInTheDocument();
  });

  it("sends the exact version reviewed after confirmation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ...record, status: "READY", version: 4 }, meta: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    render(withSession(<ActionDialog screenId="ZP-BRW-010" record={record} action={approve} onClose={() => undefined} onDone={onDone} />,
      me(["area.payouts"], { stepUpValidUntil: soon() })));
    const btn = screen.getByRole("button", { name: "Approve" });
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(btn);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/screens/ZP-BRW-010/records/po_test/actions/approve");
    expect(JSON.parse(String(init.body))).toEqual({ version: 3 });
  });

  it("requires a reason when the spec demands one", () => {
    render(withSession(<ActionDialog screenId="ZP-BRW-010" record={record} action={reject} onClose={() => undefined} onDone={() => undefined} />, me(["area.payouts"])));
    fireEvent.click(screen.getByRole("checkbox"));
    const btn = screen.getByRole("button", { name: "Reject" });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Beneficiary changed after review" } });
    expect(btn).toBeEnabled();
  });

  it("shows the server's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: 403, code: "SELF_APPROVAL_PROHIBITED", title: "You raised this request",
      detail: "An independent person must decide it." }), { status: 403 })));
    render(withSession(<ActionDialog screenId="ZP-BRW-010" record={record} action={reject} onClose={() => undefined} onDone={() => undefined} />, me(["area.payouts"])));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Not appropriate at this time" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/An independent person must decide it/)).toBeInTheDocument();
  });
});

describe("FieldDisplay", () => {
  it("shows money with its currency and maps as labelled statuses", () => {
    render(<div><FieldDisplay value={{ minor: "123456", currency: "GBP" }} /><FieldDisplay value={{ funds: "PASSED", sanctions: "PENDING" }} /></div>);
    expect(screen.getByText("£1,234.56")).toBeInTheDocument();
    expect(screen.getByText("funds")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("shows an em dash for empty values", () => {
    render(<FieldDisplay value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
