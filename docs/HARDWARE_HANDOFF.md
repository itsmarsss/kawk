# Connect a device to the existing demo

The computer runs the TypeScript client/services and local Python perception.
The agent remains OpenAI/Jev backed. A glasses adapter should supply camera frames
and microphone samples to this pipeline rather than introduce another gallery,
memory writer or Jev activation loop.

## Existing interfaces

| Interface | Contract / implementation |
|---|---|
| `POST /api/sessions` | Creates a capture session; save its returned `id`. |
| `/ws/faces` | Proxies the local perception face socket. Reuse the protocol in `memory/client/src/faceLink.ts`; bind a result to the exact frame that produced it. |
| `/ws/speech?backend=local` | Proxies local Whisper. Reuse `speechLink.ts` and `speechTiming.ts`: wait for ready, send PCM in order, assign a new stream ID after reconnect, expose gaps. |
| `POST /api/transcripts` | Durable revision-aware transcript input; submit independently of Jev. The schema is `TranscriptSchema` in `memory/src/contracts.ts`. |
| `POST /api/captures` | JPEG base64, session, sequence, original capture time, dimensions, audio status and same-photo face evidence. See `CaptureInputSchema`. A 202 is upload acceptance, not interpreted memory. |
| `/api/agent/commands` | Poll using the active session ID, claim one camera command, capture/upload its request ID, and report the result. See `agentCommands.ts`. Preserve the ordinary five-second schedule. |
| `POST /api/agent/faces` | Forward fresh confirmed-gallery face changes separately from slow image interpretation. See `liveFaces.ts`; preserve its age, heartbeat and single-request bounds. |
| `/api/agent/events` | SSE notification delivery. Acknowledge only after actual display/interaction via `/api/agent/notifications/:id/ack`. The same ID may be replayed after reconnect. |

Native computer clients can also reuse `agent/client/` for clock calibration and
direct agent events. Its device token is a local connection credential, not a
provider API key. Keep the one-wearer assumption explicit. Neither a visible face
nor an authenticated device identifies who spoke.

## What remains device-specific

The physical glasses model, transport (for example USB, Bluetooth or network),
camera/audio encoding, source clock and display protocol have not been supplied.
No physical glasses adapter is claimed to exist. Implement that transport against
the interfaces above once the device contract is known; do not guess its protocol.

Before presenting on hardware, verify capture-clock offset and uncertainty,
camera/audio gaps, reconnect without duplicate streams, fresh-frame interruptions,
natural introductions and corrections, person reminders, notification receipt and
display acknowledgement. Laptop/provider fixtures do not replace this rehearsal.
