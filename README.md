# htn2026

The product specification is in [AGENTS.md](AGENTS.md). GitHub's default branch
is `main`; William's work is on `chud3`.

## Camera and live speech tests

The standalone [perception lab](tools/perception_lab/README.md) provides browser
pages for local InsightFace enrollment/recognition and Baseten streaming Whisper.
It is separate from the full product hub. After starting its server, open
http://127.0.0.1:8081/ and choose Faces, Speech, or Devices.

The interface is authored with Claude Code Fable 5.1. Camera and microphone
capture start only when you click Start. Enroll consenting participants.
