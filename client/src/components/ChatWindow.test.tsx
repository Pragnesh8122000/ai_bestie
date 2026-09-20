// @vitest-environment jsdom
/**
 * Integration coverage for the transcript: unit tests prove MessageContent can
 * format Markdown, these prove ChatWindow actually routes messages through it
 * — including the streaming path and the user/assistant asymmetry.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { compile } from 'tailwindcss';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';

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

const cjsRequire = createRequire(import.meta.url);

// jsdom's CSS engine doesn't implement the Cascade Layers spec, and its
// stylesheet parser aborts on Tailwind's preflight `@supports` nesting, so we
// compile the project's real Tailwind utilities (not a hand-written stand-in)
// and hand jsdom only the flat `@layer utilities { ... }` block it needs.
async function resolveTailwindStylesheet(id: string, base: string) {
  const resolved =
    id.startsWith('.') || id.startsWith('/')
      ? resolvePath(base, id)
      : cjsRequire.resolve(id.endsWith('.css') ? id : `${id}/index.css`);
  return { path: resolved, base: dirname(resolved), content: readFileSync(resolved, 'utf8') };
}

function extractUtilitiesLayer(css: string): string {
  const marker = '@layer utilities';
  const at = css.indexOf(marker);
  if (at === -1) return '';
  const brace = css.indexOf('{', at);
  let depth = 1;
  let j = brace + 1;
  while (depth > 0 && j < css.length) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') depth--;
    j++;
  }
  return css.slice(brace + 1, j - 1);
}

async function computedStyleFor(element: HTMLElement): Promise<CSSStyleDeclaration> {
  // Responsive/state variants (e.g. `sm:px-8`) compile to CSS nesting
  // (`.sm\:px-8 { @media (...) { ... } }`) that jsdom's stylesheet parser
  // can't read, which silently drops the whole injected sheet — irrelevant
  // here since this test only checks the unconditional layout classes.
  const candidates = element.className
    .split(/\s+/)
    .filter(Boolean)
    .filter((className) => !className.includes(':'));
  const { build } = await compile('@import "tailwindcss";', {
    base: process.cwd(),
    loadStylesheet: resolveTailwindStylesheet,
  });
  const style = document.createElement('style');
  style.textContent = extractUtilitiesLayer(build(candidates));
  document.head.appendChild(style);
  return getComputedStyle(element);
}

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

describe('ChatWindow scrollable history', () => {
  // jsdom doesn't lay out flexbox, so this can't assert real scrollHeight —
  // it guards the CSS contract instead: a flex child refuses to shrink below
  // its content's height unless its resolved `min-height` is `0`, which
  // silently defeats `overflow-y: auto` and traps the view on the newest
  // messages. We compile the project's real Tailwind utilities for whatever
  // classes are actually rendered and assert on the resolved style, so this
  // keeps passing across a class-name/mechanism refactor and fails if the
  // real computed layout regresses.
  it('keeps the transcript container able to shrink and scroll independently of its parent', async () => {
    setMessages(
      Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message ${i}`,
      })),
    );
    const { container } = render(<ChatWindow />);

    const root = container.firstElementChild as HTMLElement;
    const rootStyle = await computedStyleFor(root);
    expect(rootStyle.minHeight).toBe('0');
    expect(rootStyle.flexGrow).toBe('1');

    const transcript = screen.getByText('message 0').closest('.overflow-y-auto') as HTMLElement;
    expect(transcript).not.toBeNull();
    const transcriptStyle = await computedStyleFor(transcript);
    expect(transcriptStyle.minHeight).toBe('0');
    expect(transcriptStyle.flexGrow).toBe('1');
    expect(transcriptStyle.overflowY).toBe('auto');
  });

  it('keeps every earlier message mounted (not clipped away) once the conversation scrolls', () => {
    setMessages(
      Array.from({ length: 30 }, (_, i) => ({
        role: 'user' as const,
        content: `message ${i}`,
      })),
    );
    render(<ChatWindow />);

    expect(screen.getByText('message 0')).toBeInTheDocument();
    expect(screen.getByText('message 29')).toBeInTheDocument();
  });
});
