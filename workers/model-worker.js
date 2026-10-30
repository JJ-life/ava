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
 *   { kind: "system", system }       new persona / instructions
 *   { kind: "reset" }                forget the conversation
 *
 * worker -> main:
 *   { kind: "progress", loaded?, total?, fraction?, status? }
 *   { kind: "ready", device, sampleRate }   { kind: "failed", name, message }
 *   { kind: "text", id, text }     { kind: "audio", id, samples }
 *   { kind: "truncate", id, samples, kept }   the reply ends at this audio sample
 *   { kind: "finished", id, reason, usage, generated, error? }
 */

import {
  Lfm3OmniForConditionalGeneration as Model,
  ContextOverflowError,
  DeviceLostError,
} from "../vendor/Lfm3OmniForConditionalGeneration.js";
import { RepeatGuard } from "./repeat-guard.js";

const LOAD_ATTEMPTS = 3; // Chromium occasionally returns no adapter on a cold GPU process
const LOAD_RETRY_MS = 1500;
// Speech costs ~16 tokens/s each way and re-reading history after a trim takes
// ~2.3 ms/token, so history stays well under the session's 8192 tokens.
const SEARCH = new URL(location.href).searchParams;
const HISTORY_BUDGET_TOKENS = Number(SEARCH.get("historyBudget")) || 3000;

/** @type {any} */ let model = null;
/** @type {any} */ let session = null;
let system = "";
/** @type {any[]} */ let history = [];
let idle = Promise.resolve();
let guard = new RepeatGuard();
/** @type {Map<number, AbortController>} */
const running = new Map();
const simulateRtf = Number(SEARCH.get("simulateRtf")) || 0;

const post = (msg, transfer = []) => self.postMessage(msg, { transfer });

function messages() {
  return [{ role: "system", content: system }, ...history];
}

/** Forget the oldest user turn and everything answering it. */
function dropOldestExchange() {
  const next = history.findIndex((m, i) => i > 0 && m.role === "user");
  if (next < 0) return false;
  history.splice(0, next);
  return true;
}

/** Past the budget half the history goes at once, so the next turn's one re-prefill buys many cheap turns. */
function compactHistory() {
  const exchanges = history.filter((m) => m.role === "user").length;
  for (let i = 0; i < Math.floor(exchanges / 2); i++) dropOldestExchange();
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
      post({ kind: "ready", device: model.deviceInfo(), sampleRate: model.audio_sampling_rate });
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`model load attempt ${attempt} failed:`, err);
      const adapterGlitch = /No WebGPU adapter/i.test(String(err?.message));
      if (adapterGlitch && attempt === LOAD_ATTEMPTS) lastErr = Object.assign(new Error(err.message), { name: "WebGPUUnavailable" });
      if (!adapterGlitch || attempt === LOAD_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, LOAD_RETRY_MS));
    }
  }
  post({ kind: "failed", name: lastErr?.name ?? "Error", message: lastErr?.message ?? String(lastErr) });
}

/** One user turn. */
async function respond({ id, audio }) {
  const controller = new AbortController();
  running.set(id, controller);
  const { signal } = controller;
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
    history.push({ role: "user", content: [{ type: "audio", audio }] });

    guard.beginReply();
    /** @type {string | null} */ let keptOnRepeat = null;
    for (;;) {
      const stream = session.generate(messages(), { generation_mode: "interleaved", signal });
      let emitted = false;
      const started = performance.now();
      try {
        for await (const ev of stream) {
          if (ev.type === "text") {
            emitted = true;
            post({ kind: "text", id, text: ev.text });
            const repeat = guard.push(ev.text, generated);
            if (repeat) {
              keptOnRepeat = repeat.kept;
              post({ kind: "truncate", id, samples: repeat.cutAt, kept: repeat.kept });
              controller.abort();
              break;
            }
          } else if (ev.type === "audio") {
            emitted = true;
            generated += ev.audio.length;
            const samples = ev.audio.slice();
            if (simulateRtf) {
              const due = started + (generated / model.audio_sampling_rate / simulateRtf) * 1000;
              await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
            }
            post({ kind: "audio", id, samples }, [samples.buffer]);
          }
        }
      } catch (err) {
        if (!emitted && err instanceof ContextOverflowError && dropOldestExchange()) continue;
        throw err;
      }
      const result = await stream.result;
      usage = result.usage;
      if (keptOnRepeat !== null) {
        // History holds what she said, not the repeat, or it would teach her to loop.
        reason = "stop";
        history.push({ role: "assistant", content: keptOnRepeat });
        guard.endReply();
      } else {
        reason = result.finish_reason;
        history.push(result.message);
        if (reason === "stop") guard.endReply();
      }
      break;
    }
  } catch (err) {
    if (err?.name === "AbortError" || signal.aborted) {
      reason = "cancelled";
    } else {
      console.error(err);
      reason = "error";
      error = { name: err?.name, message: err?.message ?? String(err), fatal: err instanceof DeviceLostError };
    }
  } finally {
    running.delete(id);
    post({ kind: "finished", id, reason, usage, generated, error });
    if (usage && usage.prompt_tokens + usage.completion_tokens > HISTORY_BUDGET_TOKENS) compactHistory();
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
    case "system":
      system = data.system;
      break;
    case "reset":
      idle = idle.then(() => {
        history = [];
        guard = new RepeatGuard();
      });
      break;
  }
};
