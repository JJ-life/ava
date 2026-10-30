// @ts-check
/**
 * Voice activity detection off the main thread: Silero VAD v5 on onnxruntime's
 * single-threaded WASM backend. Frames arrive directly from the mic worklet.
 *
 * main -> worker: { kind: "mic", port }, { kind: "guarded", value }, { kind: "reset" }
 * worker -> main: { kind: "ready" }, { kind: "failed", message },
 *                 { kind: "start" }, { kind: "misfire" }, { kind: "end", samples },
 *                 { kind: "stats", stats }, { kind: "mic-silent", value }
 */

import * as ort from "../vendor/ort.wasm.min.mjs";
import { Segmenter, FRAME_SAMPLES } from "./vad-segmenter.js";

const VENDOR = new URL("../vendor/", import.meta.url).href;
const CONTEXT_SAMPLES = 64; // Silero's reference wrapper prepends this much history

ort.env.wasm.wasmPaths = VENDOR;
ort.env.wasm.numThreads = 1; // static hosting: no cross-origin isolation

const segmenter = new Segmenter();
/** @type {import("onnxruntime-web").InferenceSession} */
let session;
let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
const windowed = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
let chain = Promise.resolve();
// A working mic is never this quiet for this long, even in a still room: the
// browser gave us a live track carrying nothing, which it won't report itself.
const SILENT_PEAK = 1e-5;
const SILENT_FRAMES = 312; // 10 s
let silentFrames = 0;
let reportedSilent = false;
const stats = { frames: 0, maxProb: 0, maxLevel: 0 };
setInterval(() => self.postMessage({ kind: "stats", stats }), 1000);

function resetModelState() {
  state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  windowed.fill(0);
}

/** @param {Float32Array} frame */
async function onFrame(frame) {
  windowed.copyWithin(0, FRAME_SAMPLES); // the previous frame's tail is the context
  windowed.set(frame, CONTEXT_SAMPLES);
  const out = await session.run({
    input: new ort.Tensor("float32", windowed.slice(), [1, windowed.length]),
    state,
    sr,
  });
  state = /** @type {any} */ (out.stateN);
  const prob = /** @type {Float32Array} */ (out.output.data)[0];
  let peak = 0;
  for (const v of frame) peak = Math.max(peak, Math.abs(v));
  silentFrames = peak < SILENT_PEAK ? silentFrames + 1 : 0;
  const silent = silentFrames >= SILENT_FRAMES;
  if (silent !== reportedSilent) {
    reportedSilent = silent;
    self.postMessage({ kind: "mic-silent", value: silent });
  }
  stats.frames += 1;
  stats.maxProb = Math.max(stats.maxProb, prob);
  for (const v of frame) stats.maxLevel = Math.max(stats.maxLevel, Math.abs(v));
  const ev = segmenter.push(frame, prob);
  if (!ev) return;
  if (ev.kind === "end") self.postMessage(ev, { transfer: [ev.samples.buffer] });
  else self.postMessage(ev);
}

self.onmessage = async ({ data }) => {
  if (data.kind === "mic") {
    /** @type {MessagePort} */ (data.port).onmessage = ({ data: frame }) => {
      chain = chain.then(() => onFrame(frame)).catch((err) => {
        self.postMessage({ kind: "failed", message: String(err?.message ?? err) });
      });
    };
  } else if (data.kind === "guarded") {
    segmenter.guarded = !!data.value;
  } else if (data.kind === "reset") {
    chain = chain.then(() => {
      segmenter.reset();
      resetModelState();
      silentFrames = 0;
      reportedSilent = false;
    });
  }
};

try {
  session = await ort.InferenceSession.create(`${VENDOR}silero_vad_v5.onnx`, {
    executionProviders: ["wasm"],
  });
  self.postMessage({ kind: "ready" });
} catch (err) {
  self.postMessage({ kind: "failed", message: String(/** @type {Error} */ (err)?.message ?? err) });
}
