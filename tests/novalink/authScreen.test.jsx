/**
 * AuthScreen: the entry card a signed-out user sees.
 *
 * Three behaviours matter here:
 *   - Sign-in / register dispatch to the correct preload method with the
 *     trimmed username and the typed password.
 *   - The password input is cleared after every submit so the DOM never
 *     keeps the credential between attempts.
 *   - Failures surface as an inline `role="alert"` paragraph, using the
 *     `toUserMessage` normalization rather than a raw stack trace.
 *
 * jsdom renders against the mocked `window.novaApi` from tests/setup.js.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import AuthScreen from '../../src/components/NovaLinkLive/AuthScreen.jsx';
import { mockNova } from '../setup.js';

afterEach(() => {
  cleanup();
  mockNova.novalinkLiveLogin.mockClear();
  mockNova.novalinkLiveRegister.mockClear();
});

const READY = { configured: true, baseUrl: 'https://link.example.test', signedIn: false };

describe('AuthScreen', () => {
  it('signin tab defaults to Sign-in submit and forwards trimmed credentials', async () => {
    mockNova.novalinkLiveLogin.mockResolvedValueOnce({ user: { username: 'ada' } });
    const onSignedIn = vi.fn();
    render(<AuthScreen status={READY} onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByPlaceholderText('alice'), { target: { value: '  ada  ' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'hunter2-hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(mockNova.novalinkLiveLogin).toHaveBeenCalledTimes(1));
    expect(mockNova.novalinkLiveLogin).toHaveBeenCalledWith({ username: 'ada', password: 'hunter2-hunter2' });
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it('register tab shows the display-name field and calls novalinkLiveRegister', async () => {
    mockNova.novalinkLiveRegister.mockResolvedValueOnce({ user: { username: 'newbie' } });
    render(<AuthScreen status={READY} />);
    fireEvent.click(screen.getByRole('tab', { name: /create account/i }));
    fireEvent.change(screen.getByPlaceholderText('alice'), { target: { value: 'newbie' } });
    fireEvent.change(screen.getByPlaceholderText('Alice'), { target: { value: 'New Bie' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'long-enough-pw' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(mockNova.novalinkLiveRegister).toHaveBeenCalledWith({
      username: 'newbie',
      password: 'long-enough-pw',
      displayName: 'New Bie',
    }));
  });

  it('clears the password field after a successful submit', async () => {
    mockNova.novalinkLiveLogin.mockResolvedValueOnce({ user: { username: 'ada' } });
    render(<AuthScreen status={READY} />);
    const pwInput = screen.getByLabelText(/password/i);
    fireEvent.change(screen.getByPlaceholderText('alice'), { target: { value: 'ada' } });
    fireEvent.change(pwInput, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(pwInput.value).toBe(''));
  });

  it('surfaces a rejected login as an inline alert, not a raw error', async () => {
    mockNova.novalinkLiveLogin.mockRejectedValueOnce(new Error('Bad credentials.'));
    render(<AuthScreen status={READY} />);
    fireEvent.change(screen.getByPlaceholderText('alice'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Bad credentials/);
  });

  it('submit stays disabled until username and password are populated', () => {
    render(<AuthScreen status={READY} />);
    const submit = screen.getByRole('button', { name: /sign in/i });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('alice'), { target: { value: 'ada' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw' } });
    expect(submit.disabled).toBe(false);
  });

  it('unconfigured status shows a clear message but keeps fields interactive', async () => {
    render(<AuthScreen status={{ configured: false }} />);
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    // Fields remain editable so the user can explore the form.
    expect(screen.getByPlaceholderText('alice').disabled).toBe(false);
    // Submit is enabled once fields are filled; clicking it surfaces an error
    // rather than silently doing nothing.
    fireEvent.change(screen.getByPlaceholderText('alice'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw' } });
    const submit = screen.getByRole('button', { name: /sign in/i });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not configured/i);
  });
});
