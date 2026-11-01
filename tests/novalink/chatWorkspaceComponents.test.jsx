/**
 * MessageThread / Composer / CodeSnippet — the three components that carry
 * the actual chat payload.
 *
 * MessageThread: renders day dividers, distinguishes own vs. peer bubbles,
 * shows the typing indicator row when the store has a typing entry, and
 * routes messages of kind 'code' through CodeSnippet and file attachments
 * through FileAttachment.
 *
 * Composer: Enter sends, Shift+Enter is a newline, and while the field has
 * content the component pings `client.novalinkLiveSendTyping({typing:true})`
 * at a 1.5 s cadence and stops 2 s after the user pauses.
 *
 * CodeSnippet: copy button hands bytes to `navigator.clipboard.writeText`,
 * language chip renders, and "Open in editor" emits a `novalink:openInEditor`
 * bus event the App shell listens to.
 *
 * All three read the shared store; tests prime it via the store's public
 * ingestion API instead of mocking selectors, so if the reducer drifts these
 * fail too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import MessageThread from '../../src/components/NovaLinkLive/MessageThread.jsx';
import Composer from '../../src/components/NovaLinkLive/Composer.jsx';
import CodeSnippet from '../../src/components/NovaLinkLive/CodeSnippet.jsx';
import * as store from '../../src/services/novalinkLiveStore.js';
import * as bus from '../../src/services/bus.js';
import { mockNova } from '../setup.js';

const ALICE = 'a'.repeat(8) + '-0000-0000-0000-000000000000';
const BOB = 'b'.repeat(8) + '-0000-0000-0000-000000000000';
const CONVA = 'e'.repeat(8) + '-0000-0000-0000-00000000000a';

function msgFixture(overrides = {}) {
  return {
    id: 'm'.repeat(8) + '-0000-0000-0000-000000000001',
    conversationId: CONVA,
    fromUserId: BOB,
    fromName: 'Bob',
    body: 'hi',
    seq: 1,
    kind: 'text',
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  store.__reset();
  store.handleFrame({ type: 'ready', user: { id: ALICE, username: 'alice' } });
  store.ingestBootstrap({
    user: { id: ALICE },
    conversations: [{ id: CONVA, title: 'Bob', participants: [ALICE, BOB] }],
    contacts: [{ id: BOB, displayName: 'Bob' }],
    requests: { incoming: [], outgoing: [] },
  });
  store.setActiveConversation(CONVA);
  mockNova.novalinkLiveSendMessage.mockClear();
  mockNova.novalinkLiveSendTyping.mockClear();
  mockNova.novalinkLiveMarkRead.mockClear();
});

afterEach(() => {
  cleanup();
  store.__reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('MessageThread', () => {
  it('renders a text bubble for kind=text messages', () => {
    store.ingestMessages(CONVA, [msgFixture({ body: 'hello there' })]);
    render(<MessageThread conversationId={CONVA} />);
    expect(screen.getByText('hello there')).toBeInTheDocument();
  });

  it('renders a code block when the message kind is code', () => {
    store.ingestMessages(CONVA, [msgFixture({
      kind: 'code',
      body: 'const x = 1;\nconsole.log(x);',
      metadata: { language: 'javascript', path: 'demo.js' },
    })]);
    render(<MessageThread conversationId={CONVA} />);
    // Monaco is stubbed to a data-testid div carrying the language prop.
    const monaco = screen.getByTestId('monaco-stub');
    expect(monaco).toHaveAttribute('data-language', 'javascript');
    expect(monaco).toHaveAttribute('data-value', 'const x = 1;\nconsole.log(x);');
  });

  it('renders a file chip for messages with attachments', () => {
    store.ingestMessages(CONVA, [msgFixture({
      body: '',
      attachments: [{ id: 'f'.repeat(8) + '-0000-0000-0000-00000000000a', fileName: 'notes.pdf', size: 1234, mimeType: 'application/pdf' }],
    })]);
    render(<MessageThread conversationId={CONVA} />);
    expect(screen.getByText(/notes\.pdf/)).toBeInTheDocument();
  });

  it('groups messages under a day divider when they cross midnight', () => {
    const today = Date.now();
    const yesterday = today - 86_400_000;
    store.ingestMessages(CONVA, [
      msgFixture({ id: 'm1', seq: 1, createdAt: yesterday, body: 'before midnight' }),
      msgFixture({ id: 'm2', seq: 2, createdAt: today, body: 'after midnight' }),
    ]);
    render(<MessageThread conversationId={CONVA} />);
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('shows the typing indicator row while the store marks a peer typing', () => {
    store.handleFrame({ type: 'typing', conversationId: CONVA, fromUserId: BOB, name: 'Bob', typing: true });
    const { container } = render(<MessageThread conversationId={CONVA} />);
    const row = container.querySelector('.novalink-typing');
    expect(row).not.toBeNull();
    expect(row.textContent).toMatch(/Bob/);
    expect(row.textContent).toMatch(/typing/);
  });

  it('aligns self-sent messages with the own-bubble variant', () => {
    store.ingestMessages(CONVA, [msgFixture({ fromUserId: ALICE, fromName: 'Me', body: 'mine' })]);
    const { container } = render(<MessageThread conversationId={CONVA} />);
    expect(container.querySelector('.novalink-bubble.own')).not.toBeNull();
  });
});

describe('Composer', () => {
  it('Enter sends; Shift+Enter is left to the browser and does NOT send', async () => {
    mockNova.novalinkLiveSendMessage.mockResolvedValueOnce({ message: msgFixture({ id: 'sent-1', seq: 10 }) });
    render(<Composer conversationId={CONVA} selfId={ALICE} active />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'first line' } });
    // jsdom does not simulate the browser's native newline insertion for
    // Shift+Enter; what we can prove is that our keydown handler does not
    // treat it as a submit. `novalinkLiveSendMessage` must remain un-called.
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(mockNova.novalinkLiveSendMessage).not.toHaveBeenCalled();
    // Plain Enter with a body fires the send path.
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(mockNova.novalinkLiveSendMessage).toHaveBeenCalled());
    const payload = mockNova.novalinkLiveSendMessage.mock.calls[0][0];
    expect(payload.conversationId).toBe(CONVA);
    expect(payload.body).toBe('first line');
  });

  it('pings sendTyping(true) immediately and stops 2 s after the user pauses', async () => {
    vi.useFakeTimers();
    render(<Composer conversationId={CONVA} selfId={ALICE} active />);
    const ta = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'typing…' } });
    });
    expect(mockNova.novalinkLiveSendTyping).toHaveBeenLastCalledWith({ conversationId: CONVA, typing: true });
    // Advance past the idle timer (2 s) without another change event.
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(mockNova.novalinkLiveSendTyping).toHaveBeenLastCalledWith({ conversationId: CONVA, typing: false });
  });

  it('send button is disabled when the body is empty and no attachments are staged', () => {
    render(<Composer conversationId={CONVA} selfId={ALICE} active />);
    const send = screen.getByRole('button', { name: /send/i });
    expect(send.disabled).toBe(true);
  });

  it('shares the current editor selection as a kind:code message', async () => {
    mockNova.novalinkLiveSendMessage.mockResolvedValue({ message: msgFixture() });
    const getEditorSelection = vi.fn(() => ({
      text: 'function hi() {}',
      language: 'javascript',
      path: 'C:\\w\\src\\hi.js',
    }));
    render(
      <Composer
        conversationId={CONVA}
        selfId={ALICE}
        getEditorSelection={getEditorSelection}
        active
      />,
    );
    const share = screen.getByRole('button', { name: /share code/i });
    fireEvent.click(share);
    await waitFor(() => expect(mockNova.novalinkLiveSendMessage).toHaveBeenCalled());
    expect(getEditorSelection).toHaveBeenCalled();
    const payload = mockNova.novalinkLiveSendMessage.mock.calls[0][0];
    expect(payload.conversationId).toBe(CONVA);
    expect(payload.body).toBe('function hi() {}');
    expect(payload.kind).toBe('code');
    expect(payload.metadata).toMatchObject({ language: 'javascript', path: 'C:\\w\\src\\hi.js' });
  });
});

describe('CodeSnippet', () => {
  it('copy button writes to navigator.clipboard.writeText', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<CodeSnippet code="const x = 1;" language="javascript" path="snippet.js" sender="Bob" />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;'));
  });

  it('renders the language chip', () => {
    render(<CodeSnippet code="print(1)" language="python" path="snippet.py" sender="Bob" />);
    expect(screen.getByText('python')).toBeInTheDocument();
  });

  it('"Open in editor" emits novalink:openInEditor on the bus', () => {
    const emitSpy = vi.spyOn(bus, 'emit').mockImplementation(() => {});
    render(<CodeSnippet code="SELECT 1;" language="sql" path="q.sql" sender="Bob" />);
    fireEvent.click(screen.getByRole('button', { name: /open in editor/i }));
    expect(emitSpy).toHaveBeenCalledWith('novalink:openInEditor', expect.objectContaining({
      name: 'q.sql',
      language: 'sql',
      content: 'SELECT 1;',
    }));
  });
});
