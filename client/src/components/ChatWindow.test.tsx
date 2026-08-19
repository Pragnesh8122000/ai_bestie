// @vitest-environment jsdom
/**
 * Integration coverage for the transcript: unit tests prove MessageContent can
 * format Markdown, these prove ChatWindow actually routes messages through it
 * — including the streaming path and the user/assistant asymmetry.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../utils/speech', () => ({
  speakChunk: vi.fn(),
  beginSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsStateListener: vi.fn(),
  listenOnce: vi.fn(),
  isSTTSupported: () => false,
}));

import ChatWindow from './ChatWindow';
import { useChatStore } from '../stores/chatStore';
import { usePersonaStore } from '../stores/personaStore';

Element.prototype.scrollIntoView = vi.fn();

function setMessages(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  useChatStore.setState({
    activeConversation: {
      id: 'a',
      title: 'T',
      personaId: 'p1',
      avatarId: 'a',
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      messages: messages.map((m, i) => ({
        ...m,
        _id: String(i),
        timestamp: new Date().toISOString(),
      })),
    } as any,
    activeConversationId: 'a',
    isStreaming: false,
    streamingContent: '',
    avatarState: 'idle',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  usePersonaStore.setState({
    personas: [{ id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'a' } as any],
    activePersonaId: 'p1',
  });
  setMessages([]);
});

afterEach(cleanup);

describe('ChatWindow markdown rendering', () => {
  it('formats an assistant reply instead of printing the syntax', () => {
    setMessages([
      { role: 'assistant', content: 'try this:\n\n- walk\n- **call** a friend' },
    ]);
    render(<ChatWindow />);

    expect(document.querySelectorAll('ul li')).toHaveLength(2);
    expect(document.querySelector('strong')).toHaveTextContent('call');
    // The regression this whole change exists to prevent.
    expect(document.body.textContent).not.toContain('**');
    expect(document.body.textContent).not.toContain('- walk');
  });

  it('leaves a user message as literal text', () => {
    // A user typing `*` means an asterisk, not emphasis. Rendering it as
    // markdown would silently rewrite what they said.
    setMessages([{ role: 'user', content: 'is 2 * 3 * 4 right?' }]);
    render(<ChatWindow />);

    expect(screen.getByText('is 2 * 3 * 4 right?')).toBeInTheDocument();
    expect(document.querySelector('em')).toBeNull();
  });

  it('preserves newlines a user typed', () => {
    setMessages([{ role: 'user', content: 'line one\nline two' }]);
    const { container } = render(<ChatWindow />);

    const p = Array.from(container.querySelectorAll('p')).find((el) =>
      el.textContent?.includes('line one'),
    );
    expect(p?.className).toContain('whitespace-pre-wrap');
  });

  it('formats the live streaming turn', () => {
    setMessages([]);
    act(() => {
      useChatStore.setState({
        isStreaming: true,
        streamingContent: 'here:\n\n1. one\n2. two',
      });
    });
    render(<ChatWindow />);

    expect(document.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('does not flash a raw delimiter mid-stream', () => {
    setMessages([]);
    act(() => {
      useChatStore.setState({ isStreaming: true, streamingContent: 'that is **rea' });
    });
    render(<ChatWindow />);

    expect(document.body.textContent).toContain('that is rea');
    expect(document.body.textContent).not.toContain('**');
  });

  it('shows the typing dots before any content arrives', () => {
    setMessages([]);
    act(() => {
      useChatStore.setState({ isStreaming: true, streamingContent: '' });
    });
    render(<ChatWindow />);

    expect(screen.getByLabelText('typing')).toBeInTheDocument();
  });

  it('keeps the caret visible while streaming', () => {
    setMessages([]);
    act(() => {
      useChatStore.setState({ isStreaming: true, streamingContent: 'hi there' });
    });
    const { container } = render(<ChatWindow />);

    expect(container.querySelector('.stream-caret')).toBeInTheDocument();
  });

  it('renders a code block in a reply', () => {
    setMessages([{ role: 'assistant', content: 'like so:\n\n```js\nconst a = 1;\n```' }]);
    render(<ChatWindow />);

    expect(document.querySelector('pre')).toHaveTextContent('const a = 1;');
    expect(document.body.textContent).not.toContain('```');
  });
});
