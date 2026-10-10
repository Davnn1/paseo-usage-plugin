import assert from "node:assert/strict";
import test from "node:test";
import { applyGatewayInjection, probeProxy, type AgentCreateRequestLike } from "../server/gateway-guard";

function req(provider: string, env?: Record<string, unknown>, providerEnv?: Record<string, unknown>): AgentCreateRequestLike {
  return {
    env,
    config: { provider, providerOptions: providerEnv ? { env: providerEnv } : undefined },
  };
}

const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
const failFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;
const hangFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as unknown as typeof fetch;

test("probeProxy: reachable -> true", async () => {
  assert.equal(await probeProxy("http://127.0.0.1:9880", okFetch), true);
});

test("probeProxy: unreachable -> false", async () => {
  assert.equal(await probeProxy("http://127.0.0.1:9880", failFetch), false);
});

test("probeProxy: timeout -> false", async () => {
  assert.equal(await probeProxy("http://127.0.0.1:9880", hangFetch), false);
});

test("inject: healthy antigravity -> /cli", () => {
  const r = req("antigravity");
  assert.equal(applyGatewayInjection(r, "http://127.0.0.1:9880", true), "injected");
  assert.equal(r.env?.["AGY_LLM_GATEWAY_URL"], "http://127.0.0.1:9880/cli");
});

test("inject: healthy antigravity-acp -> /acp", () => {
  const r = req("antigravity-acp");
  assert.equal(applyGatewayInjection(r, "http://127.0.0.1:9880", true), "injected");
  assert.equal(r.env?.["AGY_LLM_GATEWAY_URL"], "http://127.0.0.1:9880/acp");
});

test("inject: unhealthy -> skipped, env untouched", () => {
  const r = req("antigravity");
  assert.equal(applyGatewayInjection(r, "http://127.0.0.1:9880", false), "skipped-unhealthy");
  assert.equal(r.env, undefined);
});

test("inject: configured env wins", () => {
  const r = req("antigravity", { AGY_LLM_GATEWAY_URL: "http://custom:1" });
  assert.equal(applyGatewayInjection(r, "http://127.0.0.1:9880", true), "skipped-configured");
  assert.equal(r.env?.["AGY_LLM_GATEWAY_URL"], "http://custom:1");
});

test("inject: other providers untouched", () => {
  const r = req("opencode");
  assert.equal(applyGatewayInjection(r, "http://127.0.0.1:9880", true), "skipped-provider");
  assert.equal(r.env, undefined);
});
