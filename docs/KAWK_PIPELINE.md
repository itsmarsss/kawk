# KAWK: retroactive context and agent activation

This is the agreed product direction and a proposed integration contract. The
current browser V1 still uses fixed command handlers. A general agent harness,
the temporal evidence ledger, and this scheduler are not implemented by this document.

## Flow

```text
Timestamped audio/video
  -> perception (faces, object tracks, speech revisions)
  -> temporal evidence ledger + stable world state
  -> Jev: is there a useful memory or opportunity to help?
  -> bounded agent task with source evidence and uncertainty
  -> retrieve memories/clips, inspect evidence, update memory, render a result
```

KAWK should understand needs expressed in ordinary conversation. “Where did I
put my keys?” can trigger retrieval without a wake word. “I need to ask Bob about
his trip” is a candidate future-interaction need; context and the agent determine
whether and how to remember it. The product should not require “remind me to,”
nor turn every mention of an obligation into an automatic reminder.

Jev is a fast text decision gate. The agent receives the original utterance/event,
relevant evidence interval, possible people/objects, confidence and allowed tools.
Jev's output authorizes considering a task; it does not fabricate tool arguments or
prove speaker identity. Tool schemas, evidence checks, idempotency and cancellation
remain deterministic. The trigger vocabulary should not duplicate every tool's
grammar. Agent model/tool design is a separate integration task.

## Temporal evidence and noise

Keep capture time, utterance start/end and arrival time separately. A delayed
transcript must be joined to the people and scene visible during that utterance,
not whoever is visible when the network reply arrives. Preserve evidence revisions
so a later final/correction can update an earlier tentative interpretation.

Person state needs separate fields for last confirmed identity, fresh identity
confidence, geometric track continuity, occlusion and encounter presence. Brief
`Unknown` observations can lower confidence without generating a new person or
ending a conversation. A contradictory strong identity must invalidate the old
binding. Use hysteresis and time-based confidence decay; geometric prediction
cannot by itself prove identity.

For objects, use association, confidence, dwell and confirmed absence. Blur,
camera motion or a transport gap is reduced observability, not proof an object
was placed or removed. Predict boxes through short gaps, reacquire after motion,
and record uncertainty. Periodically refresh even a static scene to avoid making
the cached world permanently stale.

Speech revisions carry segment ID, revision, finality, source interval, and
speaker uncertainty. Partials can drive tentative UI or speculative retrieval;
they must not cause irreversible memory/tool effects. Final is a stability
signal, not a guarantee of transcript accuracy. Overlap and later corrections
must remain representable. Current V1 already avoids acting on partials.

Viewing Bob during an utterance is evidence that Bob is the conversation partner,
not proof that Bob spoke. Overlap means multiple speakers may share a segment.
Audio diarization can supply anonymous speaker turns; linking those turns to a
visible person requires further evidence, such as timing/turn-taking and validated
audio-visual speaker association. Preserve competing hypotheses and abstain when
ambiguous. SAM tracks visual regions; it does not identify which voice spoke.

## Scheduler priorities

1. Video: one in-flight inference and one replaceable newest candidate; deadline
   and quality checks prevent stale frames/results from accumulating.
2. Speech finals/corrections: bounded reliable journal with IDs and acknowledgements;
   coalesce context when useful, but never silently replace a final as if it were video.
3. Reuse native tracker/session state and cached features where the serving API
   correctly supports it. Heavy refresh on uncertainty, meaningful change, or expiry.
4. Lower redundant sampling before lowering resolution. Prioritize sharp frames,
   hand/object interaction, new entities and speech-linked visual evidence. Measure
   small-object recall before shrinking inputs.
5. Batch independent compatible streams only within a small measured deadline.
   Keep per-stream state isolated. Do not wait for future live frames just to fill
   a batch or concatenate speech chunks without measuring added buffering delay.

The current SAM service recreates native sessions per concept/update. It must be
profiled and corrected before a scheduling experiment can establish persistent
tracking gains. Increasing Baseten concurrency does not automatically batch a
custom predictor or accelerate a pinned active WebSocket.

## Existing behavior versus targets

Current face votes require two positive matches among the last three observations;
weak evidence can coast briefly. Current product presence waits for two seconds
of observed absence. Current speech partials update Heard but do not trigger a
speech decision. These are useful protections, not the complete temporal ledger.

The benchmark deliberately exposes the current final-receipt attribution, lost
pending final speech, and implied-need fixed-grammar gaps. These should be resolved
at the agent/evidence/scheduler boundary, not by adding another example-specific
regular expression.

## Primary sources

- [Baseten: application requirements and latency budgets](https://www.baseten.co/inference-engineering/book/01-prerequisites/about-your-app/)
- [Baseten: latency percentiles and end-to-end measurement](https://www.baseten.co/inference-engineering/book/01-prerequisites/measuring-latency-and-throughput/)
- [Baseten: concurrency and batching](https://www.baseten.co/inference-engineering/book/07-production/autoscaling/)
- [Baseten: WebSocket state and metrics](https://docs.baseten.co/development/model/websockets)
- [Baseten: request lifecycle and backpressure limits](https://docs.baseten.co/deployment/autoscaling/request-lifecycle)
- [Meta: SAM 3.1 multiplex tracking and inference optimizations](https://github.com/facebookresearch/sam3/blob/main/RELEASE_SAM3p1.md)
