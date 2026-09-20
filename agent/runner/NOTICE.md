# Local runner

The former Docker runner was removed at the user's request on 2026-09-20.
Implementation: [`src/runner.ts`](../src/runner.ts).
Behavior, setup and measurements: [local runner](../../docs/LOCAL_RUNNER.md).

Browser automation uses pinned `playwright@1.63.0` and its matching Chromium.
It reuses one browser with separate task contexts, following the official
[Playwright context model](https://playwright.dev/docs/browser-contexts).
Install the matching browser with `bun run browser:install`, following
[Playwright browser installation](https://playwright.dev/docs/browsers).

Host processes use the standard [`node:child_process`](https://nodejs.org/api/child_process.html)
API through Bun. A task's `/tmp` directory is its working directory, not an OS
security boundary; host files and network remain accessible.
