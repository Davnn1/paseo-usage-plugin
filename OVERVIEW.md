# Usage

Token and cost usage across every backend this machine has used, broken down per provider and model. It reads the local OpenCode session database (`~/.local/share/opencode/opencode.db`) and Codex rollout files (`~/.codex/sessions/*.jsonl`), aggregates input, output, reasoning, cache-read and cache-write tokens plus cost, and shows the result on a Usage screen in Paseo with 1d, 7d, 30d and all-time periods.

Each session row is counted exactly once: OpenCode rows come from the `session` table (provider comes from the model's `providerID`), and each Codex rollout file contributes its final cumulative token count. Codex sessions carry no cost data, so cost covers OpenCode providers only. Gemini CLI is listed as a source but reported as having no machine-readable usage data because it stores usage only as protobuf spikes, which this plugin does not parse.

All data sources are opened read-only and are never written to. Aggregated results are cached for five minutes per period; pull to refresh forces re-aggregation. No credentials are read or logged.

## Entry points

Every entry shows the same Usage view (period selector, overview cards, dashboard, model table, coverage):

| Entry | Where it appears |
| --- | --- |
| Workspace panel "Usage" | Tab beside agents and terminals; the surface that renders on every host including mobile |
| Composer pill detail card | Per-agent track bar: tap opens a compact metric card (input, output, reasoning, cache read/write, cache hit with a progress bar, cost; daily fallback when the session is untracked). Info only — open Usage via the panel, Command Center, or sidebar |
| Command Center "Open Usage" | ⌘K / Ctrl+K, in the workspace scope; opens the Usage panel |
| Sidebar header row | Desktop sidebar header |
| Sidebar footer row | Clients whose sidebar shows the footer area |

## Troubleshooting

The screen, sidebar item, and composer pill only appear on clients connected to a daemon where this plugin is installed and running.

- The screen header has a host picker. If several daemons are connected, confirm the selected host is the machine where the plugin is installed.
- If the sidebar row is missing, check Settings → Sidebar: plugin sidebar items can be hidden there.
- On the daemon machine, run `paseo plugin ls`: the `usage` row must show `running` with an empty ERROR column. `paseo plugin logs usage` shows daemon-side output ("Plugin ready" on a healthy start).
- The composer pill requires the agent to belong to a workspace (agents without a workspace cannot carry pills by API design) and the client must render composer pills at all; on hosts that do not render them, the screen and sidebar item still work.
- Mobile clients connect to their own configured daemon. If that daemon is not the machine with the data, install the plugin there as well; usage data is local to each machine.
