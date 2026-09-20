# Parallel visual structure and ordered memory binding

Implementation decision, 2026-09-19. The last bounded writer comparison did not
meet five-second arrival capacity with either Terra or Luna. Keep Terra and two
model stages: extend the already parallel image interpretation with image-only
structure, then bind that structure to existing memories in the ordered writer.
This is selected before adding a third queue/call because capture scheduling,
durable packet versions and late-final repair can remain unchanged. Speech is
interpreted only by the ordered writer after the authoritative packet is frozen.

## Next bounded correction: descriptions belong to entities

The twelve-photo v2 replay produced valid packets but attached some bin and table
item descriptions to the wrong entity. A shirt-logo quote was also proposed as a
phone anchor. Valid indexes and literal quotes alone do not establish ownership.
Before the next real run, change only the image-provider format to nested entities:
`scene, entities:[{kind,label,description,confidence,faceIndex,location,anchors}],
readableText, uncertainties`. Each entity has its own complete description (1500
characters maximum). Scene retains background/context not owned by an entity.
There are at most 30 entities. No useful text is silently truncated.

`location` is null or `{value,confidence}`; it is a descriptive attribute scoped to
that entity and may paraphrase its position. The raw location text and confidence
are preserved in its linked fact. `anchors` contains intrinsic `{kind,quote}` evidence
from that same description only, with an empty array for nonobjects. Face slots
retain the exact same-image validation. The model must describe only the entity's
own features in its description and keep a shirt's markings on the person, never
on an adjacent phone. This prompt/structure reduces association errors but does
not make model interpretations verified facts; real-image review remains required.

The host constructs the existing Vision observations in entity order, source
indexes, one complete descriptor fact per entity, optional location facts, and
object evidence mechanically. The persistent Vision/VisualDraft shape is unchanged.
The domain visual-fact bound becomes 60 (30 descriptors + 30 locations), and the
expanded memory-fact bound becomes 130 (60 visual + at most 30 legacy descriptor
notes + 40 supplemental). Legacy provider bounds remain 40; direct canonical
provider bounds remain unchanged. Legacy draft decoders remain available for old
records; no automatic fallback conceals a failed new response.

In parallel, specialize writer reuse targets using context and prior-row kinds,
and restrict each current anchor index to the actual object's anchor count.
Reject duplicate visual identity bindings as before. Do not manufacture identity
or suppress uncertainty just to save a packet. Verify strict schema expansion,
source ownership, boundary counts, face/correction compatibility and the complete
suite before a bounded hard-photo probe. The live source route stays unchanged.

The first four-photo nested probe exposed an overly strict location-substring
check: all four model responses failed because phrases such as "along the right
side" paraphrased "line the right side". No writer calls or commits occurred.
Remove that literal-location gate, retaining structural owner binding and the
raw location text. This does not change the exact quote requirement for intrinsic
identity anchors. Preserve that failed run; verify the changed route independently.

## Binding state source copying

The writer's measured v2 output spends 53% of its JSON characters on summaries
and uncertainty, largely restating the image. Generate a complete state with
`location`, `activity`, `summary:null|string`, and `extraUncertainties` (10 by
500 characters). Null summary copies THIS packet's scene, never previous state.
An explicit summary is required when final speech, an event or context contributes
meaning absent from the scene. Copy this packet's full visual uncertainties and
append writer extras, removing exact duplicates only. Location/activity remain
explicit and null clears them. No model call or new queue is added.

The strict legacy state form with a string summary and `uncertainties` remains
accepted by the decoder with its old semantics. Mixed forms reject. Generation
uses the new form only in experimental binding mode; no additional setting is
needed. Storage allows 20 uncertainty strings of at most 1000 characters so the
complete image/writer union fits without truncation. Direct canonical/source and
legacy binding responses retain their 10 by 500 limits. Stored current state and
history remain complete ordinary objects. Verify causal copying, corrections,
explicit speech summaries, full bounds, legacy decoding and restart before any
new real run. Output savings are not a measured latency improvement yet.

## Next bounded correction: anchors belong to the chosen target

The fresh paced v3 run retained all 12 image packets but committed 8. Two writer
responses referenced an anchor on another object or a non-earlier row. Current
source ownership is fixed; generating a second independent owner/time reference
for an already chosen target creates another avoidable mismatch.

