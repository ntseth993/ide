// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Onboarding from '../src/components/Onboarding';

beforeEach(() => {
  cleanup();
});

describe('Onboarding tour', () => {
  it('renders the first step with decorative bubbles and flying code', () => {
    const { container } = render(<Onboarding onDone={vi.fn()} />);
    expect(screen.getByText('Welcome to NovaCode')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 6')).toBeInTheDocument();
    // Decorative layers are present but hidden from assistive tech.
    expect(container.querySelectorAll('.onboarding-bubble').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.onboarding-flycode').length).toBeGreaterThan(0);
    expect(container.querySelector('.onboarding-bubbles')).toHaveAttribute('aria-hidden', 'true');
  });

  it('advances through steps with Next and finishes on the last one', async () => {
    const onDone = vi.fn();
    render(<Onboarding onDone={onDone} />);
    // Click Next through the five non-final steps.
    for (let i = 0; i < 5; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(screen.getByText('Ready when you are')).toBeInTheDocument();
    // The final control becomes "Enter NovaCode".
    const enter = screen.getByRole('button', { name: /Enter NovaCode/i });
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(enter);
    // finish() waits for the exit animation before unmounting.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('can go Back and skip the tour', async () => {
    const onDone = vi.fn();
    render(<Onboarding onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Open a folder to begin')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Welcome to NovaCode')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Skip/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});
