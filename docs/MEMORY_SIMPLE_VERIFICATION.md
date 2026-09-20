# Simple image-to-memory verification — September 20, 2026

The application's default is now OpenAI Responses, Terra for image notes and
memory updates, reasoning disabled, `MEMORY_UPDATE_FORMAT=simple`, and no auxiliary
OCR. Codex transport and the earlier structured formats remain R&D options.

The existing API key is loaded from private configuration in the separate agent
worktree, without copying it into this repository. The live server on port 8082
reports `provider=responses`, `updateFormat=simple`, `textReader=off`. The existing
perception lab on port 8081 still supplies InsightFace and speech.

## Fresh model test

Three user-supplied JPEGs at 1224 × 1632 were sent concurrently, with high image
detail and detailed output. No external OCR or image-to-anchor conversion ran.

| Image | Description latency | Description length |
|---|---:|---:|
| IMG_8681, worktable | 18.46 s | 984 words |
| IMG_8687, hand on door lever | 10.00 s | 450 words |
| IMG_8691, classroom | 14.40 s | 728 words |

One memory request processed all three descriptions in 10.41 seconds, creating
12 entities and eight atomic facts. The complete notes were retained independently:
55 observations were stored and indexed by real local MiniLM embeddings. Queries
retrieved the table contents, hand contact and whiteboard description. SQLite
reopen preserved state, entities, observations and exact search results. All four
API requests succeeded on their first attempt.

This is a bounded integration test, not a sustained capture benchmark. Timings
include API/network overhead; isolated server startup/model runtime is unavailable.
Source timestamps were synthetic. Face and speech inputs were unavailable. The
test did not establish real object re-identification or natural conversation fusion.

Manual review found useful detail and appropriate uncertainty, but also omissions:
the table phone time was uncertain and apparently wrong, the door-window geometry
was imprecise, and a distant laptop in the classroom was missed. Faint whiteboard
writing remained unreadable. Full notes help recall; they are not exhaustive or
verified facts. The source photos remain available for inspection.

## Backend verification

All 276 backend tests passed, along with the TypeScript/client build. New tests
cover direct API image bytes and same-photo face context; detailed note retention;
withholding partial speech; AI-assessed same-ID object updates and history;
uncertain candidate isolation and search; batch reuse; and database restart.
The HTTP test passed again after exposing the active format/text reader in config.

Local review evidence: `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-simple-api-20260920/`.
This contains sanitized exact requests, actual responses, packets, writer updates,
stored memory, search results and the isolated test database. The live database
was not populated with this replay.

Earlier route measurements remain in [the R&D report](MEMORY_GENERATION_VERIFICATION.md).
