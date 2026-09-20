# Evidence quality follow-up

The first complete 12-photo replay exposed two material failures: uncertain text
became an exact place identity, and generic door appearance was accepted as proof
of the same physical object. The pipeline must retain useful evidence without
silently turning either interpretation into verified identity.

## Same-image text evidence

Add a small optional native text-recognition adapter behind the TypeScript
interpreter. On this Mac, Apple Vision reads the exact checked JPEG. Store its
engine/revision, frame ID, image hash, bounding boxes, candidate text, scores,
duration and availability separately from generative image descriptions.

The first local test read the problematic Grasslands sign correctly in about
116 ms and produced no confident exact closure notice on the blurry frame. This
is evidence for an independent source, not proof that native OCR is infallible.
In particular it also misread a small room identifier, despite a high score.

The model receives the native candidates as fallible evidence. Its original text
readings remain available in the packet. Literal OCR and logo interpretation must
remain distinct. Uncorroborated readings remain uncertain in saved observations
and source-referenced updates; an uncertainty paragraph elsewhere is insufficient.
Platform/tool failure must be explicit and must not discard the photo or speech.
The adapter is bounded and cannot execute image text or model-supplied commands.

Verification: exact-image/hash binding, no score-as-verification shortcut,
unavailable/timeout behavior, contradictory-readings preservation, and the actual
bad sign/notice images. Only after those pass may the normal app enable the adapter.

Implemented as an optional adapter with host-only packet metadata. New raw readings
and source-format `o#` facts stay uncertain; uncertain candidate attributes remain
searchable without replacing supported attributes. The model receives OCR as a
fallible aid, so agreement is not independent corroboration. Freeform state/entity
names and paraphrases still lack enforceable per-reading provenance; that remaining
gap must not be described as solved by these narrower safeguards.

## Physical-object identity

Category, color, proximity and a similar room are candidate evidence, not proof of
the same instance. Existing IDs should receive new confirmed location/last-seen
updates only with cited earlier/current evidence and a supported instance anchor
(for example an attached tag, distinctive sticker or identifier). A candidate match
must remain visible without overwriting the canonical object's supported location.

The host can validate reference ownership, source times, active provenance,
matching stored anchors and competing candidates. Visual truth and whether a
feature is distinctive remain perception-dependent. Call this inferred continuity,
not verified identity. Known faces continue to use the gallery UUID.

Before integration, freeze the smallest contract for stored anchors and match
evidence. Test the three-door counterexample, red-tag keys across relocation and
return, competing identical keys, occlusion, and candidate retrieval without
canonical location/last-seen mutation. Do not replace reuse with unconditional
creation of unrelated new objects.

### Frozen implementation contract

The memory delta gets an `objectEvidence` array (required in new provider responses,
optional when reading legacy domain inputs). Each row declares its local entity
`ref`, a current visual `sourceIndex` and verbatim `quote`, optional new anchors,
and a nullable match assessment. Source 0 is the scene; source 1 onward are image
observations. OCR readings are not intrinsic identity anchors.

Each anchor has a kind, source index and verbatim quote. Kinds distinguish an
attached item, distinctive marking/configuration, damage and generic appearance.
Generic appearance is never sufficient for reuse. Configuration alone is also
insufficient: it must be accompanied by an attached item, marking or damage.
Stored anchors carry host IDs,
entity ownership, source packet/ref/index, original source time and active status.
An earlier batch row can be cited by packet/ref/anchor index before its host ID is
known. The host resolves both forms against persisted earlier evidence.

The current source index is checked against its verbatim quote. If the index is
wrong, the host can resolve that quote only when exactly one other visual source
in the same packet contains it (whitespace normalization only). Missing or
ambiguous matches are rejected. The resolved index is stored; this is mechanical
citation correction, not visual verification or a fuzzy text match.

A same-instance assessment cites prior anchors and current verbatim quotes, with
explicit conflicting details and competing identities. Reuse requires valid active
earlier anchors owned by the object, eligible intrinsic details, no declared
conflict/competitor and no other known object matching all cited anchor signatures.
This is supported inference, not physical verification: the model still judges
whether details are distinctive and whether the current detail matches an anchor.

