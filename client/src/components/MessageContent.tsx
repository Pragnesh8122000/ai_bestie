/**
 * Renders an assistant message as formatted Markdown.
 *
 * Why this exists: the model replies in Markdown ("**bold**", "- item",
 * "1. step", fenced code). Before this component the transcript printed that
 * source text verbatim, so users saw literal asterisks and every list
 * collapsed into one paragraph (HTML folds newlines).
 *
 * Safety: `react-markdown` escapes raw HTML by default and we deliberately do
 * NOT add `rehype-raw`. A reply containing `<script>` renders as visible text
 * rather than executing, so a prompt-injected model cannot inject DOM.
 *
 * Styling: every element is mapped explicitly onto the app's ink/linen/ember
 * tokens instead of pulling in @tailwindcss/typography, whose defaults assume
 * a light document and would have to be overridden element by element anyway.
 *
 * Perf: memoized on `content`. A long transcript re-renders on every streamed
 * token, and re-parsing 40 settled messages each time is wasted work.
 */
import { memo, useCallback, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Pull the raw source text out of a hast node (used for fenced code). */
function nodeText(node: unknown): string {
  const n = node as { value?: string; children?: unknown[] } | undefined;
  if (!n) return '';
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) return n.children.map(nodeText).join('');
  return '';
}

/** Read the language hint off a fenced block's inner <code class="language-ts">. */
function nodeLang(node: unknown): string {
  const n = node as
    | { children?: Array<{ properties?: { className?: unknown } }> }
    | undefined;
  const className = n?.children?.[0]?.properties?.className;
  const list = Array.isArray(className) ? className : [];
  for (const c of list) {
    if (typeof c === 'string' && c.startsWith('language-')) return c.slice(9);
  }
  return '';
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    // `navigator.clipboard` is absent over plain HTTP and in jsdom; failing to
    // copy must never take the transcript down with it.
    const write = navigator?.clipboard?.writeText?.(code);
    Promise.resolve(write)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* clipboard blocked — leave the button idle */
      });
  }, [code]);

  return (
    <div className="msg-code group relative">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        className="absolute right-2 top-2 rounded-md border border-line/60 bg-ink/80 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-linen-dim opacity-0 transition-opacity hover:text-ember focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? 'copied' : 'copy'}
      </button>
      {lang && (
        <span className="msg-code-lang font-mono text-[10px] uppercase tracking-[0.12em] text-linen-dim/60">
          {lang}
        </span>
      )}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  // Fenced code. Rendered from the source node rather than from `children` so
  // a fence with no language (```\n...\n```) is still treated as a block —
  // the common `className.includes('language-')` check misses that case.
  // The trailing newline before the closing fence is markdown syntax, not
  // content: pasting it would add a stray blank line to the user's clipboard.
  pre: ({ node }) => (
    <CodeBlock code={nodeText(node).replace(/\n$/, '')} lang={nodeLang(node)} />
  ),

  // Only inline code reaches this: `pre` above ignores its rendered children.
  code: ({ children }) => <code className="msg-inline-code">{children}</code>,

  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="msg-link">
      {children}
    </a>
  ),

  // Tables can exceed a chat column; the wrapper scrolls instead of forcing
  // the whole transcript wide on mobile.
  table: ({ children }) => (
    <div className="msg-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

function MessageContentImpl({
  content,
  children,
}: {
  content: string;
  /** Trailing node rendered after the markdown, e.g. the streaming caret. */
  children?: ReactNode;
}) {
  return (
    <div className="msg-prose text-[15px] leading-[1.6] text-linen">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
      {children}
    </div>
  );
}

const MessageContent = memo(MessageContentImpl);
export default MessageContent;