For new binding generation, change only `match.anchors[].prior` to an integer
index in the selected `to` target's eligible prior-anchor list. Supply these lists
per packet in the prompt. Existing targets contain only active anchors from other,
strictly earlier photos, with original owner IDs validated. Earlier draft targets
contain that exact draft object's anchors. Earlier supplemental targets have no
visual anchors. The host constructs the canonical anchor reference from target
and index; the model no longer supplies a second owner or time.

Constrain generation by groups of current-anchor count and eligible prior-anchor
count. Zero on either side requires an empty citation array. Retain same-kind
target restrictions, strict backward time, duplicate-target rejection and the
ordinary Store identity gate. Preserve original indexes when expanding a prior
draft anchor; the filtered existing list maps to its exact stored anchor ID.
Legacy string/structured prior references remain decodable with all old checks.
No failed legacy output is rewritten or treated as a fresh successful response.

Verify the observed owner/time failures, filtered inactive/same-photo/future
anchors, nonexistent/out-of-range references, zero-anchor candidates, existing
and earlier-row matching, maximum schema size, and unchanged legacy decoding.
Then remeasure the failed writer inputs with fresh bounded calls and rerun full
coverage/cadence. The live source route remains unchanged until acceptance passes.

## Original boundary (retained for legacy records)

The image response still contains complete scene, observations, readableText and
uncertainties. A compact provider-only `d` adds local entities, image-source facts
and intrinsic object anchors. The host decodes it into optional, readable
`Vision.visualDraft`; old persisted vision records remain valid. No audio, history,
canonical identity, event occurrence or movement inference belongs in this draft.
It is bound to the same immutable image and face packet as the description.

Domain visual draft:

- `entities`: kind (person/object/place), label, descriptionSourceIndex,
  nullable faceIndex. Array index is the local entity reference. A face index is
  permitted only for a person and must exist in the exact capture's face evidence.
- `facts`: entityIndexes, sourceIndex, nullable text (null copies the complete
  visual source), nullable attribute/value pair, observed/uncertain confidence.
  Source 0 is scene, 1 onward image observations; OCR is a separate fallible input.
- `objects`: entityIndex, sourceIndex, anchors using existing intrinsic kind,
  sourceIndex and exact quote. Every declared physical object has one entry,
  with an empty anchor array when no distinguishing feature is supported.

Provider fields are respectively `n:[{k,l,v,face}]`,
`f:[{r,v,t,a,value,c}]`, and `m:[{r,v,a:[{k,v,q}]}]`. Array/reference bounds match
existing canonical contracts. The decoder validates all references, exact source
quotes, attribute ownership and face geometry provenance. Duplicate face slots,
invalid object ownership and future/nonexistent sources are rejected. Full raw
descriptions remain stored; no semantic evidence is removed for speed.

## Ordered response and expansion

The new optional `binding` update format accepts only packets with validated
visual drafts. Its output is one ordered row per packet:

- `i`: row index; `s`: the existing complete state snapshot.
- `b`: sparse visual reuse overrides `{r,to,match}` by draft entity index.
  An omitted binding creates a new entity, except a matched face slot is bound
  mechanically to its exact context identity. Explicit `to=null` remains a valid
  redundant new declaration for compatibility. `e#` names initial context, and `p0d0`/`p0s0`
  references a visual/supplemental entity from a strictly earlier batch row.
  Current visual entity references in facts are `d#`.
- `n`: supplemental declarations `{r:s#,k,l,d}` for useful information absent
  from image-only structure, including people/events introduced by final speech.
  Supplemental refs are row-local; earlier rows use the explicit `p#s#` form.
- `f`: supplemental source facts `{r:[refs],src:v#/o#/t#,t,a,value,c}` with the
  existing source-copy, finality, uncertainty and attribute-owner rules.
- `e`: event changes `{r,status,summary}`. Event occurrences still bind causally.

