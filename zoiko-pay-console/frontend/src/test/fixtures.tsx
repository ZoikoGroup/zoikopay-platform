import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { SessionProvider } from "../hooks/useSession";
import type { Me, Permission } from "../types/api";

export function me(permissions: Permission[], over: Partial<Me> = {}): Me {
  return {
    sub: "u1", username: "test.user", displayName: "Test User", personas: ["TEST"], permissions,
    environment: "TEST", environments: ["TEST"], hasAccess: true, stepUpValidUntil: null, ...over,
  };
}

export function withSession(ui: ReactNode, m: Me, path = "/") {
  return (
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initial={{ status: "ready", me: m, selection: { merchantId: "", legalEntityId: "", currency: "GBP" } }}>{ui}</SessionProvider>
    </MemoryRouter>
  );
}
