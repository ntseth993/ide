// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiffReview from '../src/components/DiffReview';

const review = (original, modified, extra = {}) => ({
  path: '/w/app.js',
  name: 'app.js',
  language: 'javascript',
  original,
  modified,
  expectedOriginal: original,
  ...extra,
});

describe('DiffReview', () => {
  it('renders nothing without a proposal', () => {
    const { container } = render(<DiffReview review={null} onAccept={vi.fn()} onReject={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows honest add/remove/change counts', () => {
    // line1 a->A, line5 e->E => 2 added, 2 removed, 2 changes.
    render(<DiffReview review={review('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')} onAccept={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText('+2 lines added')).toBeInTheDocument();
    expect(screen.getByText('-2 lines removed')).toBeInTheDocument();
    expect(screen.getByText('2 changes proposed')).toBeInTheDocument();
  });

  it('accepts the focused change alone and keeps the review open', async () => {
    const onAccept = vi.fn();
    render(<DiffReview review={review('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')} onAccept={onAccept} onReject={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^Accept$/ }));
    // Only the first change ("a" -> "A") is merged onto the base; not finalized.
    expect(onAccept).toHaveBeenCalledWith('A\nb\nc\nd\ne', { finalize: false });
  });

  it('accepts every change at once and finalizes', async () => {
    const onAccept = vi.fn();
    render(<DiffReview review={review('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')} onAccept={onAccept} onReject={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept All' }));
    expect(onAccept).toHaveBeenCalledWith('A\nb\nc\nd\nE', { finalize: true });
  });

  it('skips a rejected change when accepting the rest', async () => {
    const onAccept = vi.fn();
    render(<DiffReview review={review('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')} onAccept={onAccept} onReject={vi.fn()} />);
    // Reject the focused change, then Accept All the remainder.
    await userEvent.click(screen.getByRole('button', { name: /^Reject$/ }));
    expect(screen.getByText(/1 rejected/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept All' }));
    // Only the second change ("e" -> "E") survives; the first stays original.
    expect(onAccept).toHaveBeenCalledWith('a\nb\nc\nd\nE', { finalize: true });
  });

  it('rejects all without writing anything', async () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(<DiffReview review={review('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')} onAccept={onAccept} onReject={onReject} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(onReject).toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('navigates between independent changes', async () => {
    render(<DiffReview review={review('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')} onAccept={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText('Change 1 of 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next change' }));
    expect(screen.getByText('Change 2 of 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous change' }));
    expect(screen.getByText('Change 1 of 2')).toBeInTheDocument();
  });

  it('renders the unified diff through the Monaco diff editor', () => {
    render(<DiffReview review={review('a\nb', 'a\nc')} onAccept={vi.fn()} onReject={vi.fn()} />);
    const diff = screen.getByTestId('monaco-diff-stub');
    expect(diff).toHaveAttribute('data-original', 'a\nb');
    expect(diff).toHaveAttribute('data-modified', 'a\nc');
  });
});