Existing object matches cite `{prior:a#|{i,r,n},current:anchorIndex}` plus
assessment, conflicts and competitor `e#` aliases. All actual current quotes and
new anchor metadata come from the validated image draft. The host enforces
earlier ownership and passes ordinary ObjectEvidence to the existing Store gate.
`match` is null for nonobjects and new objects. No match still means candidate,
not confirmed reuse. Entity-kind conflicts and duplicate canonical bindings in
one row are rejected. A cited face slot forces that exact face's canonical gallery
or provisional stream/track identity; the writer cannot replace it with a name.
An image-person declaration without a face slot must stay new and frame-local.
It cannot borrow the ID of another person merely because that ID is visible
elsewhere in the same frame, or reuse a prior person from clothing alone.
Supplemental visual facts cannot bypass that restriction through an `e#` alias:
linking a canonical person requires a face-bound draft entity and the matching
visual source associated with that entity. Separate finalized speech retains its
existing name/encounter rules; an OCR reading alone is not a body/face association.

The host expands every visual draft fact plus all supplemental facts into the
ordinary MemoryBatch, retaining per-row times and explicit backward reuse. It
copies new metadata from its source; existing labels/descriptions remain intact.
Each declared visual entity also receives its complete description source as a
linked note unless that exact text is already linked by a draft fact. Generated
descriptor notes are uncertain: a narrower observed fact does not verify every
clause in its source. This repairs the real-photo result where two visible people
had entities but no searchable history or sighting time. Nothing is regenerated
by the writer for these notes. Legacy expansion needs at most 110 facts (40
visual facts + at most 30 descriptor notes + 40 supplemental facts); the nested
route uses the 130-fact domain bound specified above. Legacy provider fact-array
bounds remain 40 each. Never truncate to satisfy a lower storage cap.
The expanded entity bound is 470 (30 visual + 30 supplemental + at most 400
fact-referenced identities + 10 event references), with at most 180 backward
reuse aliases from three earlier rows' 60 local declarations. Direct canonical
model output retains its original 30-entity, 40-fact and 30-reuse bounds; these
larger host bounds accommodate expansion rather than requesting more output.
The existing canonical interpreter validation and atomic Store commit remain
mandatory. The writer cannot discard draft facts as insignificant. People still
need same-frame face evidence for canonical visual association; unknown speakers,
candidate objects and uncertain OCR retain their existing safeguards.

## Corrections, persistence and compatibility

Visual structure is image-only and persisted with Vision, so corrected final speech
reuses it. Packet versions, original capture times, final-only windows, entire-batch
stale checks and chronological projection rules remain unchanged. A separate small
pipeline fix invalidates an in-flight interpretation if corrected final speech
invalidates its retrieved context, even outside its direct last-N-word window.
Ordinary new finals must not continually invalidate unrelated work.

After an image has committed, a speech correction must retain that image's local
anonymous-person and place identities. Store may reuse an earliest committed
`d#` reference only when the image hash, face evidence, complete visual sources
and draft are identical and that reference has the same draft kind. Conflicting
explicit identity or changed draft evidence is rejected atomically. Reuse of an
anonymous person without a face slot is limited to the original frame-local ID;
it does not identify a person in another image. Validated metadata from that
committed image is retained at its original source time, and existing-place
metadata keeps its own provenance. Corrections do not add a second visual
sighting. Supplemental/speech aliases and legacy packets without visual drafts
receive no implicit cross-version identity reuse from this rule.

Keep canonical and source modes available for old packets and comparisons. Do not
silently substitute them when binding-mode evidence is missing: expose the failure
and require an explicit route choice or new observation. Defaults remain unchanged
until the real quality/capacity test supports promotion. No Jev or answering agent.

## Verification and ownership

Root owns contracts, shared face-ID helper, interpreter/config integration and
documentation. Visual-draft agent owns `visual-draft.ts` and its tests. Binding
agent owns `visual-binding.ts` and its tests. Pipeline agent owns context-correction
generation and its focused tests. No UI changes are required for this internal mode.

The first real-photo probe retained all drafted facts but took 25.29/26.95 seconds
for observation and 13.34 seconds for binding two rows. Mandatory repeated null
bindings were unnecessary output; sparse defaults above remove them without
dropping entity or fact coverage. These changes still require new measurements.

The first sparse four-packet speech scenario took 18.25 seconds but failed
semantic acceptance: lecture content linked only to the visible person, and
three room frames created separate places instead of reusing the established
room. The next prompt revision explicitly requires supported place continuity
and relevant event links for finalized speech. Raw speech retention alone does
not establish an event association. It also omits automatic face overrides and
already-drafted location facts to avoid redundant output. Original failed
responses remain unchanged; the revised prompt requires a fresh bounded check.

