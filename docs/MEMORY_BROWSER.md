# Inspecting memory

Use **Memory** in the merged app at `localhost:8082`. It is an inspection view of
durable records; opening it, filtering or paging never records audio/video or
wakes an agent. Live capture can continue while this view is open.

| Category | What it contains | Time shown |
|---|---|---|
| Observations | Source-backed scene/speech facts, with confidence and candidate identities | Source interval |
| Photos | All retained camera frames, including pending/failed interpretations | Capture time |
| Speech | Transcripts across every session, latest revision by default | Utterance interval |
| Entities | Active people, objects, places and events, plus attributes and evidence | First observed; last seen in details |
| State | Recorded location, activity and scene summaries | Source time |
| Agent facts | Agent facts, summaries and graph entity/relation claims, with cited source text | Recorded time |
| Reminders | Time/person reminders in every retained state | Recorded time; due time in details |

Text filters use literal matching, with optional date bounds. The history option
includes older transcript revisions and superseded observation/state/agent fact
versions. Deleted identities and invalidated agent claims stay hidden from active
memory, while the retained original photos/transcripts remain inspectable.
These are different layers of memory; their combined counts are not a count of
unique real-world events.

**Load more** reaches beyond the old dashboard's recent-100 frames and recent-30
entities. Each category uses its own cursor. New inserts do not shift later pages;
refresh to include new arrivals. Corrections and removals still take effect, so
counts can change while browsing. An all-category view merges the loaded pages;
choose one category to walk its complete timeline in order.

The read-only endpoints are:

```text
GET /api/memory/browse?kind=observations|captures|transcripts|entities|state
GET /api/agent/memory/browse?kind=facts|reminders
```

Both accept `query`, `from`/`to` (epoch milliseconds), `limit` (1–100, default 40),
`cursor`, and `history=true|false`. Entities also accept `entityKind` with
`person|object|place|event`. Responses contain `kind`, `items`, `total`, and
`nextCursor`. Cursors are bound to the filters; changing a filter starts a new
page sequence. Agent inspection remains authenticated through the same-origin
server proxy; its owner and credentials never come from browser query parameters.

The existing source/detail endpoints remain available: `/api/frames/:id`,
`/api/packets/:id`, `/api/packets/:id/history`, and `/api/entities/:id`.
An accepted frame can exist before its interpreted packet. Raw frame inspection
does not establish that an old identity or corrected claim is still current.

This view complements the ambient experience: three perception streams feed
Jev automatically, with recording independent of its decision. **Debug → Manual
operation** is an optional explicit input, not a prerequisite for activation.
