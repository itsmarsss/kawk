# Relevant context for ordered memory updates

The v4 writer sent 143,762 input tokens for twelve photos. Much of its input was
the latest 150 entities, including unrelated frame-local people. The v5 workload
still exceeded the five-second arrival budget. Before another throughput run,
replace that broad recency list with relevant context; preserve every stored
image, packet, entity, observation and full descriptor.

Each call receives the current state, non-provisional entities from its source
packet, the latest 24 non-provisional entities as continuity fallback, ongoing
event entities, exact incoming face identities and people present during eligible
final speech. Semantic retrieval queries the scene and **every** observation,
plus finalized speech only; the old first-ten-observations restriction is removed.
Retrieved canonical and candidate entity IDs bring their complete records and
identity anchors into context regardless of recency. No semantic note text or
identity evidence is truncated. Duplicate entity IDs are collapsed mechanically.

Frame-local anonymous people remain stored and retrievable; they are omitted only
from the unsolicited recency/current-scene lists. Exact face matches and retrieved
people remain eligible. Search failure retains the continuity and face/event
context, exposes the error and does not delete memory. The normal correction,
source-time, finality, candidate and identity gates remain unchanged.

Verify retrieval beyond the tenth observation, old and candidate entities outside
the recency window, current-scene and ongoing-event continuity, same-image faces,
final-only retrieval, fallback on embedding failure, and existing correction
tests. Then use recorded full descriptions in a bounded real-writer replay; no
new vision calls are needed for the first capacity measurement. Full live capacity
still needs independent measurement. Automatic bounded recovery is a subsequent
step, not implied by successful context selection.
