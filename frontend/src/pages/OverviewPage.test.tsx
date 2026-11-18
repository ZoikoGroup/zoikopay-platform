import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { me, withSession } from '../test/fixtures';
import { OverviewPage } from './OverviewPage';

const envelope = (data: unknown) => new Response(JSON.stringify({ data, meta: { source: 'fixture', asOf: '2026-11-18T00:00:00Z' } }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());
function fixture(path: string) {
  if (path.includes('/overview/kpis')) return { kpis: [{ key: 'volume', label: 'Volume', value: '10000', previous: '9000', currency: 'GBP', unit: 'minor', restricted: false }, { key: 'success_rate', value: '75', unit: 'percent', restricted: false }] };
  if (path.includes('/overview/activity')) return { currency: 'GBP', amountsVisible: true, buckets: [{ start: '2026-11-17T00:00:00Z', count: 4, succeeded: 3, failed: 1, volumeMinor: '10000' }] };
  if (path.includes('/screens/ZP-BRW-009')) return { items: [{ id: 'rec_gbp', status: 'CLOSED', fields: { bankReceived: { minor: '12345', currency: 'GBP' } } }, { id: 'rec_usd', status: 'CLOSED', fields: { bankReceived: { minor: '999999', currency: 'USD' } } }] };
  if (path.includes('/payments')) return { items: [], total: 0 };
  return [];
}

describe('Command Center dashboard', () => {
  it('does not request health, financial statements or payment records outside the role', async () => {
    const fetchMock = vi.fn(async (url: string) => envelope(fixture(url)));vi.stubGlobal('fetch', fetchMock);
    render(withSession(<OverviewPage />, me(['overview.view'])));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Global Payment Operations Command Center');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes('/payments') || url.includes('/screens/') || url.includes('/system/health'))).toBe(false);
    expect(screen.getByText('Balance source is not connected')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create a Payment' })).toBeNull();
  });
  it('keeps currency books separate and derives transaction counts from the selected period', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => envelope(fixture(url))));
    render(withSession(<OverviewPage />, me(['overview.view', 'metrics.counts.view', 'metrics.amounts.view', 'area.finance'])));
    expect(await screen.findByText('£123.45')).toBeInTheDocument();
    expect(screen.queryByText('$9,999.99')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Total Transactions' }).parentElement).toHaveTextContent('4');
    fireEvent.click(screen.getByRole('button', { name: 'Success Rate' }));
    expect(screen.getByRole('img', { name: /Success rate, last 30 days/ })).toBeInTheDocument();
    expect(screen.getByText('Dispute metrics are not connected')).toBeInTheDocument();
  });
});
