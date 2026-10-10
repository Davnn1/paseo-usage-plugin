// Guard for AGY_LLM_GATEWAY_URL injection: only route Antigravity harness
// traffic through agy-usage-proxy when the proxy is actually reachable.
// When it is down, agents run direct (usage still comes from the conversation
// store; only live cache enrichment is lost) instead of failing to connect.

const PROXY_STATS_PATH = "/_proxy/stats";
const PROBE_TIMEOUT_MS = 300;

export type InjectionOutcome =
  | "injected"
  | "skipped-configured"
  | "skipped-unhealthy"
  | "skipped-provider";

export interface AgentCreateRequestLike {
  env?: Record<string, unknown>;
  config: {
    provider: string;
    providerOptions?: { env?: unknown };
  };
}

export async function probeProxy(
  base: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}${PROXY_STATS_PATH}`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function applyGatewayInjection(
  request: AgentCreateRequestLike,
  base: string,
  healthy: boolean,
): InjectionOutcome {
  const provider = request.config.provider;
  if (provider !== "antigravity" && provider !== "antigravity-acp") return "skipped-provider";
  const configured =
    request.env?.["AGY_LLM_GATEWAY_URL"] ??
    (request.config.providerOptions?.env as Record<string, unknown> | undefined)?.["AGY_LLM_GATEWAY_URL"];
  if (typeof configured === "string" && configured) return "skipped-configured";
  if (!healthy) return "skipped-unhealthy";
  const gateway = provider === "antigravity" ? `${base}/cli` : `${base}/acp`;
  request.env = { ...(request.env ?? {}), AGY_LLM_GATEWAY_URL: gateway };
  return "injected";
}
