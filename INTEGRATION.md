# C + D integration — William / chud3

Current user correction: finish **Lane C (local perception)** and **Lane D (cloud
adapters/deployment)**, plus the existing testing UI; push everything to `chud3`.
Lane A world/memory/task implementation and Lane B device transport/display are
outside this change. The interfaces below are the shared integration boundary.

## Contract-change requests

Frozen by the integrator: `contracts/percepts.py`, `contracts/decisions.py`, the
three perception `base.py` files, `vocab_proposer/base.py`, and `gate/jev_base.py`.
Use `SamBackend.start_session/push_frame/add_concept/end_session`,
`FaceBackend.embed_faces`, `SttBackend.stream`, and `JevBackend.decide` as typed.
All boxes are absolute pixels in the SENT dimensions. Face vectors are 512d unit
vectors from buffalo_l. Partial/final transcript IDs must survive revisions;
namespace IDs across restarted connections. Whisper word times are relative to
`t_start_hub`. Ask integrator before changing contracts, Makefile, or pyproject.

## Done

- Local face and real Baseten streaming Whisper testing UI authored by Claude
  Code Fable 5.1; fixture browser tests verify enrollment, recognition,
  transcription, restart, and cancellation cleanup.
- GitHub default `main`; active integration branch `chud3`.
- Existing Whisper H100 deployment `wdlg2oe3/wldeyy7` is working; do not stop it.
- Research: H100 warm speech delays are essentially unchanged from RTX.

## Blocked

- No TypeSafe key known yet. Jev may be code/contract tested without live latency
  verification; report this limitation if it persists.
