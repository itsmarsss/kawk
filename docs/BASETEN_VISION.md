# Optional Qwen vision on Baseten

The image-to-memory pipeline has a real, opt-in Baseten adapter for
`Qwen/Qwen3.5-4B`. **The default and current demo remain OpenAI GPT Terra.** Adding
this adapter does not deploy, activate, warm up, or call a Baseten service.
Credentials alone never activate it, and there is no automatic provider fallback.

## Configuration

The existing configuration remains unchanged:

```ini
MEMORY_MODEL_PROVIDER=responses
MEMORY_MODEL=gpt-5.6-terra
MEMORY_UPDATE_FORMAT=simple
```

For a future, explicitly enabled experiment, a standalone memory process can use:

```ini
MEMORY_MODEL_PROVIDER=responses
MEMORY_MODEL=gpt-5.6-terra
MEMORY_VISION_PROVIDER=baseten
MEMORY_VISION_MODEL=Qwen/Qwen3.5-4B
BASETEN_VLM_MODEL_ID=<your Baseten model ID>
BASETEN_VLM_DEPLOYMENT_ID=<your deployment ID>
BASETEN_VLM_MAX_TOKENS=2048
```

Supply `BASETEN_API_KEY` and `OPENAI_API_KEY` through private configuration. Use
the authorized `h100-permanent` / Team 2 allocation; never substitute reserve
credits. Omitting the deployment ID selects the model's production environment.
Model IDs and deployment IDs are validated before any requests are made.

`KAWK_BASETEN_ENABLED=0` rejects Baseten vision selection at startup. The integrated
`agent/scripts/demo-stack.ts` launcher explicitly sets this flag to zero. This
change does not alter that launcher, any private environment, or running services.
The standalone service does not load `.env.example` automatically.

With Baseten selected, only image interpretation changes. The text-only memory
writer stays on `MEMORY_MODEL_PROVIDER` and `MEMORY_WRITER_MODEL` (falling back to
`MEMORY_MODEL`). Unset `MEMORY_VISION_PROVIDER` and `MEMORY_VISION_MODEL` to restore
the existing shared-provider behavior. The vision provider also accepts `responses`
or `codex` for the existing transports.

## Request and evidence handling

The adapter targets a custom vLLM deployment whose `predict_endpoint` is
`/v1/chat/completions`. Baseten's HTTPS `/predict` endpoint forwards the request;
authentication uses `Authorization: Api-Key ...`. See the
[Baseten custom-server endpoint mapping](https://docs.baseten.co/development/model/custom-server#endpoint-mapping).
The earlier Qwen experiment used this serving contract; the adapter does not use
Baseten's separate model-library text-agent endpoint.

Each request sends the exact integrity-checked JPEG, the existing detailed scene
prompt, and matching face context. The prompt preserves unknown speakers and
visual uncertainty. Thinking and streaming are disabled; a strict JSON schema
requests `scene`, `observations`, `readableText`, and `uncertainties` in simple mode.
Adjust the token ceiling to fit the deployed model's context budget; the default
is 2,048 output tokens, not the GPT path's larger output budget.

Replies go through the same host-side schema/evidence checks as GPT. Incomplete,
truncated, tool, refusal, malformed and oversized responses cannot become memory
observations. Existing bounded retry/timeout policy applies. HTTP error bodies and
credentials are not copied into error messages or telemetry. Redirects are rejected.

Per-operation latency logs record `baseten` plus the configured Qwen model for
vision, and the actual writer provider/model for memory updates. `/api/config`
returns the same split without credentials. Availability is not inferred from
configuration, and no health request is made merely by selecting a provider.

## Verification and limits

Offline integration tests in `memory/test/baseten-vision.test.ts` cover dormant
defaults, explicit vision routing, exact image/face payloads, GPT single/batch
writer routing, credential separation, provider telemetry, disabled/missing config,
truncation/schema failures, bounded output, retry handling and timeouts.

```sh
cd memory
npm run check
node --import tsx --test test/baseten-vision.test.ts
```

These tests inject provider responses; they do not prove current deployment
availability or Qwen caption accuracy. The adapter has not been exercised against
live cloud inference in this change because activation was explicitly excluded.
Previous separate Qwen-on-Baseten experiments do not establish that the current
demo uses Qwen. Describe it as an optional integrated backend until a real run is
enabled and verified.