Gate existing-object visual references before changing entity metadata. Missing or
insufficient match evidence produces one candidate sighting per packet/local ref,
without a new canonical entity. Its observations have separate candidate entity
links, uncertain confidence and no canonical location/last-seen updates. Entity
retrieval may include these links only while preserving the candidate distinction.
Ordinary finalized speech about an existing object remains reported evidence and
does not require a new visual match or advance visual last-seen time.

Apply the same gate after backward batch reference resolution. Reusing an earlier
candidate stays a candidate. Audio-only corrections reuse the frozen image's
identity decision; they do not turn the same image into new continuity evidence.
Persist raw evidence and all candidate history so a later resolver can revisit
ambiguity without losing what was seen. No new identity-resolving agent is added.

## Scheduling

Try an optional coalescing delay, at most five seconds from actual readiness,
only when the next ordered capture is already being observed. Do not wait for
future uploads, delay historical repairs or add an unbounded queue. The recorded
trace shows one immediate opportunity; this is not proof of sufficient throughput.
Keep the setting off until a bounded comparison demonstrates a practical benefit.

## Person identity must come from the matching face packet

The paced replay exposed another source-binding gap: a model could reuse a person
from an earlier caption because their clothing looked similar. A visual person
association must be backed by the exact packet's face entity ID. Confirmed gallery
identities require the same-frame confirmed UUID; provisional identities require
the same session, face stream and track namespace. No previous caption, later face
or batch reference can substitute for that evidence.

For an existing person with no matching face evidence, retain visual facts with a
candidate entity link and uncertain confidence. Do not change canonical metadata,
attributes or physical last-seen time. A mixed image/speech fact cannot bypass
that rule. Separately sourced final speech may still refer to an explicitly named
person or an unambiguous original encounter under the existing speech rules; a
reported mention does not mean the person was physically seen. Encounters remain
derived only from actual face packets. Use a private person-candidate map rather
than physical-object anchors or an invented biometric record.

## Capacity follow-up

### Require marker evidence in both views

Code inspection found that the physical-object gate checked the earlier anchor's
kind but accepted any source-valid current quote. A writer could cite an old
attached red tag alongside a current generic brass-key description and update the
canonical key location even when that marker was not visible now. Require the
current citation to resolve to an explicitly declared anchor on this observation,
with the same resolved source index and exact whitespace-normalized quote. Both
sides must be non-generic; at least one paired marker must be intrinsic on both
sides, rather than configuration alone. Validate every reference before deciding
whether enough evidence exists. Unpaired/generic evidence remains a searchable
candidate, retaining its source and possible target without moving the canonical
object or creating a replacement identity.

Update canonical/source/binding instructions so the writer preserves current
anchor declarations when reusing an object. Existing persisted decisions are not
silently rewritten; this applies when evaluating new interpretations. Verify the
old-marker/current-generic counterexample, missing/unrelated current anchors,
configuration on either side, exact-quote repair, a valid red-tag relocation,
competing objects, and Store persistence/restart of candidates without location
changes. Replay the five supported V6 sightings unchanged to check that the new
gate does not discard paired positive evidence. This does not fix a model calling
a shared sign distinctive in both views, and must not be reported as that fix.

The 12-packet writer replay required 121 seconds of ordered work; 116 seconds were
model intervals. Database/context overhead is not the bottleneck. Full states,
facts and new entity metadata dominate the output; shortening only object evidence
cannot provide the required improvement. Detailed raw descriptions and final
speech are saved independently, but their entity/event links and attributes must
not be discarded to obtain a faster result.

First compare the already-authorized Luna text writer on frozen packets/context,
keeping Terra for vision. Use the same provider contract, source checks, Store
and semantic retrieval checks, with explicit bounded calls and original artifacts
unchanged. Do not switch the running service unless quality and paced capacity
are demonstrated. Official OpenAI guidance recommends evaluating smaller models
and reducing generated output; model-tier descriptions are not measured latency.

If the provider comparison is insufficient, the next design to evaluate is
parallel packet-local drafts followed by a small ordered identity/state/event
binding pass. Historical identities must still be resolved serially; running the
current stateful writer concurrently would allow duplicate or stale identities.
Freeze that contract and its correction/invalidation rules before implementation.
