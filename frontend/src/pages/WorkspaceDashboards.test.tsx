import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { me, withSession } from '../test/fixtures';
import { FundsWorkspace, OperationsWorkspace, PaymentsWorkspace, RiskWorkspace } from './WorkspaceDashboards';

const envelope = (data: unknown) => new Response(JSON.stringify({ data, meta: { source: 'fixture', asOf: '2026-11-17T10:00:00Z' } }), { status: 200, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('reference dashboard permissions and evidence', () => {
  it('does not request operating metrics or payment records without their permissions', () => {
    const fetchMock = vi.fn();vi.stubGlobal('fetch', fetchMock);
    render(withSession(<PaymentsWorkspace />, me(['area.payment_operations'])));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Payments – Payment Explorer');
    expect(screen.getAllByText('Not available for your role').length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Review Refunds' })).toBeNull();
  });
  it('sums settlement fields exactly in the selected currency and does not request unauthorized payouts', async () => {
    const fetchMock = vi.fn(async () => envelope({ summary: [], items: [
      { id: 'gbp', status: 'CLOSED', fields: { settlementCurrency: 'GBP', statementDate: '2026-11-17', bankReceived: { minor: '12345', currency: 'GBP' }, expectedNet: { minor: '12445', currency: 'GBP' }, residual: { minor: '100', currency: 'GBP' } }, updatedAt: '2026-11-17T10:00:00Z' },
      { id: 'usd', status: 'CLOSED', fields: { settlementCurrency: 'USD', statementDate: '2026-11-17', bankReceived: { minor: '999999', currency: 'USD' } }, updatedAt: '2026-11-17T10:00:00Z' },
    ] }));vi.stubGlobal('fetch', fetchMock);
    render(withSession(<FundsWorkspace />, me(['area.finance'])));
    expect(await screen.findByText('£123.45')).toBeInTheDocument();
    expect(screen.getByText('£1.00')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(screen.queryByRole('link', { name: 'Review Payouts' })).toBeNull();
  });
  it('adds approved top-ups and subtracts paid transfers from the TEST Available balance', async () => {
    const amount = (minor: string) => ({ minor, currency: 'GBP' });
    const byScreen: Record<string, unknown[]> = {
      'ZP-BRW-009': [{ id: 'b1', status: 'CLOSED', fields: { settlementCurrency: 'GBP', bankReceived: amount('100000'), residual: amount('0') }, updatedAt: '2026-11-17T10:00:00Z' }],
      'ZP-STR-010': [
        { id: 't1', status: 'SUCCEEDED', fields: { amount: amount('25050') }, updatedAt: '2026-11-17T10:00:00Z' },
        { id: 't2', status: 'REQUIRES_APPROVAL', fields: { amount: amount('99999') }, updatedAt: '2026-11-17T10:00:00Z' },
      ],
      'ZP-STR-011': [{ id: 'x1', status: 'PAID', fields: { amount: amount('10000') }, updatedAt: '2026-11-17T10:00:00Z' }],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => envelope({ summary: [], items: byScreen[Object.keys(byScreen).find((id) => String(url).includes(id)) ?? ''] ?? [] })));
    render(withSession(<FundsWorkspace />, me(['area.finance']), '/finance?view=balances'));
    // 1,000.00 bank received + 250.50 approved top-up − 100.00 paid transfer; the unapproved top-up does not count.
    expect((await screen.findAllByText('£1,150.50')).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 money request awaiting approval/)).toBeInTheDocument();
  });
  it('reports unavailable services instead of presenting every provider as healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ intervalSeconds: 15, lastCheck: '2026-11-17T10:00:00Z', database: { status: 'ok' }, services: [
      { name: 'mockpsp', category: 'connector', ok: false, status: 'unreachable', checks: {}, latencyMs: 5, availability: { percent: 80, samples: 5 } },
    ] })));
    render(withSession(<OperationsWorkspace />, me(['health.view'])));
    expect((await screen.findAllByText('Unavailable')).length).toBeGreaterThan(0);
    expect(screen.queryByText('All monitored services are currently responding.')).toBeNull();
  });
  it('does not fetch KYB records without merchant permission and labels the unavailable monitoring feed', async () => {
    const fetchMock = vi.fn(async () => envelope({ summary: [], items: [], total: 0, statuses: [], screen: { id: 'ZP-BRW-012', title: 'Controls' } }));vi.stubGlobal('fetch', fetchMock);
    render(withSession(<RiskWorkspace />, me(['area.risk_compliance'])));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('tab', { name: 'Transaction Monitoring' }));
    expect(screen.getByText(/A transaction-monitoring feed is not configured/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
