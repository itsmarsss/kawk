# KAWK memory testing client

Browser page for `memory/` (port 8082). Source in `client/src`, pure-logic tests in `client/test`,
bundle in `public/client.js` (served with `public/index.html` and `public/styles.css`).

Commands (run from `memory/`):

```sh
node_modules/.bin/tsc -p client/tsconfig.json                     # strict DOM typecheck, no emit
node_modules/.bin/tsx --test client/test/*.test.ts                # Node tests (fake clock / fake WebSocket)
node_modules/.bin/esbuild client/src/main.ts --bundle --format=esm --target=es2022 \
  --platform=browser '--external:/static/*' --outfile=public/client.js
```

Module map: `cadence.ts` anchored 5 s ticker · `faceSlot.ts` single-outstanding face request + bounded
scheduled-photo queue · `faceBinding.ts` reply→FaceEvidence (stable_id only, geometry check) ·
`speechTiming.ts` sent-audio timeline (piecewise cloud-offset→source-time) · `revisions.ts` transcript
revision ledger · `submissions.ts` once-only capture POST with identical-body retries · `media.ts`
camera/mic/worklet · `faceLink.ts` / `speechLink.ts` sockets (face socket also carries the `introduction`
control plane) · `introductions.ts` final-only, once-per-segment, epoch-bound introduction forwarding +
reply parsing · `speechBackend.ts` local/baseten selection, honest labels, Live-transcript status line ·
`session.ts` one Run per Start (`start({speechBackend})`, `resetFaces()`, `captureNow(requestId)` agent interrupt photo
through the same draw/face/submission path) · `sequence.ts` one strictly increasing capture sequence shared by ticks,
interrupts and the Stop snapshot · `agentCommands.ts` CommandPoller (GET /api/agent/commands every 400 ms, one in
flight, claim → captureNow → result; Stop aborts) · `agentFeed.ts` notification ledger (id-deduped across GET/SSE/
reconnect), SSE wrapper, ref → same-origin link, task/status helpers · `liveFaces.ts` LiveFaceForwarder (regular ~5 fps face results → POST /api/agent/faces on
stable identity-set changes incl. unknown/no-face, ≤ 1-per-3 s heartbeat, one POST in flight, latest-only pending,
stale (> 4 s) dropped, no replay after failure, Stop ends it) · `searchMode.ts` keyword-default / semantic
search body · `people.ts` People ordering (enrolled first, then most recently seen; all rows rendered) +
person-specific Delete labels · `main.ts` DOM incl. the compact Agent section (status, ask, answers + Ack, tasks +
Cancel), People list with confirmed DELETE /api/people[/:id], the plain-language introduction line
(`summarizeIntroduction`) and service-worker registration (`public/sw.js`, network-first shell only).

Browser QA (no camera, isolated mock server on a random port; needs `../agent/node_modules/playwright`):

```sh
node client/qa/browserQa.mjs        # 27 checks, screenshots in /tmp/kawk-merged-ui-qa/
node client/qa/mockServer.mjs       # standalone mock of the memory+agent HTTP contract
```
