import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";

type PiChatModelConfig = Extract<NonNullable<ProviderConfig["models"]>[number], { type?: "chat" }>;

/**
 * Model config across both runtimes: pi reads `thinkingLevelMap`, omp (oh-my-pi) reads `thinking`.
 */
type ChatModelConfig = PiChatModelConfig & {
  thinking?: { mode: string; efforts: string[] };
};

/** Provider registration across both runtimes: pi calls `refreshModels`, omp calls `fetchDynamicModels`. */
export type ProviderRegistration = ProviderConfig & {
  fetchDynamicModels?: (apiKey: string | undefined) => Promise<ChatModelConfig[]>;
};

const PROVIDER_NAME = "magpie";
const CONFIG_FILE = "magpie.json";
const LOCAL_URL = "http://127.0.0.1:3425";
/** Local magpie takes any key; the key names the app in its Usage page. */
const LOCAL_KEY = "magpie-pi";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** `magpie.json`: which gateway pi talks to. Both keys fall back to the local gateway. */
export interface MagpieConfig {
  baseUrl?: string;
  apiKey?: string;
}

/** The fields of magpie's `GET /v1/models` this extension reads. */
export interface GatewayModel {
  id: string;
  display_name?: string;
  reasoning?: boolean;
  supported_reasoning_levels?: { effort: string }[];
  context_window?: number;
  max_output_tokens?: number;
  modalities?: { input?: string[] };
  native_endpoints?: string[];
}

export function readConfig(path = join(getAgentDir(), CONFIG_FILE)): MagpieConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as MagpieConfig;
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
    };
  } catch {
    console.warn(`magpie: ${path} is not valid JSON; using the local gateway`);
    return {};
  }
}

/** Gateway origin from a URL that may end in `/` or `/v1`. */
export function gatewayRoot(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** One catalog entry as a pi model, on the API the model speaks natively when magpie relays it. */
export function toModelConfig(model: GatewayModel, root: string): ChatModelConfig {
  const efforts = (model.supported_reasoning_levels ?? []).map((level) => level.effort);
  const native = model.native_endpoints ?? [];
  const api = native.includes("/v1/responses")
    ? "openai-responses"
    : native.includes("/v1/messages")
      ? "anthropic-messages"
      : undefined;
  const config: ChatModelConfig = {
    id: model.id,
    name: model.display_name ?? model.id,
    api,
    // Anthropic clients add the /v1 themselves.
    baseUrl: api === "anthropic-messages" ? root : undefined,
    reasoning: model.reasoning ?? efforts.length > 0,
    input: model.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
    // shortcut: /v1/models carries no price, so pi reports every call as free; read magpie's
    // price here once the gateway exposes it.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_window ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    // Magpie logs a turn's session from these headers.
    compat: { sendSessionAffinityHeaders: true }, // pi only; omp ignores this flag
  };
  if (efforts.length > 0) {
    const levels: NonNullable<ChatModelConfig["thinkingLevelMap"]> = {};
    for (const level of PI_LEVELS) {
      if (level !== "off") {
        levels[level] = efforts.includes(level) ? level : null;
      }
    }
    // Pi's off sends thinking disabled, which Anthropic Messages accepts; elsewhere hide it
    // unless the model has a none effort.
    if (efforts.includes("none")) levels.off = "none";
    else if (api !== "anthropic-messages") levels.off = null;
    config.thinkingLevelMap = levels;
    // omp has no thinkingLevelMap; advertise the efforts directly. Anthropic needs the
    // budget-effort mode: plain "effort" pins a fixed 1024-token budget and drops effort.
    const ompEfforts = efforts.filter(
      (effort) => effort !== "none" && PI_LEVELS.includes(effort as (typeof PI_LEVELS)[number]),
    );
    if (ompEfforts.length > 0) {
      config.thinking = {
        mode: api === "anthropic-messages" ? "anthropic-budget-effort" : "effort",
        efforts: ompEfforts,
      };
    }
  }
  return config;
}

function isGatewayModel(value: unknown): value is GatewayModel {
  return !!value && typeof value === "object" && typeof (value as GatewayModel).id === "string";
}

/** Fetch and validate `GET /v1/models`; shared by pi's refreshModels and omp's fetchDynamicModels. */
async function fetchCatalog(
  root: string,
  key: string,
  signal?: AbortSignal,
): Promise<GatewayModel[]> {
  const response = await fetch(`${root}/v1/models`, {
    signal,
    headers: { authorization: `Bearer ${key}` },
  });

  if (!response.ok) {
    throw new Error(`magpie: /v1/models answered ${response.status}`);
  }

  const body = (await response.json()) as { data?: GatewayModel[] };

  if (!Array.isArray(body.data)) {
    throw new Error("magpie: invalid models response");
  }

  const models = body.data.filter(isGatewayModel);

  if (models.length === 0) {
    throw new Error("magpie: empty model catalog");
  }

  return models;
}

export default async function (pi: ExtensionAPI) {
  const config = readConfig();
  const root = gatewayRoot(config.baseUrl ?? LOCAL_URL);
  const apiKey = config.apiKey ?? LOCAL_KEY;
  const fetchModels = (key: string, signal?: AbortSignal) =>
    fetchCatalog(root, key, signal).then((ms) => ms.map((m) => toModelConfig(m, root)));

  // pi 1.x ignores fetchDynamicModels; omp has no refreshModels and would otherwise see zero models.
  const registration: ProviderRegistration = {
    name: "Magpie",
    baseUrl: `${root}/v1`,
    api: "openai-completions",
    apiKey,

    // oxlint-disable-next-line typescript/unbound-method -- publish is destructured from context
    refreshModels: async ({ signal, credential, stored, allowNetwork, publish }) => {
      const cached = stored?.models.filter((model) => model.provider === PROVIDER_NAME) ?? [];

      // Offline mode: use the persisted cache
      if (!allowNetwork) {
        return cached;
      }

      try {
        const key = credential?.type === "api_key" && credential.key ? credential.key : apiKey;
        const models = await fetchModels(key, signal);

        // Persist the catalog for later launches
        await publish({
          persist: {
            models: models.map((model) => ({
              ...model,
              provider: PROVIDER_NAME,
              api: model.api ?? "openai-completions",
              baseUrl: model.baseUrl ?? `${root}/v1`,
            })),
            checkedAt: Date.now(),
          },
        });

        return models;
      } catch (error) {
        console.error("[magpie] model refresh failed:", error);

        // Do not mask a manual abort
        if (signal.aborted) {
          throw error;
        }

        // On failure keep the last successfully discovered models
        if (cached.length > 0) {
          return cached;
        }

        throw error;
      }
    },

    // omp (oh-my-pi) fetches live catalogs through this hook and caches them itself
    // (SQLite, 24h TTL, keyed by provider name).
    fetchDynamicModels: (key: string | undefined) => fetchModels(key ?? apiKey),
  };

  pi.registerProvider(PROVIDER_NAME, registration);
}
