# InterviewPilot AI

A Windows desktop assistant for interview preparation. It transcribes your microphone and/or your PC's audio on your own machine with **whisper.cpp**, and streams explanations and suggested answers from a **local Ollama model** into a compact, always-on-top window. No cloud AI service is needed, and no audio or text leaves your computer by default.

Built with Electron 33, Angular 18 and TypeScript.

| Live transcription and answers | Practice and feedback | Study chat | History |
|---|---|---|---|
| Mic and system-audio transcription, question detection, suggested answers and explanations | Java and full-stack question bank, mock interviews with scores, answers personalised from your resume | Free-form chat with your local model | Searchable local history of transcripts and answers |

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Windows | 10 (2004+) or 11, x64 | |
| Node.js | 22 LTS (20+ works) | `winget install OpenJS.NodeJS.LTS` (development only) |
| Ollama | any recent | `winget install Ollama.Ollama`, then `ollama pull qwen2.5:7b` (or any chat model) |
| whisper.cpp | pinned build `b5454` | installed by `npm run setup:whisper`; bundled in the installer |
| Google Chrome | any recent | only for the Angular unit tests |

Hardware: speech recognition with the default `base.en` model runs comfortably on a modern 4-core CPU (about 0.8 s to transcribe a 5 s sentence on the development machine). The AI model's speed depends on your CPU/GPU; a 7B model needs about 6 GB of free RAM.

## Getting started

```powershell
cd D:\InterviewPilot-AI
npm install
npm run setup:whisper        # downloads whisper.cpp + ggml-base.en (~160 MB) into tools/whisper
ollama pull qwen2.5:7b       # skip if you already have a model
npm start                    # builds everything and launches the app
```

Then press **Start** on the Live tab. The first time, the app explains what will be captured and asks you to confirm.

### Commands

