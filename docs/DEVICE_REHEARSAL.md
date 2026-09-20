# Ten-minute device rehearsal

Run this after starting the merged stack. These are **manual acceptance steps**,
not claims that a physical phone or glasses has passed them. Keep the existing
gallery and recordings. Use a willing participant for the person example and
record each result with its source, answer/delivery time and any errors.

| Step | Action | Pass condition |
|---|---|---|
| Select devices | On the serving Mac, choose iPhone Continuity Camera, laptop microphone and local speech; press Start. | Correct preview, speech/face sockets ready, no second simultaneous capture run. |
| Record and recall | Put keys somewhere visible, say where, then naturally ask “Where did I put my keys?” without naming the assistant. | Transcript is saved and the answer agrees with source evidence, not an older location. Inspect source age. |
| Introduction | Keep one person's face visible and say “This is Kenny.” Then use their actual correct name if that was only an example. | A stable gallery identity is named; unrelated/quoted names do not rename it. A visible face is not reported as proven speaker identity. |
| Person reminder | Say “Next time I see Kenny, remind me to tell him about Vitamin B.” Point away, then show the same person again. | Reminder is saved; a later confirmed appearance wakes an agent turn and produces one useful update. |
| Parallel work | Ask for a 20-second stretch reminder, then another code task. | The second task proceeds while the reminder waits; the reminder wakes its own turn. Record actual delay. |
| Fresh visual request | Between scheduled photos, ask “What does this sign say?” while pointing at a readable sign. | An additional camera command captures current pixels and the answer cites that fresh source. An old image is not presented as current. |
| Push | On the trusted HTTPS Home Screen PWA, Enable notifications and Send test push; repeat with the app closed/backgrounded. | Observe the actual system banner. “Sent” alone is insufficient. Tapping it opens/focuses the app without restarting a running capture. |
| Reconnect | Briefly interrupt the browser connection, restore it, then Stop and Start once. | Visible disconnect/gaps, fresh streams after recovery, no duplicate tasks/face requests, no recording after Stop. |
| Inspect memory | Open Memory during capture, browse older photos/speech, filter entities and open evidence, then return to Live. | History extends beyond the recent dashboard; capture continues without a new session or a manual Send. |
| Optional manual debug | With capture stopped, use Debug → Manual operation to send “Use code to calculate 17 × 23.” | A task runs and returns 391; no camera or mic starts. This is separate from ambient acceptance. |
| Sustained capture | Leave capture running for several minutes, watching queue and derived-memory age. | New work keeps up; neither a growing queue nor failed interpretations is hidden. Historical repair work is accounted for separately. |

For browser files, use a disposable form/site and verify the uploaded bytes and
receipt, rather than accepting the agent's completion text. The automated
`agent/scripts/merged-perf.ts --live` fixture does that independently of this
physical-device rehearsal.

If a check fails, keep the source capture/transcript and record the time, task ID,
visible error and `/api/health` plus `/api/agent/status`. Do not change Jev thresholds
just to make the example pass. See [hardware interfaces](HARDWARE_HANDOFF.md) before
connecting a physical glasses device; its model/transport is still needed.
