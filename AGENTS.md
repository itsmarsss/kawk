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
| `memory/client/`, `memory/public/` | Main TypeScript capture/PWA interface at `localhost:8082`: camera/mic, five-second photos, live faces, introductions, memory search, agent input, tasks and notifications. |
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
  Do not add another semantic service. The imported scene app retains optional
  vector search, and its **writer currently uses MiniLM/sqlite-vec for continuity
  context**; that existing internal path is distinct from agent history grep.
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
[Claude's UI checks](docs/MERGED_UI_VALIDATION.md) before claiming readiness. Real
provider checks exercised recall, reminders/parallel code, person reminders, fresh
image interpretation, browser file work and cancellation with controlled inputs.
Local speech used generated PCM; local face verification used an existing recorded
gallery image without changing the gallery. Neither proves worn-device accuracy.

The existing scene writer can lag by many minutes during sustained capture.
Source-backed agent answers can bypass it but still incur model latency. Baseten
is unavailable for this demo. iPhone device selection, venue audio/face accuracy,
physical glasses/display transport and iOS background push still need live-device
verification. The merged service worker has no push handler; standalone agent Web
Push code is not merged-device proof. Do not present targets or fixture results as
hardware or always-on background success.
