import { describe, expect, it } from 'vitest';
import { speakableText } from './ttsText';

describe('speakableText', () => {
  it('removes emoji the voice would otherwise read by name', () => {
    expect(speakableText("I'm here 😊")).toBe("I'm here");
    expect(speakableText('Go team 👩‍💻👍🏽🇮🇳!')).toBe('Go team !');
  });

  it('says only the site name for a bare URL', () => {
    expect(speakableText('Check https://www.example.com/a/b?c=1 for details.')).toBe(
      'Check example.com for details.',
    );
  });

  it('leaves ordinary text, numbers and currency untouched', () => {
    expect(speakableText('It costs $5 at 3:30pm, 50% off.')).toBe(
      'It costs $5 at 3:30pm, 50% off.',
    );
  });

  it('returns empty for emoji-only input', () => {
    expect(speakableText('🎉🎉')).toBe('');
  });
});
