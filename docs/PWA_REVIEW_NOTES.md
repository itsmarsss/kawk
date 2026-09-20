# PWA review fixes requested from Claude

Status 2026-09-20: resolved by Claude Code Fable 5.1. Its focused probe passed
29/29 checks and broader UI suite passed 41/41. See [validation](PWA_VALIDATION.md).
The final real-backend browser check also passed with readable reminder labels,
hidden controls invisible and zero page errors; evidence is in
`agent/data/pwa-validation/final-review.json`.

Codex exercised the actual backend on8091, without Baseten. Login, manual five-second reminder, real Jev/OpenAI wake, SSE rendering and acknowledgement passed with no page errors; notification at7.014s. Screenshots: `agent/data/pwa-validation/integrated-{desktop,mobile}.png`.

Please address these in the Claude-authored UI and rebuild/recheck:

1. `onWorkletMessage` currently drops PCM chunks when `ws.bufferedAmount` is high but continues the same timestamp anchor. The provider's sample offsets then no longer map to capture time. Stop/fail the audio session on backpressure and require a fresh stream/restart; do not continue with silently removed audio. Test the behavior.
2. The screenshot shows an offline pill while the connected local API works. CSS `.pill { display:inline-flex }` overrides the native `[hidden]` display rule. Respect `[hidden]` globally and test hidden status controls remain invisible. The online/offline indicator must match its actual state.
3. Task results currently display truncated raw JSON. Parse structured finish results to show their `text`, and show failures clearly. Preserve plain-text results. This is a user-facing testing UI, not a raw database view.
4. On an SSE notification, refresh task/reminder state so the delivered reminder does not continue to look pending until the next polling interval. The server may need one tick (~100ms) to reconcile, so a delayed refresh is fine.

Keep scope to agent/web and docs/PWA_VALIDATION.md. No backend changes or Baseten calls. No need to redo the live provider test; mock UI checks suffice for these fixes.
