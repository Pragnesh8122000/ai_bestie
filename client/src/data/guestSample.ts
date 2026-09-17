// Frozen sample transcript shown to guests so they can see what AI Bestie
// feels like before signing in. Static and bundled with the client — it is
// never fetched from the API, so there is no live user data behind it and no
// backend surface for a guest to interact with.
export interface SampleMessage {
  role: 'user' | 'assistant';
  content: string;
  time: string;
}

export const GUEST_SAMPLE_PERSONA_NAME = 'Sam';

export const GUEST_SAMPLE_MESSAGES: SampleMessage[] = [
  { role: 'user', content: "Long day. I don't even know where to start.", time: '21:04' },
  {
    role: 'assistant',
    content: "Start wherever it hurts least. I've got time — what's sitting heaviest right now?",
    time: '21:04',
  },
  { role: 'user', content: 'Work stuff mostly. I keep saying yes to things I should say no to.', time: '21:06' },
  {
    role: 'assistant',
    content:
      "That tracks — you care what people think of you, so 'no' feels riskier than it is. What would saying no actually cost you here?",
    time: '21:06',
  },
  { role: 'user', content: "Honestly? Probably nothing. I think I just feel guilty.", time: '21:08' },
  {
    role: 'assistant',
    content: "Guilt isn't the same as being wrong. Sounds like the yes is coming from habit, not from what you actually want.",
    time: '21:08',
  },
];
