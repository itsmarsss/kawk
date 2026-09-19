# Streaming Whisper: reuse the existing service

Model `wdlg2oe3`, production deployment `wldeyy7`, Team2, H100. **Do not redeploy,
stop, or change a teammate's deployment.** This package is a client, not a second
Whisper Truss. Selecting it can wake a scaled-to-zero service and incur usage.

The verified endpoint is
`wss://model-wdlg2oe3.api.baseten.co/environments/production/websocket` with
`Authorization: Bearer <key>`. Send the metadata in
`remember_hub.perception.stt.baseten_ws.METADATA` once, then binary16kHz mono
PCM16 little-endian packets of1024bytes/512samples/32ms. The adapter reframes whole
samples from40ms device chunks, pads only the final partial frame, and sends512ms
of silence at finite-stream EOF to allow server VAD finalization. The caller's
VAD still needs preroll and hangover during a continuing stream.

No input is consumed before the initial connection/metadata is ready. The bounded
eight-frame queue applies backpressure; it fails explicitly instead of discarding
words if transport stalls. Reconnection can interrupt an utterance: recovery status
is exposed, and a new connection namespace prevents reused transcription numbers
from overwriting an earlier utterance. Within a connection, partials retain the
same `seg_id` as their final and must **replace**, not append.

## Verified timestamp correction

A two-utterance real-service test showed that **raw word timestamps are relative
to the connection's transmitted audio**, just like segment.start_time. For example,
second segment.start_time=3.424 and its first word.start_time=3.424. The adapter
subtracts that stable segment offset to provide the hub's utterance-relative words.
Adding the offset again would incorrectly shift later utterances twice.

`t_start_hub` maps that offset through received PCM chunk times. Since the frozen
input contract is bytes without device capture timestamps, this is an estimate,
not sample-accurate acoustic capture time. Server word boundaries can include long
silence and change in partial revisions; no precise alignment or diarization claim.

```sh
uv run --extra cloud python scripts/smoke_stt.py --wav /path/to/16k-mono.wav \
  --model-id wdlg2oe3 --repeats 2 --output /tmp/stt.json
```

The script never opens a microphone. Optional
`--raw-output` saves only transcript protocol messages for timing verification;
use synthetic/consented inputs. Core offline tests perform no network calls.

Primary docs: https://docs.baseten.co/development/model/websockets and
https://www.baseten.co/library/whisper-streaming-large-v3-truss/ .
AGENTS.md's older `Api-Key` WebSocket example is superseded by the verified
Bearer protocol. HTTP face inference still uses `Api-Key`.
