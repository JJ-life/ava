// @ts-check
/**
 * AudioWorkletProcessor that plays streamed Float32 mono speech at the model's
 * rate (24 kHz), interpolated to the AudioContext rate. Adapted from the
 * speech-to-speech playback worklet: a queue with clean fades, plus a start
 * threshold so a GPU slower than realtime builds a cushion before she talks.
 *
 *   main -> worklet:
 *     { kind: "config", inputRate }
 *     { kind: "audio", samples }     (transferable) per chunk
 *     { kind: "lead", samples }      queue this much before starting a turn
 *     { kind: "flush" }              no more audio is coming: start regardless
 *     { kind: "clear" }              wipe the queue (barge-in)
 *     { kind: "truncate", samples }  end this reply once it has played this far
 *
 *   worklet -> main:
 *     { kind: "progress", played, queued }   input samples, every ~50 ms
 *     { kind: "drained", played }            the queue ran dry
 */

const FADE_FRAMES = 32;
const PROGRESS_INTERVAL_SEC = 0.05;

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._inputRate = 24000;
    this._stepRatio = this._inputRate / sampleRate;
    this._queue = [];
    this._readIdx = 0;
    this._fracPos = 0;
    this._queued = 0;
    this._played = 0;
    this._lead = 0;
    this._limit = Infinity;
    this._flushed = false;
    this._playing = false;
    this._fadeIn = 0;
    this._fadeOut = 0;
    this._lastSample = 0;
    this._sinceProgress = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      switch (data?.kind) {
        case "config":
          this._inputRate = data.inputRate;
          this._stepRatio = this._inputRate / sampleRate;
          break;
        case "lead":
          this._lead = data.samples;
          this._flushed = false;
          break;
        case "flush":
          this._flushed = true;
          break;
        case "audio":
          this._queue.push(data.samples);
          this._queued += data.samples.length;
          break;
        case "truncate":
          this._limit = data.samples;
          this._flushed = true;
          break;
        case "clear":
          this._limit = Infinity;
          this._queue.length = 0;
          this._queued = 0;
          this._readIdx = 0;
          this._fracPos = 0;
          this._played = 0;
          this._flushed = false;
          if (this._playing) this._fadeOut = FADE_FRAMES;
          break;
      }
    };
  }

  _read() {
    const head = this._queue[0];
    const a = head[this._readIdx];
    let b = a;
    if (this._readIdx + 1 < head.length) b = head[this._readIdx + 1];
    else if (this._queue.length > 1) b = this._queue[1][0];
    return a + (b - a) * this._fracPos;
  }

  _advance() {
    this._fracPos += this._stepRatio;
    while (this._fracPos >= 1) {
      this._fracPos -= 1;
      this._readIdx += 1;
      this._queued -= 1;
      this._played += 1;
    }
    while (this._queue.length > 0 && this._readIdx >= this._queue[0].length) {
      this._readIdx -= this._queue[0].length;
      this._queue.shift();
    }
  }

  process(_, outputs) {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    const out = channels[0];

    if (!this._playing && this._queued > 0 && (this._queued >= this._lead || this._flushed)) {
      this._playing = true;
      this._fadeIn = FADE_FRAMES;
      this._fadeOut = 0;
    }

    for (let i = 0; i < out.length; i++) {
      let sample = 0;
      if (this._played >= this._limit && this._queue.length > 0) {
        this._queue.length = 0;
        this._queued = 0;
        this._readIdx = 0;
        this._limit = Infinity;
      }
      if (this._playing) {
        if (this._queue.length === 0) {
          // Ran dry: settle from the last value so the cut can't click.
          sample = this._lastSample * (1 - 1 / FADE_FRAMES);
          this._lastSample = sample;
          if (Math.abs(sample) < 1e-4 || this._fadeOut > 0) {
            this._lastSample = 0;
            this._playing = false;
            this._fadeOut = 0;
            this.port.postMessage({ kind: "drained", played: this._played });
          }
        } else {
          sample = this._read();
          this._lastSample = sample;
          this._advance();
          if (this._fadeIn > 0) {
            sample *= 1 - this._fadeIn / FADE_FRAMES;
            this._fadeIn -= 1;
          }
        }
      }
      out[i] = sample;
    }
    for (let c = 1; c < channels.length; c++) channels[c].set(out);

    this._sinceProgress += out.length;
    if (this._sinceProgress >= PROGRESS_INTERVAL_SEC * sampleRate) {
      this._sinceProgress = 0;
      this.port.postMessage({ kind: "progress", played: this._played, queued: this._queued });
    }
    return true;
  }
}

registerProcessor("audio-playback", AudioPlaybackProcessor);
