/**
 * ConversationList: the sidebar of chat threads.
 *
 * Proves that the presence dot picks the correct tone class, the unread pill
 * shows the right number (capped at 99+), the search field filters by title,
 * and clicking a row invokes onSelect with the conversation id. The list
 * renders from the store snapshot, so the tests prime the store directly
 * rather than mocking selectors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import ConversationList from '../../src/components/NovaLinkLive/ConversationList.jsx';
import * as store from '../../src/services/novalinkLiveStore.js';

const ALICE = 'a'.repeat(8) + '-0000-0000-0000-000000000000';
const BOB = 'b'.repeat(8) + '-0000-0000-0000-000000000000';
const CAROL = 'c'.repeat(8) + '-0000-0000-0000-000000000000';
const CONVA = 'e'.repeat(8) + '-0000-0000-0000-00000000000a';
const CONVB = 'e'.repeat(8) + '-0000-0000-0000-00000000000b';

function prime() {
  store.__reset();
  store.handleFrame({ type: 'ready', user: { id: ALICE, username: 'alice' } });
  store.ingestBootstrap({
    user: { id: ALICE, username: 'alice' },
    conversations: [
      { id: CONVA, participants: [ALICE, BOB], lastBody: 'ping', lastAt: Date.now(), title: 'Bob' },
      { id: CONVB, participants: [ALICE, CAROL], lastBody: '', lastAt: Date.now() - 60_000, title: 'Carol' },
    ],
    contacts: [
      { id: BOB, username: 'bob', displayName: 'Bob', presence: 'online' },
      { id: CAROL, username: 'carol', displayName: 'Carol', presence: 'away' },
    ],
    requests: { incoming: [], outgoing: [] },
  });
}

afterEach(() => {
  cleanup();
  store.__reset();
});

describe('ConversationList', () => {
  it('renders one row per conversation with the peer title', () => {
    prime();
    render(<ConversationList selfId={ALICE} activeId={null} onSelect={vi.fn()} onNewConversation={vi.fn()} />);
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Carol')).toBeInTheDocument();
  });

  it('shows the presence dot using the tone class derived from the store', () => {
    prime();
    const { container } = render(
      <ConversationList selfId={ALICE} activeId={null} onSelect={vi.fn()} onNewConversation={vi.fn()} />,
    );
    const onlineDot = container.querySelector('[data-presence="online"] .novalink-presence-dot');
    const awayDot = container.querySelector('[data-presence="away"] .novalink-presence-dot');
    expect(onlineDot).not.toBeNull();
    expect(onlineDot.className).toMatch(/tone-on/);
    expect(awayDot).not.toBeNull();
    expect(awayDot.className).toMatch(/tone-warn/);
  });

  it('renders the unread pill with the count and clips 100+ to "99+"', () => {
    prime();
    store.handleFrame({ type: 'unread', byConversation: { [CONVA]: 4 }, total: 4 });
    const { rerender } = render(
      <ConversationList selfId={ALICE} activeId={null} onSelect={vi.fn()} onNewConversation={vi.fn()} />,
    );
    expect(screen.getByLabelText('4 unread').textContent).toBe('4');
    store.handleFrame({ type: 'unread', byConversation: { [CONVA]: 150 }, total: 150 });
    rerender(
      <ConversationList selfId={ALICE} activeId={null} onSelect={vi.fn()} onNewConversation={vi.fn()} />,
    );
    expect(screen.getByLabelText('150 unread').textContent).toBe('99+');
  });

  it('filters rows by the search field', () => {
    prime();
    render(<ConversationList selfId={ALICE} activeId={null} onSelect={vi.fn()} onNewConversation={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'carol' } });
    expect(screen.queryByText('Bob')).toBeNull();
    expect(screen.getByText('Carol')).toBeInTheDocument();
  });

  it('clicking a row invokes onSelect with the conversation id', () => {
    prime();
    const onSelect = vi.fn();
    render(<ConversationList selfId={ALICE} activeId={null} onSelect={onSelect} onNewConversation={vi.fn()} />);
    fireEvent.click(screen.getByText('Bob'));
    expect(onSelect).toHaveBeenCalledWith(CONVA);
  });

  it('the + button opens the new-conversation flow', () => {
    prime();
    const onNew = vi.fn();
    render(<ConversationList selfId={ALICE} activeId={null} onSelect={vi.fn()} onNewConversation={onNew} />);
    fireEvent.click(screen.getByLabelText('New conversation'));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('empty state explains what to do', () => {
    store.__reset();
    render(<ConversationList selfId={ALICE} activeId={null} onSelect={vi.fn()} onNewConversation={vi.fn()} />);
    expect(screen.getByText(/No conversations yet/)).toBeInTheDocument();
  });
});
