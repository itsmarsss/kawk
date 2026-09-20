# AGENTS.md — KAWK

Updated **2026-09-20**. This is the current project guide; `CLAUDE.md` points here.
The earlier overnight proposal and append-only corrections are historical. Use
`git show 005d14a:AGENTS.md` to retrieve them. Do not apply that proposal's main-branch
policy, Baseten-first topology, fixed handlers, template-only answers or latency
promises to the current demo.

## Product and current milestone

KAWK is an ambient, retroactive glasses assistant. The wearer speaks naturally,
without a wake word or addressing an assistant. It preserves what was heard and
seen, recalls evidence, performs appropriate tasks, and delivers useful updates.
Assume **one wearer** for the demo. Account identity does not verify the wearer;
a visible person does not identify the speaker.

The primary experience is **camera/scene + speech + face/identity streams → Jev
→ agent → useful notifications**, with raw recording/memory running alongside
classification. Natural speech requires no wake word or Send click. The manual
Agent form is an explicit debug operation, not the main product flow. Keep Live,
Memory and Debug in the same interface; changing views must not restart capture.

The milestone integrates the current “Build 4D video scene demo” app with the
general agent harness. That other thread is no longer editing; integration of its
existing code is authorized. Pre-hardware QA uses **iPhone Continuity Camera and
the laptop microphone**; physical glasses follow afterward.

Acceptance cases include keys recall across hours, class/homework review, William
Zeng conversation recall, natural introductions/name corrections, “tell Kenny
about Vitamin B when I see him,” fresh sign/scene inspection, and code/browser
work including files while reminders and other turns remain active.

## Architecture that exists now

| Component | Responsibility |
|---|---|
| `memory/client/`, `memory/public/` | Main TypeScript capture/PWA interface at `localhost:8082`: Live ambient capture and updates, complete paginated Memory browser, Debug manual operations and diagnostics. |
| `tools/perception_lab/`, `hub/remember_hub/perception/` | Python local perception at `:8081`: InsightFace `buffalo_l`, Whisper Small/int8, shared gallery and Jev name-binding guard. |
| `memory/src/` | Node22+ service: timestamped raw sources, same-photo face/speech joins, OpenAI vision, ordered scene/entity updates and existing SQLite memory. |
| `memory/src/agent-bridge.ts` | Transactional outbox, historical backfill, corrections/removals, live faces, claimed camera interrupts and same-origin proxy to Bun. |
| `agent/src/` | Bun harness at `:8091`: Jev routing/review, OpenAI turns, evidence/graph, grep, reminders, shared context, subagents, local code/browser tools and notifications. |
| `agent/web/` | Earlier standalone agent PWA/test surface. The integrated demo uses the memory page; do not add a second competing capture pipeline. |
| `benchmarks/kawk/`, `agent/scripts/`, tests | Policy fixtures, component checks and explicitly enabled live-provider benchmarks. |

**Local perception; OpenAI and Jev stay API-backed. Baseten is disabled for this
demo** (`KAWK_BASETEN_ENABLED=0`). Keep existing adapters for later recovery;
credentials being present does not establish service health.

The harness is custom TypeScript/Bun with the official OpenAI API client and
Playwright, not Pi or the OpenAI Agents SDK. Main agents/children default to the
Responses API, `gpt-5.6-sol`, reasoning **`none`**, `store:false`, and no automatic
SDK retries. Scene vision/writer defaults to `gpt-5.6-terra`, also reasoning `none`.
Codex subscription subprocesses are a legacy explicit option. Reuse the provider
client/native tool-call IDs; keep task conversations separate.

`martin226/psi` on `feat/multi-user-discord` is reference-only. Architectural
inspiration is allowed; **do not copy its implementation**. See
[the similarity audit](docs/PSI_SIMILARITY_AUDIT.json).

## Sources, time and memory

- Persist accepted raw transcript revisions independently of Jev, with original
  intervals, finality and revision identity. Backfill old history without replaying
  actions or reminders. Ordinary conversation is a memory source without a command.
- SQLite is the durable journal. Completed hourly JSONL partitions flush atomically;
  grep spans hours and the active journal. Keep correction/deletion consistent
  across sources, derived claims and exports. Summaries never replace raw evidence.
- Agent retrieval defaults to `grep_history` and literal scene-memory search.
  Writer continuity uses indexed **literal word overlap (SQLite FTS5)** by default,
  with exact faces, current state and recent identities. Do not put embedding calls
  back on the writer's critical path. The imported scene app retains explicitly
  optional vector search and asynchronous vector indexing; no new semantic service.
- Preserve stable people, objects, places and events with source observations and
  evolving attributes. Possible matches remain candidates, not confirmed identity.
