# synapse

OpenAI-compatible LLM proxy with provider fallback chain.

Synapse sits between your application and one or more LLM providers, routing requests through a prioritized chain. If the first provider fails, it automatically falls back to the next. It exposes a standard OpenAI-compatible API so clients need no modification.

## Features

- **Provider fallback chain** -- priority-based routing with automatic failover on upstream errors
- **Health tracking** -- consecutive failure counting with configurable thresholds and exponential cooldown; auto-recovery when cooldown expires
- **Streaming** -- SSE passthrough with idle timeout detection for stalled streams
- **Request logging** -- buffered JSONL writes with size-based rotation
- **Configuration** -- JSON config file with `${ENV_VAR}` interpolation
- **Model aggregation** -- `/v1/models` returns a deduplicated list from all healthy providers

## Quick start

```sh
# install dependencies
bun install

# start with defaults (proxies to Ollama at localhost:11434)
bun run start
```

Synapse listens on port `7750` by default and forwards requests to a local Ollama instance.

```sh
# verify it's running
curl http://localhost:7750/health

# send a chat completion
curl http://localhost:7750/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3", "messages": [{"role": "user", "content": "hello"}]}'
```

## Configuration

Synapse loads configuration from `~/.config/synapse/config.json`. If no file exists, it uses defaults (single Ollama provider at `localhost:11434`).

### Example config

```json
{
  "port": 7750,
  "providers": [
    {
      "name": "ollama",
      "baseUrl": "http://localhost:11434/v1",
      "models": ["*"],
      "maxFailures": 3,
      "cooldownSeconds": 60
    },
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "models": ["gpt-4", "gpt-4o", "gpt-3.5-turbo"],
      "maxFailures": 3,
      "cooldownSeconds": 120
    },
    {
      "name": "groq",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKey": "${GROQ_API_KEY}",
      "models": ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
      "maxFailures": 5,
      "cooldownSeconds": 30
    }
  ]
}
```

Providers are tried **in order** -- first provider in the list has highest priority.

### Provider fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | -- | Unique display name (used in logs and health endpoint) |
| `baseUrl` | yes | -- | Base URL including version prefix, e.g. `http://localhost:11434/v1` |
| `apiKey` | no | -- | Bearer token. Supports `${ENV_VAR}` interpolation |
| `models` | yes | -- | Models this provider serves. Use `["*"]` to match any model |
| `maxFailures` | no | `3` | Consecutive failures before marking unhealthy |
| `cooldownSeconds` | no | `60` | Seconds to wait before retrying an unhealthy provider |

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNAPSE_PORT` | Override the listening port (highest precedence) | `7750` |
| `SYNAPSE_CONFIG_PATH` | Override the config file path | `~/.config/synapse/config.json` |

Any string value in the config file supports `${ENV_VAR}` interpolation. If a referenced variable is not set, loading fails with an error.

## API

All endpoints return OpenAI-format responses and errors.

### `POST /v1/chat/completions`

Proxy a chat completion request through the provider fallback chain. Supports both streaming (`"stream": true`) and non-streaming requests.

- Requires a JSON body with a `model` field
- Max body size: 1 MB
- On 2xx-4xx from a provider: returns the response immediately (client errors are not retried)
- On 5xx or network error: falls back to the next provider
- If all providers fail: returns 502

### `GET /v1/models`

Returns an aggregated, deduplicated model list from all healthy providers. If multiple providers serve the same model, the first provider in config order wins.

### `GET /health`

Returns service health and per-provider status. HTTP 200 if all providers are healthy, 503 if any are degraded. Includes a reachability check (cached for 30 seconds).

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "providers": [
    {
      "name": "ollama",
      "healthy": true,
      "reachable": true,
      "consecutiveFailures": 0
    }
  ]
}
```

## How routing works

For each chat completion request:

1. Iterate providers in config order
2. **Skip** if the provider's model list doesn't match the requested model (unless `["*"]`)
3. **Skip** if the provider is currently unhealthy (cooldown hasn't expired)
4. **Forward** the request to the provider
5. On success or 4xx client error: return the response, record success in health tracker
6. On 5xx or network/timeout error: record failure, try the next provider
7. If all providers exhausted: return 502 with details of what was attempted and skipped

### Health tracking

- Providers start healthy with zero failures
- Each failure increments a consecutive failure counter
- When failures reach `maxFailures`: provider is marked unhealthy, cooldown timer starts
- If still failing while unhealthy: cooldown is extended
- On success: counter resets to zero
- Auto-recovery: when cooldown expires, the provider is automatically eligible for routing again

## Logging

Request logs are written as JSONL to `~/.config/synapse/logs/requests.log`.

- Buffered with 1-second flush interval
- Size-based rotation at 50 MB (keeps current + 1 rotated file)
- Each entry records: timestamp, model, provider, latency, status, streaming flag, attempted/skipped providers, and error (if any)

## Development

```sh
bun install              # install dependencies
bun run start            # start the server
bun run test             # run tests
bun run typecheck        # type check
bun run lint             # lint with oxlint
bun run format           # format with biome (auto-fix)
bun run format:check     # check formatting
bun run validate         # run all checks (typecheck + lint + format + test)
```

### Tooling

- **Runtime**: [Bun](https://bun.sh) -- runs TypeScript directly, no build step
- **Type checking**: TypeScript (strict mode)
- **Formatting**: [Biome](https://biomejs.dev)
- **Linting**: [oxlint](https://oxc.rs)
- **Git hooks**: [Husky](https://typicode.github.io/husky/) -- pre-commit runs `bun run validate`

### CI/CD

- **CI** runs on all PRs and pushes to `main`: typecheck, lint, format check, tests
- **Release** runs automatically after CI passes on `main`: computes semver bump from commit markers, creates a git tag and GitHub release with a source tarball

Version bumps:

```sh
bun run version:bump minor   # next release will be a minor bump
bun run version:bump major   # next release will be a major bump
# patch bumps happen automatically if no marker is found
```
