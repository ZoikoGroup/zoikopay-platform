import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../services/api';
import { SignInOptions } from './SignInOptions';

const meta = { requestId: 'test', environment: null, source: 'console' as const, asOf: '2026-11-18T00:00:00Z' };
afterEach(() => { vi.restoreAllMocks();window.history.replaceState({}, '', '/'); });

describe('provider sign-in options', () => {
  it('renders all four branded options and enables only connected providers', async () => {
    vi.spyOn(api, 'ssoProviders').mockResolvedValue({ meta, data: { providers: [{ id: 'company', enabled: true }, { id: 'google', enabled: false }, { id: 'microsoft', enabled: false }, { id: 'apple', enabled: false }] } });
    render(<SignInOptions />);
    const company = await screen.findByRole('button', { name: 'Company SSO' });
    await vi.waitFor(() => expect(company).toBeEnabled());
    expect(company.closest('form')).toHaveAttribute('method', 'post');
    expect(company.closest('form')).toHaveAttribute('action', '/auth/sso/company');
    for (const name of ['Google', 'Microsoft', 'Apple']) expect(screen.getByRole('button', { name: new RegExp('Continue with ' + name) })).toBeDisabled();
    expect(document.querySelectorAll('.auth-provider-icon svg')).toHaveLength(4);
  });
  it('does not submit disconnected providers', async () => {
    vi.spyOn(api, 'ssoProviders').mockResolvedValue({ meta, data: { providers: [] } });
    render(<SignInOptions />);
    const button = await screen.findByRole('button', { name: /Continue with Google/ });
    const form = button.closest('form');expect(form).not.toBeNull();
    expect(fireEvent.submit(form as HTMLFormElement)).toBe(false);
  });
  it('fails closed when provider availability cannot be fetched', async () => {
    vi.spyOn(api, 'ssoProviders').mockRejectedValue(new Error('Unavailable'));
    render(<SignInOptions />);
    expect(await screen.findByRole('status')).toHaveTextContent(/temporarily unavailable/);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
  it('shows only recognized callback errors as text', () => {
    vi.spyOn(api, 'ssoProviders').mockResolvedValue({ meta, data: { providers: [] } });
    window.history.replaceState({}, '', '/?auth_error=SSO_SESSION_EXPIRED');
    render(<SignInOptions />);
    expect(screen.getByRole('alert')).toHaveTextContent(/expired or could not be verified/);
  });
});
