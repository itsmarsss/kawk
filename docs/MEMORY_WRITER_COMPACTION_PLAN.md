# Preserve evidence while reducing writer work

The fresh V6 run saved all 24 photos, but the serial writer consumed 5.82 seconds
per photo. Context includes the same exact description in multiple observations,
often with different identity links or confidence. Candidate bindings repeatedly
generate an assessment plus three empty arrays. These are representational costs,
not additional evidence or useful reasoning.

Group exact-equal related text under one text field with an ordered list of its
occurrences. Preserve each occurrence's confirmed and candidate entity links,
source start/end times, confidence and visual/speech flag separately. Never merge
confidence, union links into a stronger claim, normalize distinct text, discard
occurrences or modify stored notes. This is only the binding prompt representation.
Each occurrence retains its original retrieval rank so the full ordered list can
be reconstructed. Also encode the image draft's entity/fact/object field names
compactly in the prompt, keeping all rows, quotes, source/owner indexes, attributes,
face slots and confidence unchanged. This is not a reduced visual description.

Allow `match: "possible"` as provider shorthand for exactly
`{assessment:"possible", anchors:[], conflicts:[], competitors:[]}`. Decode to the
unchanged canonical evidence before validation/storage. Conflicts, competitors or
anchor citations require the existing full form. The shorthand cannot express
confirmed identity or be used for a new object, place or face. Existing recorded
outputs and canonical schemas keep their meaning.

Before changing generation, save current prompt/schema pairs for V6 writer05,
writer07 and writer09. Validate round-trip occurrence fidelity, duplicate ordering,
uncertainty/association separation, and unchanged decoder/Store outcomes for compact
versus explicit candidate evidence. Then run at most six fresh writer calls: one
baseline and one compact call on each exact saved packet/context input, with
alternating order, one attempt and 90-second per-call cap. Compare input/output
tokens, total/model timing, validation failures and returned bindings. This small
paired probe cannot prove sustained capacity or eliminate provider variance. No
image calls, live data, Jev, answering agent or UI changes belong to this step.