| Command | What it does |
|---|---|
| `npm start` | Production build, then launch Electron |
| `npm run dev` | Angular dev server with live reload, plus Electron pointed at it |
| `npm run build` | Type-check the Electron code, build the Angular UI, bundle main and preload |
| `npm test` | Vitest (main process, includes a real whisper.cpp test when installed) and Karma (Angular) |
| `npm run test:e2e` | Launches the built app with a fake microphone and drives the real UI (needs `npm run build` first) |
| `npm run test:loopback` | Real Windows loopback test: plays ~5 s of speech through your speakers and checks it is transcribed |
| `npm run setup:whisper` | Download whisper.cpp and a model. Other models: `node scripts/setup-whisper.mjs --model small.en`. Most accurate, on an NVIDIA GPU: `node scripts/setup-whisper.mjs --model large-v3-turbo-q8_0 --gpu` (call `node` directly: PowerShell's `npm` drops `-- --flags`). Downloads are checked against the published SHA-256 |
| `npm run dist` | Build the NSIS installer into `release/` |
| `npm run dist:dir` | Build an unpacked app into `release/win-unpacked` (faster, for testing) |
| `npm run icon` | Regenerate `build/icon.ico` |

## Using the app

### Live tab

1. Choose **Mic** and/or **System audio**, then press **Start**. A red **REC** badge, a red window frame and live level meters show while capture is active.
2. Text appears as people speak: grey italic text is provisional and is replaced by the final sentence. Lines from the microphone are labelled **You**, lines from system audio **Meeting**. Lines that look like questions get a blue bar.
3. Click transcript lines to select them, or type a question, then press **Suggest answer** (Ctrl+Enter) or **Explain**. Choose **Short**, **Medium** or **Detailed**. With nothing typed or selected, Suggest answer uses the newest lines: the last question, or what the other side said after it (for example a coding task given in plain sentences).
4. The response streams in with Markdown and code blocks. **Copy**, **Regenerate**, **Stop** and **Retry** are on the response. The view does not follow the newest text: an answer starts at the top of its panel, new text is added below without moving what you are reading, and you can scroll freely while it keeps generating. This works the same in Chat and Practice.
5. **Pause** flushes the current sentence and stops sending audio; **Stop** releases the devices.

Turn on *Answer automatically when a question is detected* in Settings to get an answer as soon as a question is recognised (with both sources active, only questions from system audio trigger it). Questions, requests ("Explain...", "Tell me...") and coding tasks ("You need to find...", "Take a list of...") are answered at once. With *Answer every line* (on by default) every other line is answered too, about 2.5 s after the speaker pauses, so nothing is skipped; a follow-up right after a question is answered together with it, and acknowledgements such as "Mm-hmm." or "Okay, that's great." are skipped. Turn it off to answer only lines that look like questions.

### Practice tab

- Pick a category (Core Java, Collections, Concurrency, JVM, Java 8-21, Spring Boot, JPA/Hibernate, Microservices, REST, SQL, Angular, JavaScript/TypeScript, System design, DSA, Behavioral) and a level.
- Type or **Dictate** your answer, then **Evaluate** for a score out of 10, strengths, gaps and an improved answer. **Model answer** shows a reference answer.
- **Mock interview** runs five questions in a row and shows your average score at the end.
- **Personalised (from my resume)** generates questions from the resume and target role in Settings › Profile.

### Chat and History tabs

- **Chat**: study conversation with the local model, with selectable answer length. Sending a message puts it at the top of the panel so its answer is read from the start; the latest answer has **Copy** and **Regenerate**.
- **History**: every live session, chat and practice session (when saving is on), with full-text search, copy and delete.

### Keyboard shortcuts

| Shortcut (default) | Action | Scope |
|---|---|---|
| `Ctrl+Shift+Space` | Show / hide the window | global |
| `Ctrl+Shift+R` | Start / pause / resume capture | global |
| `Ctrl+Shift+Enter` | Answer the selected text or the last detected question (shows the window without taking focus) | global |
| `Ctrl+1` … `Ctrl+5` | Switch tabs | in app |
| `Ctrl+Enter` | Suggest answer for the typed question | Live tab |

Global shortcuts can be changed in Settings › Keyboard shortcuts. Settings shows a warning when another application already owns a combination.

## Configuration

All settings are edited in the Settings tab and stored in `%APPDATA%\InterviewPilot AI\settings.json`. The main process validates every value, so a hand-edited or corrupt file falls back to defaults field by field.

| Area | Settings |
|---|---|
| AI (Ollama) | Endpoint (default `http://127.0.0.1:11434`), model (or *Automatic* = first installed), temperature, default length, auto-answer, answer every line (not only questions), custom instructions |
| Speech | Managed (app runs `whisper-server.exe`) or External (an existing whisper server URL); server and model paths (blank = auto-detect); CPU threads; end-of-sentence silence; sensitivity; provisional text on/off |
| Audio | Microphone device, default sources, capture consent (revocable) |
| Window | Opacity 30-100%, always on top, size, position presets. Dragging and resizing are remembered and restored only if still on a connected monitor |
| Privacy | Save history, retention in days, save audio (off by default), open data folder, delete all history |
| Profile | Target role, resume (paste or import PDF, DOCX, TXT, MD) |

whisper.cpp is found automatically in, in order: `%APPDATA%\InterviewPilot AI\whisper\{bin-gpu,bin,models}`, the installer's `resources\whisper`, and `tools\whisper` in the project. A CUDA build in `bin-gpu` (installed by `--gpu`) is preferred over the CPU build in `bin`, and the most accurate installed model is used: `large-v3-turbo`, then `small.en`, `base.en`, `tiny.en`. Server and model paths set in Settings override both. The installer bundles the CPU build and the English models only.

Set the environment variable `INTERVIEWPILOT_USER_DATA` to keep all data in another folder (used by the end-to-end tests; also works as a portable mode).

## How it works

```
 Renderer (Angular, sandboxed)                     Main process (Node.js)                    Local services
 ┌─────────────────────────────┐   IPC (preload)   ┌──────────────────────────────┐
 │ getUserMedia (mic)          │                   │ permission gates             │
 │ getDisplayMedia (loopback) ─┼─ 16 kHz PCM ─────▶│ Segmenter (VAD) per source   │──WAV in memory──▶ whisper-server.exe
 │ AudioWorklet: mono, 16 kHz  │   100 ms chunks   │ queue: finals > partials     │◀──────text─────── (127.0.0.1, random port)
 │                             │◀─ partial/final ──│ cleanup, de-dup, questions   │
 │ Live / Chat / Practice UI   │                   │ history store (JSON files)   │
 │                             │── AI request ────▶│ prompt builder + Ollama      │──/api/chat stream─▶ Ollama :11434
 │ streamed Markdown           │◀─ chunks ─────────│ client (NDJSON streaming)    │
 └─────────────────────────────┘                   └──────────────────────────────┘
```

- **Audio capture.** The microphone uses `getUserMedia` with echo cancellation and noise suppression. System audio uses `getDisplayMedia`, which the main process answers with the primary screen plus Windows WASAPI **loopback** audio (`audio: 'loopback'`); the renderer stops the screen video track immediately. An AudioWorklet downmixes and resamples to 16 kHz mono PCM.
- **Segmentation.** An energy-based voice-activity detector with an adaptive noise floor groups audio into utterances: it keeps 300 ms of pre-roll, ends a segment after the configured silence (800 ms by default), splits long monologues at a natural pause, and discards clicks shorter than 250 ms.
- **Recognition.** Each segment is posted from memory to `whisper-server` (English, temperature 0, non-speech tokens suppressed), with the vocabulary as prompt for technical terms. The previous sentence is deliberately not part of the prompt: on unclear audio whisper would copy it instead of transcribing, and the copy would then become the next prompt, so one line kept repeating while new speech was lost. While someone is still talking, the in-progress audio is transcribed every ~1.2 s as provisional text when the engine is idle. Output is cleaned (annotations such as `[BLANK_AUDIO]`, known silence hallucinations like "Thank you.", repetition loops like "No, no, no, no.") and words repeated from the previous segment are removed.
- **AI.** Requests go from the main process to Ollama's `/api/chat` with streaming. The renderer never talks to the network. Prompts set the mode (answer, explain, chat, evaluate, generate questions), length, Java-first code style, Big-O complexity for algorithm questions, and include your role and resume when present.

### Project layout

```
electron/                 Main process
  main.ts                 lifecycle, permission gates, IPC handlers
  preload.ts              the only bridge to the UI (contextBridge)
  window-manager.ts       overlay window: opacity, bounds, visibility, hardening
  window-bounds.ts        placement maths (unit tested)
  settings-store.ts       settings.json persistence
  history-store.ts        session history, search, retention
  ollama-client.ts        Ollama HTTP client with NDJSON streaming
  prompts.ts              prompt construction per mode and length
  ai-service.ts           runs and cancels streamed AI requests
  shortcuts.ts            configurable global shortcuts
  validation.ts           validation of every renderer payload
  logger.ts               troubleshooting log (no transcripts)
  stt/segmenter.ts        voice activity detection and segmentation
  stt/whisper-engine.ts   finds, launches and talks to whisper-server
  stt/transcription-service.ts  per-source pipeline and job queue
  stt/wav.ts              WAV encoding
shared/                   Code used by both sides: IPC contract, settings model, text helpers
src/app/                  Angular renderer
  core/                   bridge, settings, AI, transcript, audio capture, Markdown, resume import
  features/               live, chat, practice (question bank), history, settings
  shared/                 streamed response view
public/audio/             AudioWorklet (PCM capture)
scripts/                  build, run, whisper setup, icon generation
tests/electron/           Vitest unit and integration tests
tests/e2e/                end-to-end scripts (DevTools protocol, no extra dependencies)
```

## Privacy and data

Everything runs locally by default.

| Data | Where | When | How to delete |
|---|---|---|---|
| Audio | Memory only; sent to `whisper-server` on 127.0.0.1 | While capturing | Never written to disk unless *Save audio* is on |
| Saved audio (opt-in) | `%APPDATA%\InterviewPilot AI\recordings\<session>\*.wav` | Only with *Save audio* on | Delete the folder (Settings › Open data folder) |
| Transcripts and AI answers | `%APPDATA%\InterviewPilot AI\history\*.json` | With *Save history* on (default) | History › Delete, Settings › Delete all history, or automatic retention (30 days by default) |
| Settings, resume text | `%APPDATA%\InterviewPilot AI\settings.json` | When changed | Settings › Profile › Clear, or delete the file |
| Log | `%APPDATA%\InterviewPilot AI\logs\main.log` (max ~2 MB) | Always | Delete the file. It contains events and errors only: no transcripts, prompts, answers or resume text |
| AI requests | Sent to the configured Ollama endpoint | When you ask | Settings warns if the endpoint is not on this computer |

Uninstalling keeps `%APPDATA%\InterviewPilot AI`; delete that folder to remove all data.

## Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. A Content-Security-Policy in `src/index.html`; no remote scripts.
- The preload exposes a fixed API (`window.interviewPilot`); `ipcRenderer` itself is not exposed. Every IPC handler checks that the call comes from the app's own top-level frame and validates its payload (types, enums, lengths, id format, PCM chunk size).
- Network access (Ollama, whisper-server) happens only in the main process. Endpoint URLs are restricted to `http`/`https`.
- **Permissions are denied by default.** The microphone is granted only for audio-only requests from the app's window, after you accepted the capture notice **and** while a capture you started is running. Screen/loopback capture is granted only while a system-audio capture is running, and only loopback audio is used. Camera, notifications, geolocation and everything else are always denied.
- Navigation away from the app and new windows are blocked; external `https` links open in your browser.
- AI output is rendered by a small Markdown renderer that escapes all HTML (no links, images or raw HTML), and Angular sanitises it again.
- whisper-server listens on 127.0.0.1 on a random free port and is stopped when the app quits.



## Audio capture: capabilities and limitations

- **Microphone:** any Windows input device. Windows must allow desktop apps to use the microphone (Settings › Privacy & security › Microphone › *Let desktop apps access your microphone*).
- **System audio:** captures the mix of the **default output device** through WASAPI loopback (verified: speech played through the speakers was transcribed). It includes every application's sound, also notifications. Audio sent to a different output device (for example a headset when the default is speakers) is not captured; make the device you listen on the default. No extra Windows permission is needed.
- **Speaker labels:** "You" and "Meeting" come from the source (mic vs. system audio), not from voice recognition. If your microphone picks up the speakers, the other side may also appear as "You"; headphones avoid this.
- **Language:** English (`*.en` models). Other languages need a multilingual model and are not exposed in the UI yet.
- **Latency:** a sentence appears ~1 s after the speaker pauses with `base.en` on CPU; `tiny.en` is faster, `small.en` more accurate but slower. With the GPU build and `large-v3-turbo-q8_0` on an RTX 4060 laptop GPU, a sentence takes 0.2–0.9 s to transcribe (`small.en` on the same laptop's CPU: 0.8–1.7 s).
- **Noise:** the detector learns steady background noise over about 10 seconds; raise *Speech sensitivity* in a noisy room.

## Building the installer

```powershell
npm run setup:whisper     # so whisper.cpp and the model are bundled
npm run dist              # -> release\InterviewPilot AI Setup 0.1.0.exe (~205 MB)
```

The installer is per-user (no admin rights), lets you choose the folder, and creates Start menu and desktop shortcuts. It bundles `whisper-server.exe`, its DLLs and the models found in `tools/whisper/models`. Ollama is **not** bundled; install it separately.

The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" on first run (More info › Run anyway). To sign it, set `CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder.

## Testing

| Suite | Command | Covers |
|---|---|---|
| Main process | `npm run test:electron` (82 tests) | settings validation, IPC validation, segmentation, WAV, text cleanup and question detection, prompts, Ollama client against a fake server (streaming, missing model, unreachable, cancel), history store, transcription pipeline with a stub engine, window placement, and a real whisper.cpp transcription when installed |
| Renderer | `npm run test:ui` (34 tests) | app shell, REC indicator, tabs, shortcuts, transcript assembly, Markdown safety, question bank, shortcut recorder, response and chat scroll position while streaming |
| End to end | `npm run build; npm run test:e2e` | launches the real app: isolation, IPC validation, permission gates before/after capture, consent dialog, mic transcription, pause/resume/stop, system-audio pipeline, Ollama streaming and errors, answer scroll position during a real stream, UI answer/chat/evaluation, resume import (PDF and DOCX), history and search |
| Loopback | `npm run test:loopback` | real WASAPI loopback transcription |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm start` builds but no window appears and Electron prints a Node version | `ELECTRON_RUN_AS_NODE=1` is set (common in VS Code terminals). Launch with `npm start` / `npm run dev`; `scripts/run-electron.mjs` clears it. |
| "whisper.cpp is not installed" | Run `npm run setup:whisper`, or set the server and model paths in Settings › Speech recognition, then **Test speech engine**. |
| Speech engine failed to start | Settings › Diagnostics shows the error; the log is in `%APPDATA%\InterviewPilot AI\logs\main.log`. Try fewer CPU threads, or another model file. |
| "Cannot reach Ollama" | Start the Ollama app or run `ollama serve`. Check the endpoint in Settings › AI model and press **Test**. |
| "Model … is not installed" | `ollama pull <model>`, or choose *Automatic* in Settings. |
| Microphone access denied | Windows Settings › Privacy & security › Microphone: enable access for desktop apps. Check the capture notice is accepted (Settings › Audio). |
| No text from system audio | Make sure audio is playing on the **default** output device. |
| Text appears late or words are cut | Increase *End of sentence after … ms of silence*; use a faster model (`tiny.en`) on slow CPUs. |
| Random words during silence | Raise *Speech sensitivity*. |
| A global shortcut does not work | Another app owns it; Settings › Keyboard shortcuts shows which ones failed. Pick another combination. |
| `npm run dist` fails with "Cannot create symbolic link" | electron-builder's `winCodeSign` archive contains macOS symlinks. Enable Windows Developer Mode, or extract it once: `node_modules\7zip-bin\win\x64\7za.exe x -y "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<n>.7z" -o"%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0"` (the two symlink errors are harmless). |
| `npm run test:ui` cannot find Chrome | Install Chrome, or set `CHROME_BIN` to Edge: `$env:CHROME_BIN="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"` |
| Blank window after `npm run dev` | Wait for `ng serve` to finish compiling, then press `Ctrl+R` in the window. |

## Known limitations

- English only in the UI; no speaker diarisation beyond the mic/system split.
- Scanned (image-only) PDF resumes are not supported; paste the text instead.
- The window cannot be made click-through.
- The installer is unsigned and has no auto-update.
- Not verified in this environment: behaviour inside Zoom, Teams or Meet screen shares, and multi-monitor setups with mixed DPI. The GPU build of whisper.cpp was verified only on an NVIDIA RTX 4060 laptop GPU (CUDA 12.4, driver 592).
