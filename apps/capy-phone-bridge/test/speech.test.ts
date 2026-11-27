import { describe, expect, it } from 'vitest';
import { toSpeech } from '../src/speech';

describe('toSpeech', () => {
  it('strips markdown, code and links for the voice', () => {
    const out = toSpeech('## Done\n- **PR** is [here](https://x.dev/1)\n```\ncode\n```\nSee https://x.dev/2', 700, 'a link', 'More in the thread.');
    expect(out).toBe('Done. PR is here. See a link');
  });

  it('truncates long text at a sentence and adds the note', () => {
    const long = 'First sentence is here. '.repeat(100);
    const out = toSpeech(long, 100, 'a link', 'More in the thread.');
    expect(out.endsWith('More in the thread.')).toBe(true);
    expect(out.length).toBeLessThan(140);
  });
});
