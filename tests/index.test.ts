import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vite-plus/test";
import magpieProvider, {
  gatewayRoot,
  type ProviderRegistration,
  readConfig,
  toModelConfig,
} from "../src/index.ts";

function register(config?: unknown): ProviderRegistration {
  let registered: ProviderRegistration | undefined;
  const pi = {
    registerProvider: (_id: string, provider: ProviderRegistration) => {
      registered = provider;
    },
  } as unknown as ExtensionAPI;
  const dir = mkdtempSync(join(tmpdir(), "magpie-"));
  if (config !== undefined) {
    writeFileSync(join(dir, "magpie.json"), JSON.stringify(config));
  }
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    void magpieProvider(pi);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
  if (!registered) throw new Error("no provider registered");
  return registered;
}

test("falls back to the local gateway without a config file", () => {
  expect(readConfig(join(tmpdir(), "no-such-magpie.json"))).toEqual({});
  expect(register()).toMatchObject({
    baseUrl: "http://127.0.0.1:3425/v1",
    api: "openai-completions",
    apiKey: "magpie-pi",
  });
});

test("uses baseUrl and apiKey from magpie.json", () => {
  const provider = register({ baseUrl: "http://192.168.1.20:3425/v1/", apiKey: "sk-office" });
  expect(provider).toMatchObject({
    baseUrl: "http://192.168.1.20:3425/v1",
    apiKey: "sk-office",
  });
  expect(gatewayRoot("/v1/")).toBe("");
  expect(gatewayRoot("http://host:3425/v1/")).toBe("http://host:3425");
});

test("maps catalog features onto a pi model", () => {
  const claude = toModelConfig(
    {
      id: "anthropic/claude-sonnet-4-6",
      display_name: "Claude Sonnet 4.6",
      reasoning: true,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      context_window: 200_000,
      max_output_tokens: 64_000,
      modalities: { input: ["text", "image"] },
      native_endpoints: ["/v1/messages"],
    },
    "http://192.168.1.20:3425",
  );
  expect(claude).toMatchObject({
    api: "anthropic-messages",
    baseUrl: "http://192.168.1.20:3425",
    contextWindow: 200_000,
    maxTokens: 64_000,
    input: ["text", "image"],
    reasoning: true,
  });
  expect(claude.thinkingLevelMap).toMatchObject({
    low: "low",
    medium: "medium",
    high: "high",
    minimal: null,
    xhigh: null,
  });
  // Anthropic takes thinking disabled for pi's off.
  expect(claude.thinkingLevelMap?.off).toBeUndefined();

  const gpt = toModelConfig(
    {
      id: "openai/gpt-5",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "none" }],
      native_endpoints: ["/v1/chat/completions", "/v1/responses"],
    },
    "http://127.0.0.1:3425",
  );
  expect(gpt).toMatchObject({ api: "openai-responses", baseUrl: undefined });
  expect(gpt.thinkingLevelMap?.off).toBe("none");
  expect(gpt.thinkingLevelMap?.minimal).toBeNull();

  const translated = toModelConfig({ id: "zai/glm-5" }, "http://127.0.0.1:3425");
  expect(translated).toMatchObject({
    api: undefined,
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
  });
  expect(translated.thinkingLevelMap).toBeUndefined();
  // omp reads `thinking` instead of thinkingLevelMap.
  expect(claude.thinking).toMatchObject({
    mode: "anthropic-budget-effort",
    efforts: ["low", "medium", "high"],
  });
  expect(gpt.thinking).toMatchObject({ mode: "effort", efforts: ["low", "high"] });
  expect(translated.thinking).toBeUndefined();
});

test("refreshes the catalog from baseUrl with the api key", async () => {
  const config = register({ baseUrl: "http://192.168.1.20:3425", apiKey: "sk-office" });
  const context = {
    signal: new AbortController().signal,
    allowNetwork: true,
    publish: async () => true,
  };
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "openai/gpt-5", context_window: 400_000, max_output_tokens: 128_000 }],
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const models = await config.refreshModels?.(context);
    expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.20:3425/v1/models", {
      signal: context.signal,
      headers: { authorization: "Bearer sk-office" },
    });
    expect(models).toHaveLength(1);
    expect(models?.[0]).toMatchObject({
      id: "openai/gpt-5",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });

    // A rejected refresh leaves the previous catalog in place.
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 401 }));
    await expect(config.refreshModels?.(context)).rejects.toThrow("401");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("omp fetches the catalog through fetchDynamicModels", async () => {
  const config = register({ baseUrl: "http://192.168.1.20:3425", apiKey: "sk-office" });
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [{ id: "zhipu/glm-5.3", reasoning: true }] }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    // omp resolves the key itself; the magpie.json key is the fallback.
    const byResolvedKey = await config.fetchDynamicModels?.("sk-login");
    expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.20:3425/v1/models", {
      signal: undefined,
      headers: { authorization: "Bearer sk-login" },
    });
    expect(byResolvedKey?.[0]).toMatchObject({ id: "zhipu/glm-5.3", reasoning: true });

    const byConfigKey = await config.fetchDynamicModels?.(undefined);
    expect(fetchMock).toHaveBeenLastCalledWith("http://192.168.1.20:3425/v1/models", {
      signal: undefined,
      headers: { authorization: "Bearer sk-office" },
    });
    expect(byConfigKey).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
