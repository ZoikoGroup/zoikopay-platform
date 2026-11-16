import type {
  AuditResponse, Notification, RecordView, SandboxIntent, ScreenList, SearchHit,
  ActivityResponse, Environment, KpiResponse, Me, Page, Payment, PaymentDetail, Period, RecentActivityItem, ScopeOptions,
  SystemHealth, PlatformSummary, XaList, XaGrant, XaOptions, XaPayment, AccessMembers, AccessMember, AccessOptions, AccessRequestBody,
} from "../types/api";
import { http, qs, request } from "./http";

const V1 = "/api/v1";

export interface OverviewParams {
  period: Period;
  currency: string;
  merchantId?: string;
}

export interface PaymentQuery {
  q?: string;
  status?: string[];
  merchantId?: string;
  legalEntityId?: string;
  currency?: string;
  from?: string;
  to?: string;
  sort?: "createdAt" | "amount";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

/** Typed client for every console backend endpoint. */
export const api = {
  login: (username: string, password: string) => http.post<{ username: string }>("/auth/login", { username, password }),
  logout: () => http.post<{ signedOut: boolean }>("/auth/logout"),
  register: (b: { username: string; firstName: string; lastName: string; email: string; password: string }) =>
    http.post<{ username: string }>("/auth/register", b),
  changePassword: (b: { username: string; currentPassword: string; newPassword: string }) =>
    http.post<{ changed: boolean }>("/auth/change-password", b),

  me: (s?: AbortSignal) => http.get<Me>(`${V1}/me`, s),
  scope: (s?: AbortSignal) => http.get<ScopeOptions>(`${V1}/scope`, s),
  setEnvironment: (environment: Environment) => http.put<{ environment: Environment }>(`${V1}/session/environment`, { environment }),

  kpis: (p: OverviewParams, s?: AbortSignal) => http.get<KpiResponse>(`${V1}/overview/kpis${qs({ ...p })}`, s),
  activity: (p: OverviewParams, s?: AbortSignal) => http.get<ActivityResponse>(`${V1}/overview/activity${qs({ ...p })}`, s),
  recentActivity: (s?: AbortSignal) => http.get<RecentActivityItem[]>(`${V1}/overview/recent-activity`, s),

  payments: (q: PaymentQuery, s?: AbortSignal) => http.get<Page<Payment>>(`${V1}/payments${qs({ ...q })}`, s),
  payment: (id: string, s?: AbortSignal) => http.get<PaymentDetail>(`${V1}/payments/${encodeURIComponent(id)}`, s),

  systemHealth: (s?: AbortSignal) => http.get<SystemHealth>(`${V1}/system/health`, s),
  platformSummary: (s?: AbortSignal) => http.get<PlatformSummary>(`${V1}/platform/summary`, s),

  xaList: (q: { status?: string }, s?: AbortSignal) => http.get<XaList>(`${V1}/exceptional-access${qs(q)}`, s),
  xaGet: (id: string, s?: AbortSignal) => http.get<XaGrant>(`${V1}/exceptional-access/${encodeURIComponent(id)}`, s),
  xaOptions: (s?: AbortSignal) => http.get<XaOptions>(`${V1}/exceptional-access/options`, s),
  xaRequest: (body: { kind: string; ticketId: string; consentRef?: string; purpose: string; merchantIds: string[]; unmasked: string[]; durationMinutes: number }) =>
    http.post<XaGrant>(`${V1}/exceptional-access`, body),
  xaAction: (id: string, action: string, body: { version: number; reason?: string; outcome?: string }) =>
    http.post<XaGrant>(`${V1}/exceptional-access/${encodeURIComponent(id)}/actions/${action}`, body),
  xaPayments: (id: string, q: { q?: string }, s?: AbortSignal) =>
    http.get<{ grant: { id: string; ticketId: string; expiresAt: string; unmasked: string[] }; items: XaPayment[] }>(`${V1}/exceptional-access/${encodeURIComponent(id)}/payments${qs(q)}`, s),
  xaPayment: (id: string, paymentId: string, s?: AbortSignal) =>
    http.get<XaPayment>(`${V1}/exceptional-access/${encodeURIComponent(id)}/payments/${encodeURIComponent(paymentId)}`, s),

  accessMembers: (q: { status?: string; q?: string }, s?: AbortSignal) => http.get<AccessMembers>(`${V1}/access/members${qs(q)}`, s),
  accessMember: (sub: string, s?: AbortSignal) => http.get<AccessMember>(`${V1}/access/members/${encodeURIComponent(sub)}`, s),
  accessOptions: (s?: AbortSignal) => http.get<AccessOptions>(`${V1}/access/options`, s),
  accessRequest: (body: AccessRequestBody) => http.post<AccessMember>(`${V1}/access/requests`, body),
  accessAction: (grantId: string, action: string, body: { version: number; reason?: string; expiresAt?: string }) =>
    http.post<AccessMember>(`${V1}/access/grants/${encodeURIComponent(grantId)}/actions/${action}`, body),

  reauth: (password: string) => http.post<{ stepUpValidUntil: string }>("/auth/reauth", { password }),

  screen: (id: string, q: { status?: string; q?: string }, s?: AbortSignal) => http.get<ScreenList>(`${V1}/screens/${id}${qs(q)}`, s),
  record: (id: string, recordId: string, s?: AbortSignal) => http.get<RecordView>(`${V1}/screens/${id}/records/${encodeURIComponent(recordId)}`, s),
  act: (id: string, recordId: string, action: string, body: { version: number; reason?: string }) =>
    http.post<RecordView>(`${V1}/screens/${id}/records/${encodeURIComponent(recordId)}/actions/${action}`, body),

  sandboxIntent: (idempotencyKey: string, body: { merchantId: string; amount_minor: string; currency: string; capture_mode: string; order_ref: string }) =>
    request<SandboxIntent>("POST", `${V1}/sandbox/payment-intents`, body, undefined, { "Idempotency-Key": idempotencyKey }),

  search: (q: string, s?: AbortSignal) => http.get<SearchHit[]>(`${V1}/search${qs({ q })}`, s),
  notifications: (s?: AbortSignal) => http.get<Notification[]>(`${V1}/notifications`, s),
  markNotificationRead: (id: string) => http.post<{ id: string }>(`${V1}/notifications/${encodeURIComponent(id)}/read`),
  audit: (q: { action?: string; outcome?: string; limit?: number }, s?: AbortSignal) => http.get<AuditResponse>(`${V1}/audit${qs(q)}`, s),
};
