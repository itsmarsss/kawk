# Merged demo — 2026-09-20

This checkpoint integrates the current “Build 4D video scene demo” code with the
ambient agent. The original brief calls for timestamped speech, same-image face
identities and image descriptions to update persistent people, objects, places and
events, plus a separate agent that answers questions and acts when useful.

```mermaid
flowchart LR
  A[Camera / scene] --> D[Timestamped source journal]
  B[Speech] --> D
  C[Faces / identities] --> D
  D --> E[Jev]
  D --> F[Persistent memory]
  E --> G[Agent]
  G <--> F
  G --> H[Useful updates]
```

## Start

Requires Node22+, Bun1.3.2+, uv, ripgrep, the existing local perception models and
private `agent/.env` containing `OPENAI_API_KEY` and `TYPESAFE_API_KEY`.
Use the existing credential file; do not put keys in git or browser code.

```sh
# Repository root. Reuse the existing :8081 server if it is already running.
make serve-ui
# Separate terminal, repository root:
cd memory
npm ci
npm run build:client
cd ../agent
bun install --frozen-lockfile
bun run browser:install
bun run demo:stack
```

Open **http://localhost:8082**. The launcher connects memory and the agent with a
server-side token automatically. It refuses occupied ports, forces local speech
and disables Baseten. Ctrl-C stops its two children and leaves perception running.
Optional `MEMORY_DATA_DIR=/absolute/path/to/existing/memory/data` reuses an existing
scene store and photos. Stop its old memory process first: never run two writers
against that directory. Agent data defaults to `agent/data/`.

### Use the app

After updating the app or a prolonged perception outage, stop the old run and
reload the page before testing. Face/speech reconnect attempts are bounded;
camera photos may keep arriving while those streams show unavailable. A fresh
Start reconnects them. Check **Live → Now** for all three stream states.

1. **Live → Start** enables the selected camera and microphone. On the Mac running
   the browser, choose iPhone Continuity Camera, laptop microphone and local speech.
   Speak naturally: “Where did I put my keys?” or “Remind me in 20 seconds to stretch.”
   Camera/scene, speech and face identities feed Jev automatically; Jev decides
   when the agent should act and produce a useful update. No wake word or Send
   click is required. Recording and memory persistence continue independently.
2. **Memory** browses the full retained history, with categories, literal text/date
   filters and pagination. It includes photos, speech across sessions, observations,
   people/objects/places/events, state changes, agent facts and reminders. Inspect
   source evidence and optionally older revisions. Browsing does not trigger tasks.
3. **Debug → Manual operation → Send** is a deliberate test/override path. It also
   works with capture stopped; it is not the normal ambient experience. Technical
   pipeline/packet details remain here. Changing views leaves capture running.
4. Source age and the memory queue describe derived scene-memory freshness.
   Accepted uploads, completed interpretations and failed interpretations are
   distinct. Transcripts and interpreted camera events reach the agent before
   the ordered scene writer finishes.

If you are connected to the serving Mac over SSH, `localhost` on your own laptop
is a different machine. Forward the UI with `ssh -L 8082:127.0.0.1:8082 user@mac`,
then visit your laptop's localhost:8082. Capture uses the browser's own devices;
Continuity Camera must be selected in a browser on the Mac where it is available.

