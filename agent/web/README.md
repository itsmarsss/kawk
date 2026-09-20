# KAWK testing page (agent/web)

Plain static page served by the Bun agent at `http://127.0.0.1:8091/`. It connects by itself:
on load it POSTs `/v1/client/session` with an empty body and no Authorization header, the agent
sets an HttpOnly cookie for the local page, and the page then polls status and opens the
notification stream. If the agent is down or the session goes stale it shows
"Agent unavailable — retrying…" and retries every 2 s. No token is ever typed or stored.

Contract: `../../docs/PWA_CONTRACT.md`. Validation and results: `../../docs/PWA_VALIDATION.md`.

Build from `agent/` (no new dependencies):

```sh
bun build web/app.ts --outfile web/app.js --target browser --format esm
node_modules/.bin/tsc -p web/tsconfig.json
bun web/validation/probe.ts   # Playwright + mock API on a random port
```

`app.js` is the committed bundle; rebuild it after editing `app.ts`. Bump `VERSION` in `sw.js`
when shell assets change so open tabs pick up the update.