The revised synthetic scenario passed all 24 semantic checks, including class
content and two stable places, in 20.47 seconds. The subsequent full twelve-photo
run failed: four image responses failed structure validation, and three writer
batches supplied object-match fields for place bindings. Only one photo committed;
the queue emptied through failures, so this run provides no capacity success.

The next bounded fix uses generation constraints rather than accepting those
invalid associations. An image-provider-only schema separates relation facts
(null attribute/value) from single-owner attributes. Its decoder may resolve an
incorrect anchor source index only when the unchanged verbatim quote matches one
unique source in that same image; ambiguous, missing or paraphrased quotes still
reject. Existing domain/persisted validation stays strict. Original provider
responses remain in the benchmark artifacts; stored anchors use resolved indexes,
as in the existing canonical object gate.

The writer's generation schema is specialized to each packet's known draft slots:
place bindings require null object-match metadata, object bindings retain their
ordinary evidence requirements, and automatic face bindings need no output.
Supplemental attributes likewise have exactly one owner. Ambiguous places stay
new with explicit uncertainty. The legacy decoder continues rejecting malformed
outputs, including a place marked merely possible; no uncertainty is silently
discarded to force reuse. These changes need new real calls before promotion.

Verify exact source/face binding, no partial audio in vision, immutable correction
reuse, missing/forward/duplicate refs, ambiguous/generic objects, proper old-person
guards, speech/event history, whole-batch rollback, restart and vector retrieval.
Then run bounded real Terra calls on the known photo examples and the same
keys/person/class scenario, followed by paced five-second arrivals with all new
image/binding calls. Record per-stage service time, queue age, full packet/fact
coverage and manual semantic errors. A passing short test supports only that
bounded workload, never an unmeasured all-day capacity claim.

### Place part/whole clarification after the fourth paced replay

The fourth replay committed all twelve packets, but merged a hallway into an
existing floor entity and a wall into an existing corridor. The image and binding
prompts now reserve place for containing spaces (rooms, corridors, buildings and
outdoor areas). Structural surfaces and fixtures are physical objects within
those spaces. Binding must not merge a part with its containing space or cross
spatial granularity, including legacy entities whose kind is already place;
uncertain associations stay new with their evidence retained.

This is a model instruction, not a deterministic ontology or identity guarantee.
A bounded writer-only regression will preserve the exact fourth-replay call 07
and call 20 inputs and check those part/whole cases, retained surface evidence,
unchanged wrong-target history, and supported same-corridor reuse where present.
Original responses stay unchanged. No extra classifier or label-matching rule is
introduced, and the follow-up requires separate authorization from a capacity run.

### Earlier candidate sightings are evidence, not canonical anchors

The fifth replay exposed a batch boundary mismatch: a later row cited an exact
anchor from an earlier bench sighting, but that earlier sighting was only a
possible match and correctly had no canonical object anchor. The Store will
resolve these packet/ref/index citations against the committed candidate
sighting and its original packet. It must validate the source quote and index,
candidate ownership, and strictly earlier source time. Such a citation remains
unresolved provenance and forces the later sighting to stay a candidate; it must
not create canonical anchors or update canonical location or last-seen state.
Unknown, future and wrong-owner references still reject, and supported canonical
anchor continuity retains its existing checks. Duplicate visual identities still
reject. Verification uses focused regressions and the unchanged failed writer
response on an isolated database, without another model call.

### Close views do not establish another room

The sixth fresh run saved all 24 captures, but close views of the same corridor
table were described as an enclosed small room. The ordered writer repeated that
unsupported interpretation in current location. Update image instructions to
describe the visible area without inferring enclosure, room dimensions, or a new
containing place from a cropped view. When surrounding layout is unavailable,
retain that uncertainty instead of inventing a place entity. The memory writer
must preserve supported prior location when only framing changes and no evidence
supports leaving it. This is a model instruction, not a deterministic room detector.

Verify using fresh observations of the two close table photographs, followed by
one writer batch with the exact pre-close-view corridor context from V6. Keep all
objects and details, original input photos and prior context; do not rewrite the
captions after generation. Limit the probe to two image calls and one writer call,
without retries. The full V6 capacity result remains unchanged.
