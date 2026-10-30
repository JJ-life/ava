---
title: LFM3 Avatar
emoji: 🗣️
colorFrom: indigo
colorTo: purple
sdk: static
app_file: index.html
pinned: false
short_description: Talk face to face with LFM3-Omni, running in your browser
models:
  - LiquidAI/LFM3-Omni-2B
  - LiquidAI/LFM3-Omni-2B-GGUF
---

# LFM3 Avatar

Hands-free voice chat with a 3D lip-synced avatar, running entirely in the
browser: the UX of [victor/gemma-avatar](https://huggingface.co/spaces/victor/gemma-avatar)
on the model and WebGPU runtime of
[LiquidAI/LFM3-Omni-2B-WebGPU](https://huggingface.co/spaces/LiquidAI/LFM3-Omni-2B-WebGPU).
No backend: your voice never leaves the device.

```
you speak → Silero VAD (WASM) → LFM3-Omni-2B (WebGPU): audio in, interleaved text + speech out → avatar speaks
```

- **Needs** a desktop browser with WebGPU and `shader-f16` (recent Chrome/Edge) and a
  1.6 GB model download on first visit; later visits load from the browser cache.
- **Model** runs in a worker, so the avatar keeps rendering. It hears the audio
  directly: there is no separate transcription step, and so no user transcript.
- **Barge-in**: talk over her and generation and playback stop immediately.
- **The model plays the avatar** through `set_mood` and `make_hand_gesture` tools.
- **Lip-sync** is derived from the audio by HeadAudio, as in gemma-avatar.

Differences from gemma-avatar, all forced by the model: there is no voice picker
(LFM3-Omni's interleaved mode has one voice and ignores voice requests) and no
`make_facial_expression` tool (it made the model loop on emoji calls without speaking).

## Run

```bash
bun install
bun run start   # builds dist/ and serves http://localhost:3000
```

## Test

`bun test tests` covers the VAD segmenter and session state machine.
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
