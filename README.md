# pi-magpie-provider

[magpie](https://usemagpie.ai) as a [pi](https://pi.dev) provider: a local or remote (LAN, Tailscale) magpie gateway with its live catalog — context window, output limit, image input, reasoning effort levels, and the native API each model speaks.

## Install

```bash
pi install npm:pi-magpie-provider
# or load a local checkout
pi -e ./pi-magpie-provider
```

Requires a running magpie (`magpie serve`, or the desktop app).

### omp (oh-my-pi)

omp is a fork of pi with its own config and plugin dirs, and its provider API differs: it has no
`refreshModels` — the extension therefore also registers `fetchDynamicModels`, which omp calls
instead (omp caches the catalog itself, SQLite with a 24h TTL).

```bash
omp plugin install ./pi-magpie-provider
```

omp reads `magpie.json` from `~/.omp/agent/magpie.json` (pi reads `~/.pi/agent/magpie.json`), so
copy the file when both runtimes share one gateway.

## Configure

The provider id is always `magpie`. With no config file it talks to the local gateway: `http://127.0.0.1:3425` with the key `magpie-pi` (the local gateway takes any key and uses it to name the app in Usage).

To use another gateway — another machine on the LAN, a Tailscale host, a NAS — create `magpie.json` in pi's agent directory (`~/.pi/agent/magpie.json`, or `$PI_CODING_AGENT_DIR/magpie.json`) and run `/reload`:

```json
{
  "baseUrl": "http://192.168.1.20:3425",
  "apiKey": "sk-magpie-…"
}
```

- `baseUrl` is the gateway origin; a trailing `/v1` or `/` is accepted.
- `apiKey` is a gateway key (Settings → Share on local network). The local machine also accepts the default.
- Either key can be omitted to keep the local default.

## What comes from the catalog

Every `GET /v1/models` refresh maps each entry onto a pi model:

- `context_window` → `contextWindow`, `max_output_tokens` → `maxTokens`.
- `modalities.input` → text or text+image.
- `supported_reasoning_levels` → `reasoning` plus a `thinkingLevelMap` that hides levels the model does not have and maps `off` to `none` where offered.
- `native_endpoints` → a model that speaks `/v1/responses` is asked directly (`openai-responses`) so magpie relays instead of translating; everything else goes over `openai-completions`.
- Unknown metadata falls back to a 128K window and a 16K output limit.

The catalog refreshes when pi refreshes model catalogs (startup, opening the model picker) and is not persisted: a gateway that is down shows no models until the next successful refresh.

## Limits

- `/v1/models` carries no prices, so pi reports every magpie call as free.
- Audio, video and PDF inputs are not exposed to pi; only text and image are.
- Provider ids share pi's provider namespace: do not point another live-model package (for example `pi-live-models`) at `magpie`, or its cached catalog competes with this one.
- A `providers.magpie` entry in `models.json` is ignored; configure this extension through `magpie.json`.
- Session-affinity headers are sent only under pi; omp does not emit them, so magpie's Usage session attribution is pi-only.

## Development

```bash
vp install
vp check
vp test
vp run build
```
