/**
 * Visual harness for the transcript styles. Dev-only; `vite build` only emits
 * index.html, so nothing here ships. Lets the formatted output be reviewed
 * against the real CSS without needing the API, DB, or an LLM reply.
 */
import { createRoot } from 'react-dom/client';
import MessageContent from '../components/MessageContent';
import { stabilizePartialMarkdown } from '../utils/markdown';
import '../styles/globals.css';

const SAMPLE = `Hey, here's what I'd try tonight.

## The short version

You're **not** stuck, you're just tired. Three things that actually help:

1. **Walk it off** — twenty minutes, no podcast
2. **Call someone** — borrow their perspective for a bit
3. *Write it down* — get it out of your skull and onto paper

> The one that matters most is the one you'll actually do.

Some smaller stuff worth trying:

- Drink water (yes, really)
- Put your phone in another room
  - Especially at night
  - Charging it outside the bedroom works
- ~~Doomscroll~~ Read something on paper

If you want to track it, run \`npm run journal\` or drop this in a file:

\`\`\`ts
const tonight = {
  walk: true,
  phone: 'other room',
};
\`\`\`

| Thing | Effort | Payoff |
| --- | --- | --- |
| Walk | Low | High |
| Call a friend | Medium | High |
| Rewrite your life plan | High | Low |

Checklist, if that's your thing:

- [x] Made it through today
- [ ] Walk
- [ ] Sleep before 1am

More on this at [the docs](https://example.com). Talk tomorrow?`;

const STREAMING = 'Here is the thing that **rea';

function Turn({ label, content }: { label: string; content: string }) {
  return (
    <div className="mb-8 flex justify-start">
      <div className="min-w-0 max-w-[85%] border-l-2 border-ember/60 py-0.5 pl-4 sm:max-w-[75%]">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
            sam
          </span>
          <span className="font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
            {label}
          </span>
        </div>
        <MessageContent content={content} />
      </div>
    </div>
  );
}

function Preview() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      {/* A user turn stays literal — asterisks are asterisks. */}
      <div className="mb-8 flex justify-end">
        <div className="max-w-[85%] rounded-[18px] border border-line/40 bg-clay/50 px-4 py-2.5 sm:max-w-[75%]">
          <span className="mb-1 block font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
            22:14
          </span>
          <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.5] text-linen">
            {"i'm feeling stuck and it's 2 * 3 kinds of tired\nany ideas?"}
          </p>
        </div>
      </div>

      <Turn label="22:14" content={SAMPLE} />

      <div className="mb-8 flex justify-start">
        <div className="min-w-0 max-w-[85%] border-l-2 border-ember/60 py-0.5 pl-4">
          <div className="mb-1 font-mono text-[10px] tracking-[0.12em] text-linen-dim/50">
            sam · streaming (dangling `**` is hidden)
          </div>
          <MessageContent content={stabilizePartialMarkdown(STREAMING)}>
            <span className="stream-caret" />
          </MessageContent>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
