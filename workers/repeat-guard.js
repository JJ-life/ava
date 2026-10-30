// @ts-check
/**
 * LFM3-Omni-2B tends to re-ask its own last question ("Red is a great choice.
 * What's your favorite color?"), whatever the prompt says. Speech generates
 * about 3x faster than it plays, so a repeat is usually visible in the text
 * before it is heard. This spots it in the text, and finds the silence that ends
 * the last good sentence in the audio, so the reply can stop cleanly there. Text
 * runs several words ahead of its audio, so the two can't be matched sample for
 * sample. Pure logic, for testing.
 */

const STOP_WORDS = new Set(
  "a an and are about do does did for how i in is it me of on or s so that the to what what's whats which who would you your you're yours".split(" "),
);
const SIMILAR = 0.6;
const MIN_REPEATED_STATEMENT_WORDS = 4;

/** @param {string} sentence */
function words(sentence) {
  return sentence.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9']+/g) ?? [];
}

/** @param {string} sentence */
function keywords(sentence) {
  return new Set(words(sentence).filter((w) => !STOP_WORDS.has(w)));
}

/** @param {string} a @param {string} b */
function similar(a, b) {
  const x = keywords(a);
  const y = keywords(b);
  if (x.size === 0 || y.size === 0) return words(a).join(" ") === words(b).join(" ");
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / new Set([...x, ...y]).size >= SIMILAR;
}

export class RepeatGuard {
  constructor() {
    /** Everything she has already said in this conversation. @type {string[]} */
    this.said = [];
    this.beginReply();
  }

  beginReply() {
    this._current = "";
    this._kept = "";
    /** @type {string[]} */
    this._sentences = [];
  }

  /**
   * Feed one text delta. Text is released a sentence at a time, once it is known
   * not to be a repeat, so a repeat never reaches the subtitles.
   * @param {string} text
   * @returns {{ released: string, repeat: boolean }}
   */
  push(text) {
    let released = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      this._current += ch;
      const next = text[i + 1];
      const closes = ch === "?" || ch === "!" || (ch === "." && (next === undefined || /\s/.test(next)));
      if (!closes) continue;
      const sentence = this._current.trim();
      if (this._isRepeat(sentence)) return { released, repeat: true };
      released += this._current;
      this._current = "";
      this._kept += ` ${sentence}`;
      this._sentences.push(sentence);
    }
    return { released, repeat: false };
  }

  /** What's left unreleased when the reply ends normally. */
  flush() {
    const rest = this._current;
    const sentence = rest.trim();
    this._current = "";
    if (sentence) {
      this._kept += ` ${sentence}`;
      this._sentences.push(sentence);
    }
    return rest;
  }

  get kept() {
    return this._kept.trim();
  }

  /** The reply is over: remember what was actually said. */
  endReply() {
    this.said.push(...this._sentences);
    this.beginReply();
  }

  /** @param {string} sentence */
  _isRepeat(sentence) {
    // Never cut the only thing she has to say: silence is worse than a repeat.
    if (this._sentences.length === 0) return false;
    const isQuestion = sentence.endsWith("?");
    if (!isQuestion && words(sentence).length < MIN_REPEATED_STATEMENT_WORDS) return false;
    return this.said.some((s) => s.endsWith("?") === isQuestion && similar(s, sentence));
  }
}

const SPEECH_CHARS_PER_SEC = 15;
const GAP_RMS = 0.004;
const GAP_FRAME_SEC = 0.02;
const MIN_GAP_SEC = 0.3;

/**
 * Where to end a reply whose good part is `keptChars` of text. Looks for the
 * first long silence around where that much speech should have finished; commas
 * make shorter pauses earlier on. Null until enough audio exists to decide.
 * @param {Float32Array} audio speech so far, starting at its first sound
 * @param {number} sampleRate @param {number} keptChars
 * @returns {number | null} sample to stop at
 */
export function findCut(audio, sampleRate, keptChars) {
  const estimate = keptChars / SPEECH_CHARS_PER_SEC;
  const hop = Math.round(GAP_FRAME_SEC * sampleRate);
  const earliest = Math.round(estimate * 0.75 * sampleRate);
  const giveUpAt = Math.round((estimate * 1.6 + 0.5) * sampleRate);
  let quietFrom = -1;
  for (let i = earliest; i + hop <= audio.length; i += hop) {
    let sum = 0;
    for (let j = i; j < i + hop; j++) sum += audio[j] * audio[j];
    const quiet = Math.sqrt(sum / hop) < GAP_RMS;
    if (!quiet) quietFrom = -1;
    else if (quietFrom < 0) quietFrom = i;
    if (quietFrom >= 0 && i + hop - quietFrom >= MIN_GAP_SEC * sampleRate) return quietFrom + Math.round(0.1 * sampleRate);
    if (i >= giveUpAt) return giveUpAt;
  }
  return null;
}

/**
 * Index of a reply's first sound, so she doesn't open with silence.
 * @param {Float32Array} audio @returns {number} -1 if it's all silence so far
 */
export function firstSound(audio) {
  for (let i = 0; i < audio.length; i++) if (Math.abs(audio[i]) > 0.01) return i;
  return -1;
}