Keep the iPhone nearby, stationary and locked, with both devices signed into the
same Apple Account and Continuity Camera enabled. USB is also supported after
trusting the Mac. See [Apple's Continuity Camera setup](https://support.apple.com/en-us/102546).
This Mac-browser test does not require installing the phone PWA.

### Direct phone access with HTTPS

Optional HTTPS shares the exact same pipeline, gallery proxy and agent:

```sh
# Repository root. Use your actual LAN IP instead of 192.168.1.20.
mkdir -p memory/data/tls
mkcert -install
mkcert -cert-file memory/data/tls/cert.pem -key-file memory/data/tls/key.pem localhost 127.0.0.1 192.168.1.20
cd agent
MEMORY_TLS_CERT="$PWD/../memory/data/tls/cert.pem" \
MEMORY_TLS_KEY="$PWD/../memory/data/tls/key.pem" bun run demo:stack
```

On the same network, open `https://192.168.1.20:8443`. The phone must trust the
certificate's CA: transfer **only `rootCA.pem`** from `mkcert -CAROOT`, install its
profile, then enable it in Settings → General → About → Certificate Trust Settings.
The CA private key stays on the Mac. Use an existing trusted certificate instead
when available. Regenerate the server certificate if its IP/hostname changes.
See [mkcert's mobile-device instructions](https://github.com/FiloSottile/mkcert#mobile-devices).

For iPhone Web Push, add the HTTPS app to the Home Screen and enable notifications
from that installed app with a user gesture. This is an [Apple platform requirement](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
HTTPS tests on a laptop do not prove phone certificate trust or lock-screen delivery.

In **Live**, press **Enable notifications**, then **Send test push**.
The first click asks the browser for permission; no token is needed. If setup
failed, **Retry push setup** fetches the key/registration again. Disable removes
this browser subscription. “Sent” means the push service accepted the message;
confirm the actual banner with the app backgrounded, then tap it to open/focus
the answer. Merely receiving an SSE update in a hidden tab does not acknowledge it.
Closing/leaving the capture page stops that page's camera and microphone. The
computer's agent and reminders continue while its services run; background push
does not make the phone a background camera. Keep the capture page active during
the rehearsal, or use the Mac/another device as the source while the phone receives
notifications. Physical-device acceptance is listed in [the rehearsal](DEVICE_REHEARSAL.md).

### Read the logs

`GET /api/health` reports queue depth, failed/committed counts, oldest pending age,
derived-memory age and recent context/model/commit timings. `GET /api/agent/status`
reports connectivity, bridge retries and active turns. The memory process also
prints a content-free JSON health record every 30 seconds; redirect the launcher
output to a local file if desired. Provider attempts remain in
`$MEMORY_DATA_DIR/model-latency.jsonl`; agent timings are in `agent/data/telemetry.jsonl`.
Keep these private, and do not infer latency from the five-second capture interval.

For pre-hardware QA, select iPhone Continuity Camera and the laptop microphone.
Opening the page does not begin capture; press Start. An iPhone opening the web
page directly needs trusted HTTPS for camera/mic permissions. Physical glasses
transport remains a separate integration step.

The integrated interface has a manifest, app icons, shell-only service worker,
install guidance and Web Push controls. This is the basic PWA shell; iPhone
installation and background banner delivery still require the device rehearsal.
The older standalone agent page is not the primary capture interface.

## What is connected

- Raw transcript revisions commit independently of Jev, then a transactional
  outbox retries delivery to the agent. Agent history remains searchable with
  ripgrep across hourly JSONL partitions and the active SQLite journal.
- Five-second photos keep source capture time, same-image face evidence and the
  rolling timestamped transcript. Vision descriptions reach the agent before the
  slower ordered memory writer completes. Capture cadence is not answer latency.
- The existing scene store retains entities, source observations, corrections and
  removals. Agent scene search defaults to literal keywords; its existing vector
  search remains optional. Imported notes are revalidated before delivery so a
  superseded/deleted note cannot support a new answer.
- Integrated Jev decisions can request a fresh camera frame. The browser claims
  the request once, preserving the normal capture schedule. Requested frames take
  the next vision-worker slot; they do not cancel an already running API call.
- One Python gallery owns face enrollment and identity. Its Jev name-binding guard
  remains separate from harness activation. A visible person is not a verified
  speaker or wearer. This demo assumes one wearer.
- Reminders are durable and wake an LLM turn. Related due reminders are grouped;
  turns share refreshed evidence and compact older context. Code/browser work runs
  locally in task-specific `/tmp` directories; no Docker or Kubernetes.

## Checkpoint verification

Current checks: **443 Python, 88 agent, 297 memory and 123 client tests passed**, plus
**102 isolated browser checks**. This includes
outbox outage/restart and rollback behavior, transcript revisions, same gallery IDs,
fresh-camera claim/session/expiry checks, stale-source rejection, and recovery from
invalid memory batch reuse without rerunning image inference. Claude's completed
UI checks are recorded separately in [the current UI report](AMBIENT_MEMORY_UI_VALIDATION.md).

```sh
make test
cd agent && bun run check
cd ../memory && npm run check && npm test
npm run check:client && npm run test:client && npm run build:client
```

These are controlled tests, not evidence that iPhone capture or hardware is ready.
All 91 historical failed captures were recovered without stopping capture. In the
following two-minute sample, 24 new captures arrived and 36 committed, reducing
the queue from 26 to 14 with zero failures. Scene memory still has visible model
latency; source-time alignment and fresh-frame priority prevent treating an old
scene as current. The [merged live-provider report](MERGED_E2E_VALIDATION.md)
records 12 passing controlled checks, local perception probes, recovery and
measured latency; iPhone/hardware testing remains separate.

The later throughput repair replaces the writer's vector lookups with indexed
keyword retrieval and removes per-entity full-history attribute scans. It also
reserves concurrent upload capacity and recovers invalid batch outputs as checked
individual updates. Rejected interpretations retain their raw sources; a failed
count is not a count of deleted recordings. See the latest section of the live
report for the rerun and measured improvements, rather than the initial timings.

Next live acceptance cases: where are my keys; summarize today's class; recall
William's conversation; enroll/rename a person; remind me about Vitamin B when
Kenny appears; request a fresh visual answer between scheduled frames; run a browser
task while a 20-second reminder is pending; cancel a task; correct/delete a memory
and confirm it is no longer cited. See existing browser/file and single-wearer
benchmark reports for earlier component runs, not merged-device guarantees.

## Provenance and remaining limits

The scene app and latest local perception/name-binding changes were imported from
the user's `htn2026-chud3` worktree; that worktree and its private data were preserved.
PSI is an architectural reference only; no PSI implementation was imported.
This checkpoint implements merged Web Push and has a real FCM acceptance receipt;
it does not claim observed iOS background delivery, glasses display,
automatic wearer recognition, or reliable speech/face accuracy in venue conditions.
