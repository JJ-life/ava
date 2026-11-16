// @ts-check
/**
 * LFM3-Omni on WebGPU, off the main thread so the avatar keeps its frame rate.
 * One conversation lives here: the history, the prefix-cached session, and the
 * context budget. Everything the main thread needs comes back as a stream of events.
 *
 * main -> worker:
 *   { kind: "load", model, system }
 *   { kind: "respond", id, audio }   a user turn, 16 kHz Float32
 *   { kind: "abort", id }            barge-in: stop generating this turn
 *   { kind: "heard", id, text }      barge-in: how much of that reply was heard
 *   { kind: "system", system, fresh, note }  new instructions; `fresh` (a new persona) starts a new
 *                                    conversation, `note` says in the conversation what changed
 *   { kind: "reset" }                forget the conversation
 *
 * worker -> main:
 *   { kind: "progress", loaded?, total?, fraction?, status? }
 *   { kind: "ready", device, sampleRate }   { kind: "failed", name, message }
 *   { kind: "text", id, text }     { kind: "audio", id, samples }
 *   { kind: "finished", id, reason, usage, generated, error? }
 *   { kind: "trimmed", recap, exchanges }   the history was cut down; what she noted first
 */

import {
  Lfm3OmniForConditionalGeneration as Model,
  ContextOverflowError,
  DeviceLostError,
} from "../vendor/Lfm3OmniForConditionalGeneration.js";
import { Conversation, RECAP_REQUEST, quietAfter } from "./conversation.js";

const LOAD_ATTEMPTS = 4; // Chromium occasionally returns no adapter on a cold GPU process, and networks drop requests
const LOAD_RETRY_MS = 1500;
// Her replies stay in history as text only: her speech costs ~16 tokens/s and left
// no room for what was said, so a 44-turn chat now fits and she still recalls it.
// Past the budget half of it goes, well under the session's 8192 tokens. What she was
// told in that half would go with it, so first she says what she knows (see trim()).
const SEARCH = new URL(location.href).searchParams;
const HISTORY_BUDGET_TOKENS = Number(SEARCH.get("historyBudget")) || 6000;
const RECAP_MAX_TOKENS = 160;

const PRE_SPEECH_SAMPLES = 1200; // keep 50 ms before her first sound
// Now and then a long reply loses its way: the text is done, the speech turns to noise and
// silence, and it runs until the context is full and the turn fails. Her pauses inside a
// reply stay under about two seconds, so a silence twice that long ends the reply there.
const LOST_SILENCE_SEC = 4;
/** @type {any} */ let model = null;
/** @type {any} */ let session = null;
let system = "";
const conversation = new Conversation();
let idle = Promise.resolve();
/** @type {AbortController | null} */ let rereading = null;
/** @type {Map<number, AbortController>} */
const running = new Map();
const simulateRtf = Number(SEARCH.get("simulateRtf")) || 0;
const holdLoadMs = Number(SEARCH.get("holdLoadMs")) || 0; // testing: stretch out the load

const post = (msg, transfer = []) => self.postMessage(msg, { transfer });

function messages() {
  return [{ role: "system", content: system }, ...conversation.history];
}

/**
 * The history is over budget. Before half of it goes she is asked, in text and unheard,
 * what the listener has told her; her answer is kept as the latest exchange. It reads on from the
 * cached conversation, so it costs a sentence of generation, and it isn't interruptible:
 * a turn arriving now waits the moment it takes.
 */
async function trim() {
  let recap = null;
  try {
    const stream = session.generate([...messages(), { role: "user", content: RECAP_REQUEST }], { generation_mode: "text", max_new_tokens: RECAP_MAX_TOKENS });
    let text = "";
    for await (const ev of stream) if (ev.type === "text") text += ev.text;
    await stream.result;
    recap = text.trim() || null;
  } catch (err) {
    console.warn("recap failed, trimming without it:", err);
  }
  conversation.compact(recap);
  post({ kind: "trimmed", recap, exchanges: conversation.exchanges });
}

/**
 * Settle the cache while she's idle, re-reading a trimmed history and rewinding
 * past her audio, so nobody waits for it on their next turn. Stops short of the last reply: the cache can only rewind to its end,
 * and this prompt's end must still be a prefix of the next one.
 */
async function reread(signal) {
  const stream = session.generate(messages().slice(0, -1), { generation_mode: "text", max_new_tokens: 1, signal });
  for await (const _ of stream);
  await stream.result;
}

/** Re-read while idle, unless a turn arrives first. */
async function settle() {
  rereading = new AbortController();
  await reread(rereading.signal).catch((err) => {
    if (err?.name !== "AbortError" && !rereading?.signal.aborted) console.warn("re-read failed:", err);
  });
  rereading = null;
}

