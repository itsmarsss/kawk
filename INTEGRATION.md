# C + D integration — William / chud3

Current user correction: finish **Lane C (local perception)** and **Lane D (cloud
adapters/deployment)**, plus the existing testing UI; push everything to `chud3`.
Latest user direction: build **both for R&D** and compare smoothness. The brief
cloud-only proposal is superseded. Measurements must name the differing local
and cloud models and distinguish first use from warm behavior.
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

- Lane C merged; genuine local YOLO-World, buffalo_l, Whisper and Silero fixtures
  pass. CLIP is explicitly pinned; ONNX Runtime 1.22.0 avoids the 1.30 native
  teardown crash observed with the combined model runtime.
- Integrator owns typed config/factories, injected fixture references, comparison
  runner and lab backend routing. Claude Code owns static UI changes.

- Local face and real Baseten streaming Whisper testing UI authored by Claude
  Code Fable 5.1; fixture browser tests verify enrollment, recognition,
  transcription, restart, and cancellation cleanup.
- GitHub default `main`; active integration branch `chud3`.
- Existing Whisper H100 deployment `wdlg2oe3/wldeyy7` is working; do not stop it.
- Research: H100 warm speech delays are essentially unchanged from RTX.
- Both local/cloud selectors now pass fixture browser checks for objects, faces
  and speech. Matched Mac M5 Pro/H100 warm medians: faces 32.9/181.8 ms (n=20),
  speech final after offset 1,835/552 ms (n=3), objects 44.9/842.1 ms (n=3).
  Objects share one image and three concepts but compare YOLO-World with SAM;
  speech compares Small/int8 with Large-v3. These are small latency samples,
  not an accuracy study. Cloud face's 9.63-second outlier remains in evidence.
- SAM 3.1 public deployment w7m74v6w/w55ov5p returned real typed boxes through
  both the adapter and browser. It is explicitly windowed; IDs reset per update,
  so it does not meet persistent incremental tracking. First native inference
  took about 11.6 seconds and required a reconnect after the 10-second deadline.
- Final integration checks: 129 Python tests, Ruff/Pyright clean, 20 UI lifecycle
  assertions. No live TypeSafe measurements without its key.

## Blocked

- No TypeSafe key known yet. Jev may be code/contract tested without live latency
  verification; report this limitation if it persists.
