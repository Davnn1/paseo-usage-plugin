# Usage

Token and cost usage across every backend this machine has used, broken down per provider and model. It reads the local OpenCode session database (`~/.local/share/opencode/opencode.db`) and Codex rollout files (`~/.codex/sessions/*.jsonl`), aggregates input, output, reasoning, cache-read and cache-write tokens plus cost, and shows the result on a Usage screen in Paseo with 1d, 7d, 30d and all-time periods.

Each session row is counted exactly once: OpenCode rows come from the `session` table (provider comes from the model's `providerID`), and each Codex rollout file contributes its final cumulative token count. Codex sessions carry no cost data, so cost covers OpenCode providers only. Gemini CLI is listed as a source but reported as having no machine-readable usage data because it stores usage only as protobuf spikes, which this plugin does not parse.

All data sources are opened read-only and are never written to. Aggregated results are cached for five minutes per period; pull to refresh forces re-aggregation. No credentials are read or logged.
