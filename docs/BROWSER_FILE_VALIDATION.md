# Browser and file validation — 2026-09-20

Branch `chud3-ai-agent`. These checks use the actual custom KAWK harness, OpenAI
`gpt-5.6-sol` with reasoning `none`, real Jev, local code execution and Playwright
Chromium. Baseten remains disabled. The model chooses its own tool calls.

## Changes

Added browser uploads/downloads, native select and keyboard actions, bounded waits,
popup/tab handling, accessibility snapshots and observed control selectors. Code
and browser transfers share each task's temporary workspace. `export_file` preserves
deliverables in authenticated artifacts after task cleanup, including filename and
MIME metadata. Transfers/exports are limited to 10 MiB per file.

Long-page literal queries return focused evidence. Agents now wait for observed
loading indicators to disappear instead of guessing future confirmation text.
The location rule asks for a city when none is established: the host timezone is
clock context, not evidence of the wearer's physical location.

These are adapters around Playwright and the existing runtime. The installed
`openai` package handles API requests, streaming and tool-call responses; the
custom KAWK harness owns scheduling, tool execution, memory and review. This is
neither Pi nor the OpenAI Agents SDK. See the official
[OpenAI libraries](https://developers.openai.com/api/docs/libraries) and
[function-calling workflow](https://developers.openai.com/api/docs/guides/function-calling).

## Latest complete live run

`agent/data/browser-perf/2026-09-20T07-03-39.334Z/`: **6/7 end-to-end cases passed**.
Time is HTTP input to receipt of the result over SSE, including classification,
model calls, tools and delivery review. Two cases ran concurrently. These are
individual samples, not latency percentiles.

| Task | Result | Time to SSE | Model steps |
|---|---|---:|---:|
| Create CSV, calculate totals with code, export JSON | Passed; total 94.4, largest line keyboard | 13.237 s | 5 |
| Create and upload two files, select category, verify receipt | Passed; server received exact bytes | 12.525 s | 5 |
| Browser download → code analysis → browser upload → export | Passed; uploaded and exported JSON verified | 22.138 s | 10 |
| Search, compare stock/prices, fill and submit reservation | Correct submission; **notification suppressed** | None; task ended at 22.970 s | 9 |
| Rejected upload → corrected CSV → confirmed receipt | Passed; one rejection and one successful import | 23.106 s | 10 |
| Read public Python documentation, create cited note, export | Passed; saved file and delivered download link | 15.469 s | 5 |
| Ask weather without supplying a location | Passed; asked which city, no location guess | 2.153 s | 1 |

The form case reserved exactly one in-stock Trail pair, Blue, quantity 1, name
Demo Tester, newsletter unchecked, total $49. The page confirmed reference
`DEMO-1`. Jev scored the first completion 0.70 supported and a shorter, directly
cited confirmation 0.62; both fell below the unchanged 0.8 delivery threshold.
The correct action therefore did not produce a user-visible SSE notification.
This is an unresolved delivery-review reliability issue, not a passing case.

Model calls accounted for 11.151–22.203 seconds across the six browser/file tasks.
All tool spans combined were 0.272–0.776 seconds per task in this run. Review was
0.240–0.461 seconds and is nested inside those tool spans; do not add it again.
Most latency now comes from sequential model turns, rather than browser startup.

## Earlier runs and regression checks

- `06-57-47.718Z`: 6/7; form passed in 18.635 s, public-note delivery failed despite
  a correct exported file. Guessed success/error waits added 10–20 seconds to some
  upload workflows. Original traces are preserved.
- `07-00-54.421Z`: public-only 0/1; bounded review evidence omitted the relevant
  deep-page text. Added focused source reads and clearer export receipts.
- `07-02-41.761Z`: targeted upload/public/location 3/3, at 12.413/16.593/4.399 s.
- Real Jev regression: 6/6 expected decisions, covering unsupported Toronto weather,
  a missing-city question, fabricated/actual exports, wrong dates and unverified
  speaker claims. Evidence: `agent/data/browser-perf/review-regression.json`.
- `cd agent && bun run check`: **78 tests passed**, plus backend and web TypeScript
  checks. Real Chromium tests cover transfers, popup forms, long-page excerpts,
  filename/MIME preservation, owner separation, and exports surviving workspace
  cleanup and server restart.

## Scope and reproduction

The upload/reservation sites are controlled local fixtures, with actual multipart
requests and server-side byte/field assertions. Only the Python documentation task
uses a public site. Export assertions download the actual artifact after task
workspace cleanup. No real purchases or external-account changes were made.

```sh
cd agent
bun run check
bun scripts/browser-perf.ts --live
# Optional targeted replay:
bun scripts/browser-perf.ts --live --only upload,public,location
```

The live command uses existing ignored local OpenAI/Jev credentials and writes
private reports, traces and exported files under `agent/data/browser-perf/`.
Live runs incur API usage. Local interactive browser tools require
`KAWK_BROWSER_INTERACTION=1`; this is enabled in this machine's ignored `.env`.

Not established by these checks: authenticated third-party workflows, CAPTCHA
handling, arbitrary websites, OS push delivery, microphone transcription, live
faces, or glasses hardware. Browser reasoning currently uses DOM/accessibility
text; screenshots are saved artifacts, not model vision input. Process and browser
handles do not survive a runtime restart. Jev false negatives remain possible.

## Toronto and speech logs

The real runtime received “hi what is the weather” and incorrectly assumed
Toronto from `America/Toronto`, inherited from macOS because `KAWK_TIME_ZONE` was
unset. Delivery review rejected the answer, but task details retained its attempted
text. The updated location prompt passed three live weather clarification checks.

`KAWK_BASETEN_ENABLED=0` remains set because the user reported the Baseten outage
and requested testing without it. Consequently the running service reports
`speechConfigured=false` and `faceConfigured=false`; OpenAI scene descriptions
remain configured. No replacement speech provider has been wired in this pass.
