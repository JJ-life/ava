// @ts-check
/**
 * Turns per-frame speech probabilities into utterances. Pure logic (no model,
 * no audio I/O) so it can be unit tested.
 *
 * Two thresholds: normally a short confident run opens an utterance, but while
 * she is talking ("guarded") the bar is higher and longer, so a cough or leaked
 * speaker audio doesn't cut her off while a real interruption still does.
 */

export const FRAME_SAMPLES = 512; // 32 ms at 16 kHz

export const DEFAULTS = {
  startProb: 0.5,
  startFrames: 4, // 128 ms
  guardedStartProb: 0.75,
  guardedStartFrames: 9, // 288 ms
  endProb: 0.35,
  endFrames: 17, // 544 ms of quiet ends the turn
  trailFrames: 6, // keep 192 ms of the quiet tail
  prerollFrames: 12, // 384 ms before the trigger, so onsets aren't clipped
  minSpeechFrames: 8, // 256 ms of actual speech, or it was a misfire
  maxFrames: 938, // 30 s
};

export class Segmenter {
  /** @param {Partial<typeof DEFAULTS>} [opt] */
  constructor(opt = {}) {
    this.opt = { ...DEFAULTS, ...opt };
    this.guarded = false;
    this.reset();
  }

  reset() {
    /** @type {Float32Array[]} */
    this._preroll = [];
    /** @type {Float32Array[]} */
    this._speech = [];
    this._inSpeech = false;
    this._run = 0;
    this._quiet = 0;
    this._voiced = 0;
  }

  /**
   * @param {Float32Array} frame
   * @param {number} prob
   * @returns {{ kind: "start" } | { kind: "end", samples: Float32Array } | { kind: "misfire" } | null}
   */
  push(frame, prob) {
    const o = this.opt;
    if (!this._inSpeech) {
      this._preroll.push(frame);
      if (this._preroll.length > o.prerollFrames + o.guardedStartFrames) this._preroll.shift();
      const startProb = this.guarded ? o.guardedStartProb : o.startProb;
      const startFrames = this.guarded ? o.guardedStartFrames : o.startFrames;
      this._run = prob >= startProb ? this._run + 1 : 0;
      if (this._run < startFrames) return null;
      this._inSpeech = true;
      this._speech = this._preroll;
      this._preroll = [];
      this._voiced = this._run;
      this._quiet = 0;
      this._run = 0;
      return { kind: "start" };
    }

    this._speech.push(frame);
    if (prob >= o.endProb) {
      this._quiet = 0;
      this._voiced += 1;
    } else {
      this._quiet += 1;
    }
    if (this._quiet >= o.endFrames || this._speech.length >= o.maxFrames) {
      const dropTail = Math.max(0, this._quiet - o.trailFrames);
      const kept = this._speech.slice(0, this._speech.length - dropTail);
      const voiced = this._voiced;
      this.reset();
      if (voiced < o.minSpeechFrames) return { kind: "misfire" };
      const samples = new Float32Array(kept.length * FRAME_SAMPLES);
      kept.forEach((f, i) => samples.set(f, i * FRAME_SAMPLES));
      return { kind: "end", samples };
    }
    return null;
  }
}
