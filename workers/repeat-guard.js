// @ts-check
/**
 * LFM3-Omni-2B tends to re-ask its own last question ("Red is a great choice.
 * What's your favorite color?"), whatever the prompt says. Speech generates
 * about 3x faster than it plays, so a repeat is usually visible in the text
 * before it is heard. This spots it, and says where in the audio its sentence
 * began so the reply can end cleanly just before it. Pure logic, for testing.
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
    this._currentStart = 0;
    this._kept = "";
    /** @type {string[]} */
    this._sentences = [];
  }

  /**
   * Feed one text delta, with how many audio samples existed when it arrived.
   * @param {string} text @param {number} samples
   * @returns {{ cutAt: number, kept: string } | null} set when a repeat was found
   */
  push(text, samples) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (!this._current.trim()) this._currentStart = samples;
      this._current += ch;
      const next = text[i + 1];
      const closes = ch === "?" || ch === "!" || (ch === "." && (next === undefined || /\s/.test(next)));
      if (!closes) continue;
      const sentence = this._current.trim();
      this._current = "";
      if (this._isRepeat(sentence)) return { cutAt: this._currentStart, kept: this._kept.trim() };
      this._kept += ` ${sentence}`;
      this._sentences.push(sentence);
    }
    return null;
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
