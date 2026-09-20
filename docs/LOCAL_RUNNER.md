# Local hackathon runner

2026-09-20 UTC, branch `chud3-ai-agent`. The user explicitly requested replacing
Docker with trusted local execution in `/tmp` directories. Docker code, build
scripts, image settings, per-call RPC and container dependencies have been removed.

## Wiring and setup

- `KAWK_RUNNER=local` is the default and is set in the ignored local `.env`.
  `disabled` remains available for memory-only operation.
- Each task receives a fresh `/tmp/kawk-*` working directory. Code executes directly
  through `/bin/sh -c` as the host user. The returned handle includes the workspace.
- Playwright 1.63.0 launches local Chromium on first use. One browser process is
  reused for later tasks, with separate task contexts, cookies and local storage.
  HTTP(S) navigation includes localhost. There is no Docker startup or `docker exec`.
- Tool receipts cover execute/poll/cancel, workspace files and durable export,
  browser navigation/state/screenshot/click/type/select/key/wait/tab/upload/download.
  Code and browser share each task's workspace. Interactive browser actions still
  use the existing `KAWK_BROWSER_INTERACTION` option.

```sh
cd agent
bun install --frozen-lockfile
bun run browser:install
bun start
```

The pinned Playwright package and matching browser replace the prebuilt runner image.
The browser was installed and tested locally. See the official
[browser installation](https://playwright.dev/docs/browsers) and
[context reuse](https://playwright.dev/docs/browser-contexts) documentation.

## Lifecycle

Polling retains incremental stdout/stderr and completion status. Two active commands
per task, 30-second default / 60-second maximum command deadlines, a 1 MB output cap
and 32k-character poll pages keep existing execution bounds. Process cancellation,
task abort and normal cleanup terminate the owned process group. Browser cancellation
closes only the affected task context. Reaping removes only this runner's ended tasks.
Shutdown disposes all remaining contexts/processes/workspaces and closes Chromium.

The directory is workspace organization, **not an OS sandbox**. Commands can access
host files and network. Provider credentials are not automatically copied into child
environment variables; that is not filesystem isolation. File tools resolve paths
within the task workspace, while arbitrary code has host-user access.

SQLite evidence, memories, tasks and tool receipts remain durable. Local process
handles and browser contexts do not reattach after restart. Uncertain interrupted
effects retain the existing no-automatic-replay behavior. An abrupt daemon crash can
leave temporary directories or child processes; normal shutdown cleanup was tested.
No CPU/memory container limits or independent container lifetime are claimed.

Generated files must use `export_file` before the task ends to survive cleanup.
Exports are copied into the artifact directory with filename/MIME metadata in SQLite;
authenticated `/v1/artifacts/:id` serves them as downloads. Older PNG artifacts are
preserved by the additive metadata migration. Uploads, downloads and exports support
files up to 10 MiB. `browser_upload` attaches files; the agent must submit and inspect
the site's actual receipt before reporting success. `browser_download` waits for the
Playwright download event and saves completed bytes in the task workspace.

Long-page `browser_state` queries return literal matching excerpts to keep cited
evidence inside review limits. Browser waits support visible/hidden states, so agents
can wait for observed loading text to disappear without guessing confirmation wording.

## Verification and timing

The initial local-runner migration passed **63 tests**; the current suite passes
**78 tests**, including file transfers, durable export after cleanup/restart, popup
forms and long-page evidence. See [live agent workflows](BROWSER_FILE_VALIDATION.md).
The original six real local runner checks require no Docker or API credentials:

- Local workspace files, Unicode output, polling and task separation.
- Cancellation, task abort, timeout and bounded process output.
- Actual localhost network access without inherited provider-key environment variables.
- Real Chromium navigation, typing, clicking, PNG screenshots and task storage separation.
- Aborting a stalled navigation while another task's browser remains usable.
- Reaping scope, active process shutdown and directory cleanup.

The [live run](../agent/data/perf/2026-09-20T04-00-13-103Z/REPORT.md) used actual local
tools, OpenAI `gpt-5.6-sol` with reasoning `none`, and Jev; fallback was disabled.

| Operation | Previous Docker sample | Local sample |
|---|---:|---:|
| First `run_code` call (launch/dispatch) | 566 ms | 11 ms |
| `poll_process` call | 109 ms | 3 ms |
| First `browser_goto` (launch + navigation) | 958 ms | 280 ms |

These are individual tool spans, not distributions or pure browser-launch benchmarks.
The browser sample includes loading `example.com`; timing varies with network/cache.
Code completed with the correct sum of squares, and the browser reported the real page:
both live execution tasks passed. Their complete agent responses took 7.40s and 4.29s;
model calls remain a separate source of latency.

A recall control retrieved the correct notebook evidence but was suppressed by Jev
delivery review: **2/3 end-to-end cases passed**. That known classifier variability
remains documented; this migration did not change Jev's rules or delivery thresholds.