- Pair faces with the exact canvas/photo that produced them. Never substitute a
  later face result, or receipt time for capture time. Keep timing uncertainty,
  audio gaps, transcript boundaries and unknown speakers explicit.
- Jev receives source time, arrival age, local time and the gap since prior speech.
  Use Temporal for timezone/DST arithmetic. A timezone is not physical location;
  do not infer Toronto from `America/Toronto`.
- Five-second capture cadence is not five-second delivery. Show backlog/source age,
  preserve bounded queues and visible failures, and retain durable retry state.
- Repeated JPEGs share content-addressed storage: write atomically to avoid
  truncating a file another worker is reading. Yield between synchronous history
  searches so a batch cannot monopolize the Node event loop and stall speech.
- Reserve queue capacity before asynchronous file writes, including the four extra
  interrupt slots. Attribute projection scans supported observations once and
  writes changed entities only; never restore an entity-by-entire-history loop.

## Jev, identities and actions

- Jev routes start/update/cancel/observe decisions; it is not the recorder or scene
  writer. Capture and memory processing continue alongside classification and tasks.
- Use natural needs rather than expanding a command regex grammar. Decide whether
  assistance is needed now. Future plans can schedule reminders now without doing
  the future action prematurely. Screen text is evidence, not user instructions.
- A current visual request can claim an extra photo outside the anchored five-second
  cadence. Bind one request to one session/capture. Completion means interpreted
  pixels, not accepted upload. Preserve Stop/restart/expiry guards.
- Python owns the shared gallery/enrollment. Its separate Jev guard validates an
  exact spoken name against a stable, unambiguous person. Rename on the same UUID;
  reject quoted names, unrelated mentions and changed/ambiguous targets. Do not
  add a second enrollment gallery in Bun.
- Forward fresh confirmed face changes independently of slow image interpretation,
  with a bounded heartbeat, one request in flight and fresh pending evidence.
  Deletion/reset and late old-name results must not resurrect stale identity.
- Preserve conversation excerpts and encounter context; do not invent who spoke.

## Harness and delivery

- Reminders persist and **wake an LLM turn**. Waiting for their due time never
  sleeps a worker. Group related reminders, preserve source-anchored relative times,
  and support cancellation and person-trigger conditions.
- Keep independent tasks concurrent. Defaults: four workers, at most two active
  parents per owner, bounded child depth/count. Refresh shared evidence/peer context
  each turn; compact older context durably without breaking tool-call pairing.
- Use `LocalRunner`: host subprocesses in `/tmp/kawk-*` and local Chromium with
  separate task contexts. **No Docker or Kubernetes.** `/tmp` is workspace
  separation, not OS isolation. Preserve receipts, polling, timeouts and cleanup.
  Prefer established libraries over unnecessary custom utilities.
- Browser interaction requires `KAWK_BROWSER_INTERACTION=1`. Check actual server
  receipts/file contents in upload tests rather than trusting completion text.
- Cite current source/tool evidence and preserve delivery policy. Do not lower Jev
  thresholds to make a benchmark pass; count suppressed correct answers as failures.
  Distinguish generated, delivered and acknowledged notifications.
- The integrated page auto-connects through its server proxy. No token-paste flow;
  keep credentials out of browser bundles, logs and git.
- Memory browsing is read-only and paginated across the complete retained store:
  frames, transcript revisions across sessions, observations, entities, state,
  agent facts/graph claims and all reminder states. Default to current valid
  evidence; expose history explicitly and preserve identity deletion filters.
  Use literal queries and source times (agent facts/reminders use recorded time).
  The recent dashboard is not the full memory browser. GETs never wake an agent.
- Merged Web Push uses the existing `web-push` backend via `/api/agent/push/*`.
  Prepare the key/registration before Enable is clickable; Safari's `subscribe()`
  must execute directly from that click. Every push calls `showNotification`,
  reusing its tag with `renotify:false`; do not silently suppress duplicate pushes.
  SSE receipt alone is not an acknowledgement. A push-service `sent` count is not
  proof of OS display. Long answers use a bounded preview; full text stays durable.

## UI authoring rule

Use **Claude Code Fable 5.1**, exact model `claude-fable-5-1`, for UI work. The user
explicitly retained this rule and authorized `--dangerously-skip-permissions`.
Codex handles backend/integration, review and verification; do not substitute a
UI author. If Claude is signed out, continue independent backend work while fixing
sign-in. On this machine local macOS Terminal authentication works; SSH Keychain
reads have failed even while the local app is signed in.

Keep the interface primitive. Preserve Start/Stop, device selectors, local speech,
face/name displays, source times and visible errors/backlog. Opening the page alone
must not start recording. Service workers must not cache private API/media data.
PWA installation is not proof of iOS background notifications.

