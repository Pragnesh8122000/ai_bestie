// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import MessageContent from './MessageContent';

afterEach(cleanup);

/** Markdown splits text across elements, so match on the container's textContent. */
function text(): string {
  return document.body.textContent || '';
}

describe('MessageContent', () => {
  it('renders bold without leaking the asterisks', () => {
    render(<MessageContent content="that is **really** important" />);
    const strong = document.querySelector('strong');
    expect(strong).toHaveTextContent('really');
    expect(text()).not.toContain('*');
  });

  it('renders italics and strikethrough', () => {
    render(<MessageContent content="_soft_ and ~~gone~~" />);
    expect(document.querySelector('em')).toHaveTextContent('soft');
    expect(document.querySelector('del')).toHaveTextContent('gone');
  });

  it('renders a dash list as a real <ul>', () => {
    render(<MessageContent content={'ideas:\n\n- walk\n- call a friend\n- write'} />);
    const items = document.querySelectorAll('ul li');
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveTextContent('call a friend');
    expect(text()).not.toContain('- walk');
  });

  it('renders a numbered list as a real <ol> and keeps the start index', () => {
    render(<MessageContent content={'1. first\n2. second\n3. third'} />);
    const items = document.querySelectorAll('ol li');
    expect(items).toHaveLength(3);
    expect(items[2]).toHaveTextContent('third');
  });

  it('renders nested lists', () => {
    render(<MessageContent content={'- outer\n    - inner\n- second'} />);
    expect(document.querySelectorAll('ul ul li')).toHaveLength(1);
    expect(document.querySelector('ul ul li')).toHaveTextContent('inner');
  });

  it('renders headings without leaking the hashes', () => {
    render(<MessageContent content={'## The plan\n\nbody text'} />);
    expect(document.querySelector('h2')).toHaveTextContent('The plan');
    expect(text()).not.toContain('#');
  });

  it('keeps paragraphs as separate blocks instead of one blob', () => {
    render(<MessageContent content={'first thought.\n\nsecond thought.'} />);
    expect(document.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders blockquotes', () => {
    render(<MessageContent content="> the one that matters" />);
    expect(document.querySelector('blockquote')).toHaveTextContent('the one that matters');
  });

  it('renders inline code in a chip, not a block', () => {
    render(<MessageContent content="run `npm test` first" />);
    const code = document.querySelector('code');
    expect(code).toHaveTextContent('npm test');
    expect(code?.className).toContain('msg-inline-code');
    expect(document.querySelector('pre')).toBeNull();
  });

  it('renders a fenced block as <pre> with its language label', () => {
    render(<MessageContent content={'```ts\nconst a = 1;\n```'} />);
    const pre = document.querySelector('pre');
    expect(pre).toBeInTheDocument();
    expect(pre).toHaveTextContent('const a = 1;');
    expect(text()).toContain('ts');
    expect(text()).not.toContain('```');
  });

  it('renders a fence with no language as a block too', () => {
    render(<MessageContent content={'```\nplain text\n```'} />);
    expect(document.querySelector('pre')).toHaveTextContent('plain text');
  });

  it('renders a GFM table', () => {
    render(
      <MessageContent content={'| a | b |\n| --- | --- |\n| 1 | 2 |'} />,
    );
    expect(document.querySelectorAll('th')).toHaveLength(2);
    expect(document.querySelectorAll('tbody td')).toHaveLength(2);
    expect(text()).not.toContain('---');
  });

  it('puts a table in a scrollable wrapper so it cannot widen the transcript', () => {
    // Without this, a narrow viewport squeezes columns until words break
    // mid-character ("Payoff" -> "Payof f").
    render(<MessageContent content={'| a | b |\n| --- | --- |\n| 1 | 2 |'} />);
    const wrap = document.querySelector('.msg-table-wrap');
    expect(wrap).toBeInTheDocument();
    expect(wrap?.querySelector('table')).toBeInTheDocument();
  });

  it('opens links safely in a new tab', () => {
    render(<MessageContent content="see [the docs](https://example.com)" />);
    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    // Without noopener the opened page can reach back via window.opener.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('escapes raw HTML instead of executing it', () => {
    render(<MessageContent content={'<script>window.__pwned = 1</script>hi'} />);
    expect(document.querySelector('script')).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
  });

  it('does not render a raw <img onerror> as a live element', () => {
    render(<MessageContent content={'<img src=x onerror="window.__pwned = 1">'} />);
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders trailing children (the streaming caret) after the markdown', () => {
    render(
      <MessageContent content="thinking">
        <span data-testid="caret" />
      </MessageContent>,
    );
    expect(screen.getByTestId('caret')).toBeInTheDocument();
  });

  it('copies a code block to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<MessageContent content={'```\nnpm run dev\n```'} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(writeText).toHaveBeenCalledWith('npm run dev');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument(),
    );
  });

  it('survives a blocked clipboard without throwing', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });

    render(<MessageContent content={'```\nnpm run dev\n```'} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    // Still shows the idle label; no unhandled rejection took the tree down.
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  it('renders plain prose unchanged', () => {
    render(<MessageContent content="hey, how did the interview go?" />);
    expect(text()).toBe('hey, how did the interview go?');
  });
});
