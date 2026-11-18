import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../services/api";
import { LoginPage, PASSWORD_RULES } from "../pages/LoginPage";
import { KpiCard } from "./KpiCard";
import { StatusBadge, toneOf } from "./StatusBadge";

beforeEach(() => vi.spyOn(api, 'ssoProviders').mockResolvedValue({ data: { providers: [] }, meta: { requestId: 'test', environment: null, source: 'console', asOf: '2026-11-18T00:00:00Z' } }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function problem(status: number, code: string, title: string) {
  return new Response(JSON.stringify({ status, code, title }), { status, headers: { "content-type": "application/problem+json" } });
}

describe("LoginPage", () => {
  it("posts username and password to the console backend, then signs in", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { username: "ops.agent" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onSignedIn = vi.fn();
    render(<LoginPage onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText("Work email or username"), { target: { value: " ops.agent " } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Log In" }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ username: "ops.agent", password: "secret" });
  });

  it("shows a generic error for wrong credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => problem(401, "INVALID_CREDENTIALS", "Invalid username or password")));
    render(<LoginPage onSignedIn={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Work email or username"), { target: { value: "ops.agent" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Log In" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password.");
  });

  it("explains rate limiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => problem(429, "RATE_LIMITED", "Too many requests")));
    render(<LoginPage onSignedIn={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Work email or username"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Log In" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many attempts/);
  });

  it("asks for both fields before calling the server", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage onSignedIn={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Log In" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your username and password.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can show and hide the password", () => {
    render(<LoginPage onSignedIn={() => undefined} />);
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(pw).toHaveAttribute("type", "text");
  });
});

describe("LoginPage: create account and change password", () => {
  it("accepts Zoiko@123 under the password policy and rejects weak ones", () => {
    const ok = (pw: string, u = "ops.agent") => PASSWORD_RULES.every((r) => r.test(pw, u));
    expect(ok("Zoiko@123")).toBe(true);
    expect(ok("zoiko@123")).toBe(false);
    expect(ok("Zoiko123")).toBe(false);
    expect(ok("Ops.agent1!", "ops.agent")).toBe(false);
  });

  it("creates an account and returns to sign-in with a notice", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { username: "new.user" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage onSignedIn={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Register" }));
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "User" } });
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "new.user@example.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "new.user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Zoiko@123" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "Zoiko@123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/Account new.user created/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/auth/register");
    expect(JSON.parse(String(init.body))).toMatchObject({ username: "new.user", password: "Zoiko@123" });
  });

  it("refuses mismatched passwords before calling the server", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage onSignedIn={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Change Password" }));
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ops.agent" } });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "Zoiko@123" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Better#Pass9" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Better#Pass8" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByRole("alert")).toHaveTextContent("do not match");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("KpiCard", () => {
  it("shows a restricted card without any value", () => {
    render(<KpiCard period="7d" kpi={{ key: "volume", label: "Total payment volume", value: null, unit: "minor", previous: null, trend: [],
      restricted: true, restrictedReason: "Money amounts are not part of your role.", definition: "" }} />);
    expect(screen.getByText("Money amounts are not part of your role.")).toBeInTheDocument();
    expect(screen.queryByText(/£/)).toBeNull();
  });

  it("shows value, currency, comparison and data source", () => {
    render(<KpiCard period="7d" asOf={new Date().toISOString()} source="fixture" kpi={{ key: "volume", label: "Total payment volume", value: "1100000", currency: "GBP",
      unit: "minor", previous: "1000000", trend: [1, 2, 3], restricted: false, definition: "Sum of SUCCEEDED payments" }} />);
    expect(screen.getByText("£11,000.00")).toBeInTheDocument();
    expect(screen.getByText("GBP", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("+10.0%")).toBeInTheDocument();
    expect(screen.getByText("Mock data")).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  it("pairs every status with a text label and a shape-based tone", () => {
    render(<StatusBadge status="REQUIRES_CUSTOMER_ACTION" />);
    expect(screen.getByText("Requires customer action")).toBeInTheDocument();
    expect(toneOf("SUCCEEDED")).toBe("positive");
    expect(toneOf("FAILED")).toBe("attention");
    expect(toneOf("PROCESSING")).toBe("pending"); // unknown outcome is not a failure (06-01)
    expect(toneOf("CANCELED")).toBe("ended");
  });
});
