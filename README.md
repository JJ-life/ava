---
title: Ava
emoji: 🗣️
colorFrom: indigo
colorTo: purple
sdk: static
app_file: index.html
pinned: false
thumbnail: https://huggingface.co/spaces/townbox/ava/resolve/main/thumbnail-v3.jpg
short_description: Talk face to face with LFM3-Omni, running in your browser
models:
  - LiquidAI/LFM3-Omni-2B
  - LiquidAI/LFM3-Omni-2B-GGUF
  - LiquidAI/LFM3-1.7B
---

# Ava

Hands-free voice chat with Ava, a 3D lip-synced avatar, running entirely in the
browser: the UX of [victor/gemma-avatar](https://huggingface.co/spaces/victor/gemma-avatar)
on the model and WebGPU runtime of
[LiquidAI/LFM3-Omni-2B-WebGPU](https://huggingface.co/spaces/LiquidAI/LFM3-Omni-2B-WebGPU).
No backend: your voice never leaves the device.

Model: [LiquidAI/LFM3-Omni-2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B), loaded from
[LiquidAI/LFM3-Omni-2B-GGUF](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF). It is built on the
[LiquidAI/LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B) language model.

```
you speak → Silero VAD (WASM) → LFM3-Omni-2B (WebGPU): audio in, interleaved text + speech out → avatar speaks
```

- **Needs** a desktop browser with WebGPU and `shader-f16` (recent Chrome/Edge) and a
  1.6 GB model download on first visit; later visits load from the browser cache.
- **Model** runs in a worker, so the avatar keeps rendering. It hears the audio
  directly: there is no separate transcription step, and so no user transcript.
- **Barge-in**: talk over her and generation and playback stop immediately. Her
  side of the history then holds what you had heard, not everything the model had
  generated (it runs several times faster than she speaks).
- **Body language** (moods, thumbs up, shrug, a wave) is read from her words as they
  are heard, in `src/reactions.js`.
- **Character** is a system prompt you can edit directly in Settings
  (`src/system-prompt.js` has the default). The only thing added to it is the model's
  required "Respond with interleaved text and audio." line. The default is three short
  paragraphs: who she is, the body and senses the app gives her, and who the user is.
  One sentence wasn't enough: she answered "who are you?" as the model, took the user
  for Ava, made up facts about them and denied the body on screen. Its line about her
  look follows the "Wear glasses" setting. An edited prompt applies from her next reply
  and starts the conversation afresh, because replies in the old voice hold her to it.
- **Long conversations**: past the history budget the older half of the conversation
  is dropped. First she is asked, in text and unheard, what you have told her about
  yourself; her answer is kept as the most recent exchange (`public/workers/conversation.js`).
- **Lip-sync** is derived from the audio by HeadAudio, as in gemma-avatar.

Differences from gemma-avatar, all forced by the model: there is no voice picker
(LFM3-Omni's interleaved mode has one voice and ignores voice requests), and the
model doesn't call avatar tools. Offering any tool schema derails its conversation:
with the original Space's tools "let's play a quick game" starts a timer, and with
avatar tools it gestures on every turn, gives shallow replies and can loop without
speaking. The runtime, message format, generation mode and decoding otherwise match the
original Space: her text is decoded greedily, her speech tokens are sampled from a random
seed, and since each word follows from the speech so far, the same question gets
differently worded answers from one time to the next.

## Known model behaviour

LFM3-Omni-2B can re-ask its last question and can't sustain a game like Twenty
Questions: it answers "no" to everything and doesn't hold a secret. The original
LiquidAI Space does the same with the same model. This app doesn't try to hide it.

Now and then a long reply loses its way once its text is complete: the speech turns
to noise and silence and, left alone, runs until the context is full and the turn
fails. Her own pauses inside a reply stay under about two seconds, so the worker ends
a reply after four seconds of continuous silence. Some noise is still heard before
that silence comes.

A changed setting reaches her through the prompt, but what she has already said in the
conversation weighs more: that is why a rewritten prompt starts the conversation afresh,
and why taking her glasses off or putting them on is also noted in the conversation.

## Run

```bash
bun install
bun run start   # builds dist/ and serves http://localhost:3000
```

## Test

`bun test tests` covers the VAD segmenter, the session state machine, what the
conversation history keeps (interruptions, trimming), the system prompt, reactions,
loading lines and the load guard.
`e2e/run.sh <scenario> <outDir>` drives the real app in headless Chromium on the
real GPU: speech goes in through a PipeWire virtual mic, her voice is recorded at
the OS sink. `e2e/analyze.py <outDir> --stt` reports latency, frame rate, mouth/audio
correlation and a Whisper transcript. Needs PipeWire, `playwright-core`, Piper
test clips (`E2E_AUDIO`) and a Python env with numpy, scipy, soundfile, faster-whisper.

## Licences

Avatar `brunette.glb`: Ready Player Me, CC BY-NC 4.0 (non-commercial). Model: LFM
license 1.0. `Lfm3OmniForConditionalGeneration.js`: copied from the LiquidAI Space,
which states no licence for it. TalkingHead, HeadAudio, Silero VAD: MIT.
ONNX Runtime: MIT.