async function load({ model: modelId, system: sys }) {
  system = sys;
  let lastErr;
  for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
    try {
      if (!navigator.gpu) {
        throw Object.assign(new Error("This browser doesn't support WebGPU."), { name: "WebGPUUnavailable" });
      }
      post({ kind: "progress", status: "Checking your GPU" });
      const check = await Model.checkAvailability(modelId);
      if (!check.ok && !/No WebGPU adapter/i.test(check.reason ?? "")) {
        throw Object.assign(new Error(check.reason), { name: "WebGPUUnavailable" });
      }
      model = await Model.from_pretrained(modelId, {
        onProgress: (p) => {
          if (p.kind === "bytes" && p.total > 0) post({ kind: "progress", loaded: p.loaded, total: p.total });
          else if (p.status === "ready") post({ kind: "progress", fraction: 1 });
          else post({ kind: "progress", status: p.message ?? p.status });
        },
      });
      session = model.create_session();
      post({ kind: "progress", status: "Getting ready" });
      await session.prime(messages()).result;
      if (holdLoadMs) await new Promise((r) => setTimeout(r, holdLoadMs));
      post({ kind: "ready", device: model.deviceInfo(), sampleRate: model.audio_sampling_rate });
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`model load attempt ${attempt} failed:`, err);
      const adapterGlitch = /No WebGPU adapter/i.test(String(err?.message));
      if (adapterGlitch && attempt === LOAD_ATTEMPTS) lastErr = Object.assign(new Error(err.message), { name: "WebGPUUnavailable" });
      // A multi-gigabyte download over a real connection will sometimes drop a request. That's worth another go, after a growing pause; what's already cached isn't fetched again.
      const networkGlitch = /failed to fetch|networkerror|network error|load failed|err_/i.test(String(err?.message));
      if ((!adapterGlitch && !networkGlitch) || attempt === LOAD_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, LOAD_RETRY_MS * 2 ** (attempt - 1)));
    }
  }
  post({ kind: "failed", name: lastErr?.name ?? "Error", message: lastErr?.message ?? String(lastErr) });
}

/** One user turn. */
async function respond({ id, audio }) {
  const controller = new AbortController();
  running.set(id, controller);
  const { signal } = controller;
  // What generation listens to: the listener cutting in, or the reply losing its way.
  const stop = new AbortController();
  signal.addEventListener("abort", () => stop.abort(), { once: true });
  let lost = false;
  let quiet = 0; // samples since her last sound
  let said = "";
  rereading?.abort();
  const prior = idle;
  /** @type {() => void} */ let release = () => {};
  idle = new Promise((r) => (release = r));
  let reason = "stop";
  let usage = null;
  let generated = 0;
  let error;
  try {
    await prior;
    signal.throwIfAborted();
    conversation.addUser(audio);

    for (;;) {
      const stream = session.generate(messages(), { generation_mode: "interleaved", signal: stop.signal });
      let emitted = false;
      const started = performance.now();
      try {
        for await (const ev of stream) {
          if (ev.type === "text") {
            emitted = true;
            said += ev.text;
            post({ kind: "text", id, text: ev.text });
          } else if (ev.type === "audio") {
            emitted = true;
            let samples = ev.audio.slice();
            if (generated === 0) {
              // Her replies open with ~0.8 s of silence. Don't make anyone wait for it.
              const start = samples.findIndex((v) => Math.abs(v) > 0.01);
              if (start < 0) continue;
              samples = samples.slice(Math.max(0, start - PRE_SPEECH_SAMPLES));
            }
            quiet = quietAfter(quiet, samples);
            if (quiet > LOST_SILENCE_SEC * model.audio_sampling_rate && !signal.aborted) {
              lost = true;
              stop.abort();
              continue;
            }
            generated += samples.length;
            if (simulateRtf) {
              const due = started + (generated / model.audio_sampling_rate / simulateRtf) * 1000;
              await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
            }
            post({ kind: "audio", id, samples }, [samples.buffer]);
          }
        }
      } catch (err) {
        if (!emitted && err instanceof ContextOverflowError && conversation.dropOldestExchange()) continue;
        throw err;
      }
      const result = await stream.result;
      usage = result.usage;
      reason = lost ? "stop" : result.finish_reason; // cut short by us, the reply still stands
      conversation.addReply(id, result.message);
      break;
    }
  } catch (err) {
    if (lost && !signal.aborted) {
      reason = "stop";
      conversation.addReply(id, { role: "assistant", content: said });
    } else if (err?.name === "AbortError" || signal.aborted) {
      reason = "cancelled";
    } else {
      console.error(err);
      reason = "error";
      error = { name: err?.name, message: err?.message ?? String(err), fatal: err instanceof DeviceLostError };
    }
  } finally {
    running.delete(id);
    post({ kind: "finished", id, reason, usage, generated, error, lost });
    if ((usage || lost) && !signal.aborted) {
      if (session.count_tokens(messages()).prompt_tokens > HISTORY_BUDGET_TOKENS) await trim();
      await settle();
    }
    release();
  }
}

self.onmessage = ({ data }) => {
  switch (data.kind) {
    case "load":
      void load(data);
      break;
    case "respond":
      void respond(data);
      break;
    case "abort":
      running.get(data.id)?.abort();
      break;
    case "heard":
      conversation.heard(data.id, data.text);
      break;
    case "system":
      // After the turn in hand. A new persona also starts a new conversation: replies
      // in the old voice would hold her to it, however the prompt read.
      idle = idle.then(async () => {
        if (data.system === system) return;
        system = data.system;
        if (data.fresh) conversation.clear();
        else if (data.note) conversation.note(data.note);
        if (!session) return;
        if (conversation.history.length) await settle();
        else await session.prime(messages()).result.catch((err) => console.warn("prime failed:", err));
      });
      break;
    case "reset":
      idle = idle.then(() => conversation.clear());
      break;
  }
};