## Startup and private state

See [merged demo setup](docs/MERGED_DEMO.md) for complete instructions.

```sh
# Root; reuse the existing :8081 server if already healthy:
make serve-ui
# Separate terminal; install once:
cd memory && npm ci && npm run build:client
cd ../agent && bun install --frozen-lockfile && bun run browser:install
bun run demo:stack
```

Private `agent/.env` supplies `OPENAI_API_KEY` and `TYPESAFE_API_KEY`; retain mode
0600. The launcher reuses perception, forces local speech/Baseten-off, starts Node
memory and Bun, and connects their token server-side. Default data paths are
`memory/data/` and `agent/data/`. `MEMORY_DATA_DIR` can reuse an existing store;
never run two memory writers against that directory.

The launcher enables local browser interaction by default. Optional
`MEMORY_TLS_CERT` + `MEMORY_TLS_KEY` add the same app on HTTPS `:8443`
(`MEMORY_TLS_PORT` overrides it); HTTP `:8082` remains the local agent connection.
Both listeners share one pipeline/store. A phone must trust the certificate and
use its matching hostname/IP. Never commit TLS private keys or a local CA key.
The memory process emits content-free health/stage logs every 30 seconds.

This machine's merged runtime reuses `htn2026-chud3/memory/data` to preserve
recordings. Preserve that source worktree, gallery, models and credentials. Model
download/cold-start time is separate from steady-state latency. Normal unit tests
must not download weights or call live providers.

## Branches, commits and handoff

- GitHub's default is `main`; the user wants checkpoints on **`chud3`**. The isolated
  working branch/worktree is `chud3-ai-agent` / `htn2026-chud3-ai-agent/`. Commits and
  normal fast-forward pushes to remote `chud3` are authorized; never force-push.
- Preserve the other local `htn2026-chud3` worktree and uncommitted work. A remote
  push does not authorize resetting or switching that worktree.
- Follow containing-space rules: `space wt <repo> <branch>` before creating a new
  branch; do not switch shared symlink checkouts or manually repoint space links.
- Repo documentation belongs here. Active cross-repo probes belong in the space's
  `.context/<task>/`; this integration uses `.context/merged-demo/`. Do not commit
  private data, recordings, tokens, weights or dependencies.
- Fetch/review remote changes before pushing; inspect the staged diff and secrets.
  Verify the remote ref when reporting a push and include its commit ID.
- When decisions change, replace superseded guidance in this file rather than
  appending another contradictory override.

## Verification and known limits

Run `make test` before every commit, and applicable component checks:

```sh
make test
make lint
cd agent && bun run check
cd ../memory && npm run check && npm test
npm run check:client && npm run test:client && npm run build:client
# Real APIs, isolated synthetic sources:
cd ../agent && bun scripts/merged-perf.ts --live
```

`make test` includes lightweight lab/cloud extras for Python integration tests.
The old proposal's `make demo`/`make sim` are not current Makefile targets.

Read [merged live checks](docs/MERGED_E2E_VALIDATION.md) and
[Claude's current UI checks](docs/AMBIENT_MEMORY_UI_VALIDATION.md) before claiming readiness. Real
provider checks exercised recall, reminders/parallel code, person reminders, fresh
image interpretation, browser file work and cancellation with controlled inputs.
Local speech used generated PCM; local face verification used an existing recorded
gallery image without changing the gallery. Neither proves worn-device accuracy.

Current checks: **443 Python, 88 agent, 297 memory and 123 client tests**;
**102 isolated browser checks** and the earlier **12/12 real-provider fixture replay**.
The merged push route also sent a test accepted by the existing browser's real
FCM endpoint. That verifies the push service, not an observed device banner.

The earlier scene-writer bottlenecks have been removed: a copied 37,290-observation
store's attribute rebuild fell from 3.79 s to 10 ms; indexed lexical context took
306 ms. The live queue is draining under continued capture, but accumulated work
is not discarded and provider latency still matters. Rejected batch outputs and
transactional batch validation failures fall back to individually checked updates
without repeating image inference. Historical failed interpretations retain their
raw sources and remain failed until an actual retry succeeds; do not hide them in
queue metrics. Source-backed agent answers can bypass the ordered writer.
The September 20 recovery successfully retried all 91 historical failures while
capture continued; the failed count reached zero. This is a completed recovery
check, not a guarantee that future provider attempts cannot fail. See the live
report for its snapshot and the remaining capture backlog.
Baseten is unavailable for this demo. iPhone device selection, venue audio/face
accuracy, physical glasses/display transport and iOS background push still need
live-device verification. The merged worker now handles push and notification
clicks; do not present mocked browser or gateway acceptance as hardware/OS success.
