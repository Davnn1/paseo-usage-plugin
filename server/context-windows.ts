/**
 * Context-window sizes for Antigravity (harness) models.
 *
 * The agy binary resolves context windows at runtime (`resolveContextWindow`
 * is compiled in, but strings shows no static model→size table), so this
 * plugin ships a conservative fallback map. Operators can override any model
 * with the AGY_CONTEXT_WINDOWS env var: {"exact-model": 123456} or prefix
 * keys like {"claude-": 200000}; exact matches win, then longest prefix.
 */

let envWindows: Record<string, number> | null | undefined;

function windowsFromEnv(): Record<string, number> | null {
  if (envWindows !== undefined) return envWindows;
  const raw = process.env.AGY_CONTEXT_WINDOWS;
  if (!raw) {
    envWindows = null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
    }
    envWindows = out;
  } catch {
    envWindows = null;
  }
  return envWindows;
}

const FALLBACK_WINDOWS: [prefix: string, tokens: number][] = [
  ["gemini-", 1_048_576],
  ["claude-sonnet-4-6", 200_000],
  ["claude-opus-", 200_000],
  ["gpt-oss-120b-", 131_072],
];

/** Resolve the context window for a model; null when unknown (rendered as "—").
 *  Pass envOverride (or set AGY_CONTEXT_WINDOWS) for operator-supplied sizes. */
export function resolveContextWindow(
  model: string,
  envOverride?: Record<string, number> | null,
): number | null {
  const env = envOverride !== undefined ? envOverride : windowsFromEnv();
  if (env) {
    if (env[model]) return env[model];
    const prefixes = Object.keys(env)
      .filter((key) => key.endsWith("-") || key.endsWith("*"))
      .sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
      const bare = prefix.replace(/\*?$/, "");
      if (model.startsWith(bare)) return env[prefix];
    }
  }
  for (const [prefix, tokens] of FALLBACK_WINDOWS) {
    if (model.startsWith(prefix)) return tokens;
  }
  return null;
}
