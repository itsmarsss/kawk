# Ambient integration verification — 2026-09-20

Worktree `htn2026-chud3-ai-agent`, branch `chud3-ai-agent`. The basic implementation now includes LLM reminder wakes, grouping related due reminders, parallel parents, per-turn shared context, durable context summaries, source-time face enrollment/recall tools, a Bun speech relay, Web Push delivery, and a Claude-authored PWA. [Exact pipeline and limits](PIPELINE_OVERVIEW.md).

## Verified backend behavior

`cd agent && bun run check`: **74 passing tests**, including real local process/Chromium integration. New checks exercise grouped Kenny/Vitamin B reminders waking one LLM turn, two concurrent parents, complete context checkpointing and deletion, cross-hour speech gaps, source-time face selection despite later replacement, stable gallery UUID on rename, push retry/deduplication/expired subscriptions, cookie authentication, automatic local session bootstrap/renewal, and Whisper partial/final journaling with capture timestamps after simulated cloud startup. Face embeddings, Jev/model responses and push transport in those new checks are fixtures. The speech adapter test uses an actual local WebSocket server; it does not claim cloud speech success.

The subsequent browser/file pass raises the current backend suite to **78 passing
tests** and adds actual model-driven upload, download, code, form, export and public
documentation tasks. Its latest full live run passed **6/7**, with a correct form
submission suppressed by Jev review. See [browser/file results and timings](BROWSER_FILE_VALIDATION.md).

## Live model replay

Real OpenAI `gpt-5.6-sol`, reasoning `none`, real Jev, local tools, HTTP ingestion and SSE receipt; one synthetic wearer. No camera/microphone acquisition, OS push or glasses display in these replays. Baseten fallback disabled.

| Replay | Outcome | What it established |
|---|---|---|
| `2026-09-20T05-11-45-135Z` | 6/9 | Parallel parent queue fixed; correct notebook still suppressed by old binary review; child task hit cumulative token budget |
| `2026-09-20T05-14-07-197Z` | 7/8 | Choice-based support review delivered notebook; bounded shared context and larger explicit root budget let both children finish; keys citation still omitted antecedent |
| `2026-09-20T05-20-39-973Z` | 5/5 focused | One bounded evidence-repair attempt recovered keys recall with both old and new source refs; all overlap/recall assertions passed |

Private raw traces and reports are under `agent/data/wearer-perf/<replay>/`. Earlier failures are preserved, not overwritten. These are small functional samples, not a reliability estimate or latency percentile study.

Measured examples:

- Independent keys task waited **19–100 ms** to start, compared with the earlier single-parent bottleneck near 20 seconds. The latest answer took **12.03 s** including missing-source repair while another parent ran code.
- Notebook: **4.11 s** on the second run; **8.05 s** with one support repair on the focused run.
- Yesterday's class: **7.65 s**. A today-only query did not borrow yesterday's notes.
- Two subagents (parking and pickup code): **12.78 s** to one supported answer.
- Browser example: **6.26 s** on the first run.
- Twenty-second reminder: **22.57 s**, **23.39 s**, and **41.09 s** across the three runs. In the outlier, the wake task started within **2 ms**; the OpenAI turn took **20.70 s**, with **0 reasoning tokens**, first delta at **7.07 s**, completion at **20.07 s**. Jev review added **285 ms** and SSE transport **59 ms**. It was provider request/stream latency, not a sleeping scheduler. Reminder latency is still variable and is not solved by reasoning `none`.

Review calibration ran two probes each for six cases. Choice review approved historical notebook recall and due reminders, rejected fabricated locations/wrong dates/unsupported speakers, and remained conservative on limitation-only answers. The threshold remains 0.8; this is not proof of perfect factual review. Raw probe output: `agent/data/review-calibration/latest.json`.

## Perception and PWA limits

**Update 2026-09-20 07:16 UTC:** The user requested Baseten be enabled again.
Local `KAWK_BASETEN_ENABLED=1` is applied and the runtime restarted. Status now
reports face/speech configured, but actual probes still fail: face HTTP403
`Authentication failed`, fallback model HTTP403, and speech connection failure.
OpenAI remains the primary agent model. Probe report:
`agent/data/baseten-reenable/2026-09-20T07-16-21.211Z/report.json`.
The paragraph below records the earlier disabled-state test.

A supplied worktable photo passed through the new OpenAI image adapter in **5.945 s** with a useful scene description. The face endpoint returned **403 Authentication failed** and the cloud speech connection failed. The user confirmed Baseten was down and asked to test without it. Local `KAWK_BASETEN_ENABLED=0` therefore disables face, cloud speech and model fallback while preserving OpenAI/manual-input paths. No deployment settings or credentials were rotated. Face enrollment/recognition is implemented and fixture-tested but has **not** been validated end-to-end against live Baseten in this workstream.

Claude Code authentication succeeded from local macOS Terminal; SSH could locate the keychain entry but reading it returned status36. UI authorship is `claude-fable-5-1`, verified in its local session transcript. See [PWA validation](PWA_VALIDATION.md) for the UI checks and their boundary. Actual phone background delivery still requires an installed PWA, HTTPS, browser permission and a push subscription; a mocked send is not OS delivery.

Claude completed its review successfully: **29/29 focused UI checks** and **41/41 broader UI checks** passed against a local mock API with fake camera/microphone devices. The final combined backend/UI typecheck and backend suite still passed all **73 tests**.

The actual PWA-to-backend smoke test passed twice: login → manual five-second reminder → Jev/OpenAI wake → SSE-rendered notice → acknowledgement. Reminders arrived at **7.014 seconds** and **7.229 seconds** from input, with no page errors. Screenshots and results are in `agent/data/pwa-validation/integrated-*` and `agent/data/pwa-validation/full-stack/2026-09-20T05-32-51.212Z/`. This exercised the real local Bun service with Baseten disabled, not API mocks. It did not request OS push permission or capture a live person.

A final browser check after restarting the updated backend verified readable reminder task labels, invisible hidden controls, login, desktop/mobile layouts and zero page errors. It reused existing task data without more model requests. Evidence: `agent/data/pwa-validation/final-{desktop,mobile}.png` and `final-review.json`.

The subsequent primitive-UI update removes token entry and connects automatically.
Real-backend replay `2026-09-20T06-35-39.224Z` passed fresh-browser connection,
automatic renewal after session invalidation, manual input, LLM reminder delivery,
SSE display and acknowledgement with no page errors. The five-second reminder
arrived at **16.268 seconds** from input; UI simplification does not fix variable
model latency. Desktop/mobile screenshots show the plain single-column layout,
with Capture and Details collapsed. Evidence is under
`agent/data/pwa-validation/full-stack/2026-09-20T06-35-39.224Z/`.

The plain UI's focused mock suite passed **33/33 checks**, including bounded retries
while unavailable and automatic recovery both at startup and after an outage.
A separate browser check on `http://localhost:8091` injected two session-bootstrap
503 responses, then verified connection on the third attempt, no token/login
controls, collapsed optional sections, no mobile overflow and zero page errors.
It used the real server and made no model calls. Evidence:
`agent/data/pwa-validation/simple-live-review.json` and `simple-live-*.png`.

## PSI provenance check

No PSI source was copied during this implementation; the new prompt was written for KAWK. `python3 agent/scripts/audit-psi.py` compares this agent/client/UI/benchmark source against the reference repo's packages using 12 consecutive nonblank whitespace-normalized lines of at least250 characters. It found no matching blocks. [Machine-readable scope/result](PSI_SIMILARITY_AUDIT.json). This detects substantial literal similarity, not rewritten copying, and is not a proof of all historical authorship.
