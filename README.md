# pi-magpie-provider

[magpie](https://usemagpie.ai) as a [pi](https://pi.dev) provider: a local or remote (LAN, Tailscale) magpie gateway with its live catalog — context window, output limit, image input, reasoning effort levels, and the native API each model speaks.

## Install

```bash
# npm
pi install npm:@jeremy-hibiki/pi-magpie-provider

# or straight from GitHub
pi install git:github.com/Jeremy-Hibiki/pi-magpie-provider
```

Requires a running magpie gateway (`magpie serve`, or the desktop app).

### omp (oh-my-pi)

omp is a fork of pi with its own config and plugin dirs, and its provider API differs: it has no
`refreshModels` — the extension therefore also registers `fetchDynamicModels`, which omp calls
instead (omp caches the catalog itself, SQLite with a 24h TTL).

```bash
omp plugin install npm:@jeremy-hibiki/pi-magpie-provider
```

omp reads `magpie.json` from `~/.omp/agent/magpie.json` (pi reads `~/.pi/agent/magpie.json`), so
copy the file when both runtimes share one gateway.

## Use the models

On load the extension registers the provider `magpie`; every entry in the gateway's
`GET /v1/models` becomes a selectable model named `magpie/<id>` — for example
`magpie/zhipu/glm-5.3`.

- Pick it in the `/model` selector, or run `pi --model magpie/<id> …` / `omp --model magpie/<id> …`.
- pi refreshes the catalog on TUI startup and every time the model selector opens; successful
  refreshes are persisted, so `--print` and `--offline` runs still see the last known catalog.
- omp refreshes on demand and caches for 24h; run `omp models refresh` to force a refetch.

Typical setups:

- **One gateway for every agent** — point pi, omp, and other apps at the same magpie so Usage
  attribution, model inventory, and keys live in one place.
- **Shared LAN/Tailscale gateway** — a workstation or NAS runs `magpie serve`; laptops use the
  same catalog without holding the upstream provider keys locally.
- **Local zero-config** — the desktop magpie app on `127.0.0.1:3425` works with no `magpie.json`
  at all.

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
