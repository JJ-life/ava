// @ts-check
/**
 * AudioWorkletProcessor that downsamples the mic to 16 kHz Float32 and hands
 * fixed 512-sample frames (32 ms, what Silero VAD expects) straight to the VAD
 * worker over a transferred MessagePort, so a busy main thread can't drop them.
 *
 * main -> worklet: { kind: "enable", value: boolean }, { kind: "port", port }
 */

const TARGET_RATE = 16000;
const FRAME = 512;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._step = sampleRate / TARGET_RATE;
    this._sum = 0;
    this._count = 0;
    this._phase = 0;
    this._frame = new Float32Array(FRAME);
    this._fill = 0;
    this._enabled = true;
    /** @type {MessagePort | null} */
    this._out = null;

    this.port.onmessage = (e) => {
      if (e.data?.kind === "enable") {
        this._enabled = !!e.data.value;
        this._fill = 0;
      } else if (e.data?.kind === "port") {
        this._out = e.data.port;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input?.[0];
    if (!ch || !this._enabled || !this._out) return true;
    for (let i = 0; i < ch.length; i++) {
      // Box average over one output period: a cheap low-pass that handles any
      // context rate (44.1 k on many Macs, 48 k elsewhere).
      this._sum += ch[i];
      this._count += 1;
      this._phase += 1;
      if (this._phase >= this._step) {
        this._phase -= this._step;
        this._frame[this._fill++] = this._sum / this._count;
        this._sum = 0;
        this._count = 0;
        if (this._fill === FRAME) {
          const frame = this._frame;
          this._out.postMessage(frame, [frame.buffer]);
          this._frame = new Float32Array(FRAME);
          this._fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);
