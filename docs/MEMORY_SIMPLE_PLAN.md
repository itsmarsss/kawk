# Detailed image notes, then AI memory updates

William's September 20 direction replaces the main-path OCR/visual-anchor/binding
experiments with two ordinary AI calls. Keep the experiments available for R&D.

1. Every scheduled photo goes directly to OpenAI vision. Ask for detailed scene
   notes covering foreground/background, individual objects and locations, visible
   interactions, people, readable text and uncertainty. Retain ordinary details
   even when their future significance is unknown. Do not impose a short caption
   target or have this call generate database IDs/anchor schemas. Same-photo face
   metadata may label visible people; neither faces nor a still photo prove speech
   attribution or temporal motion. No auxiliary OCR in the default path.
2. The memory AI receives the complete notes, same-photo faces, eligible finalized
   transcript words, current state and retrieved memories. It returns additive
   state/entity/fact/event updates with existing IDs. For an existing visible
   physical object, its own simple same-instance/possible assessment and explanation
   determine reuse; remove the handcrafted marker gate from this path. Preserve
   possible matches separately without moving confirmed object projections.
3. Keep basic data validation, source times/finality, current face UUID checks,
   ordered commits, correction invalidation, complete raw-note retention, SQLite
   and vector retrieval. No Jev or answering agent. AI interpretations remain
   interpretations, with original photos available for later inspection.

Use `simple` as the application's default update format. Retain canonical/source/
binding options solely for existing R&D. For direct Responses requests, use the
selected image-capable OpenAI model, high image detail, reasoning disabled and
detailed image output. The API key stays in the user's existing private config;
never put it in prompts, logs or the repository.

Verify direct API image transport and retention of detailed notes; AI-assessed
object reuse, uncertain sightings, same-ID updates and history; existing timestamp,
face, speech, correction and restart invariants. Then run bounded direct API calls
on representative supplied photos and inspect the resulting descriptions and
stored notes. Report actual provider/model, dimensions, sample sizes and latency;
do not claim five-second completion or literally perfect image coverage.
