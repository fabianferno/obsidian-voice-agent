import { describe, expect, it } from 'vitest';
import { SentenceChunker } from '../src/speech/chunker.js';
import { cleanForSpeech, hasSpeakableText } from '../src/speech/clean.js';
import { decodeWav, encodeWav, resample } from '../src/speech/wav.js';
import { cleanWhisper } from '../src/speech/whisper-text.js';

describe('SentenceChunker', () => {
  it('emits a short first sentence quickly, then batches', () => {
    const c = new SentenceChunker();
    const out: string[] = [];
    for (const piece of ['Sure thing. ', 'I added it ', 'to your daily note. It is ', 'under Tasks. Anything else?']) {
      out.push(...c.push(piece));
    }
    const rest = c.flush();
    expect(out[0]).toBe('Sure thing.');
    expect([...out, rest].join(' ')).toBe('Sure thing. I added it to your daily note. It is under Tasks. Anything else?');
  });

  it('does not split on abbreviations or decimals', () => {
    const c = new SentenceChunker(1);
    expect(c.push('Version 3.5 is out, e.g. today. ')).toEqual(['Version 3.5 is out, e.g. today.']);
  });

  it('breaks very long runs at a comma', () => {
    const c = new SentenceChunker(10, 60);
    const out = c.push('one two three four five six seven, eight nine ten eleven twelve thirteen fourteen');
    expect(out[0]).toBe('one two three four five six seven,');
  });
});

describe('cleanForSpeech', () => {
  it('strips markdown and Obsidian syntax', () => {
    expect(cleanForSpeech('## Plan\n- [ ] Call **Ana** about [[Garden Project|the garden]]\n- see [docs](https://x.y)')).toBe(
      'Plan Call Ana about the garden see docs',
    );
    expect(cleanForSpeech('Linked [[Weekly Review#Goals]] and ![[img.png]] `code` #42 #idea')).toBe(
      'Linked Weekly Review and code number 42 idea',
    );
    expect(cleanForSpeech('Here:\n```js\nconst a = 1\n```\nDone ✅')).toBe('Here: Done');
    expect(cleanForSpeech('Your [Garden Project.md](file:///v/Garden%20Project.md) says compost.')).toBe('Your Garden Project says compost.');
  });

  it('knows when there is nothing to say', () => {
    expect(hasSpeakableText(' ... ')).toBe(false);
    expect(hasSpeakableText('ok')).toBe(true);
  });
});

describe('wav', () => {
  it('round-trips samples', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const { samples: back, sampleRate } = decodeWav(encodeWav(samples, 16000));
    expect(sampleRate).toBe(16000);
    back.forEach((v, i) => expect(v).toBeCloseTo(samples[i]!, 3));
  });

  it('resamples to the target rate', () => {
    expect(resample(new Float32Array(48000), 48000, 16000)).toHaveLength(16000);
  });
});

describe('cleanWhisper', () => {
  it('drops non-speech markers', () => {
    expect(cleanWhisper(' [BLANK_AUDIO] ')).toBe('');
    expect(cleanWhisper('(music) Add milk to my list')).toBe('Add milk to my list');
  });
});
