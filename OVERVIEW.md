# Monitoring

Token and cost usage across every backend this machine has used, broken down per provider and model. It reads the local OpenCode session database (`~/.local/share/opencode/opencode.db`) and Codex rollout files (`~/.codex/sessions/*.jsonl`), aggregates input, output, reasoning, cache-read and cache-write tokens plus cost, and shows the result on a Usage screen in Paseo with 1d, 7d, 30d and all-time periods.

Each session row is counted exactly once: OpenCode rows come from the `session` table (provider comes from the model's `providerID`), and each Codex rollout file contributes its final cumulative token count. Codex sessions carry no cost data, so cost covers OpenCode providers only. Antigravity conversation stores are plain SQLite and are read for session and step counts, but they do not record token numbers; token usage for the Antigravity harness is captured by agy-usage-proxy (a local gateway the plugin points new Antigravity spawns at via the `AGY_LLM_GATEWAY_URL` environment variable) and merged in per model, including a live context-occupancy column computed against known context-window sizes (override any model with the `AGY_CONTEXT_WINDOWS` JSON environment variable). Per-agent attribution inside the harness is not available to plugins at spawn time — the Paseo agent id does not exist yet when `agent.create` runs — so context occupancy is reported per model rather than per agent. Any Antigravity usage routed through OmniRoute is already counted under the `omniroute` provider in the OpenCode table.

All data sources are opened read-only and are never written to. Aggregated results are cached for five minutes per period; pull to refresh forces re-aggregation. No credentials are read or logged.

## Entry points

Every entry shows the same Usage view (period selector, overview cards, dashboard, model table, coverage):

| Entry | Where it appears |
| --- | --- |
| Search / Command Center "Open Monitoring" | ⌘K / Ctrl+K on every client, including mobile - the primary way in |
| Sidebar header row | Desktop sidebar header (single entry; no footer duplicate) |
| Composer pill detail card | Per-agent track bar: tap opens a compact metric card (input, output, reasoning, cache read/write, cache hit with a progress bar, cost; daily fallback when the session is untracked). Info only - open Monitoring via Search or the sidebar |

The plugin intentionally registers no workspace panel, so no "Monitoring" entry appears in the + menu; Search is the cross-platform entry point. |

## Troubleshooting

The screen, sidebar item, and composer pill only appear on clients connected to a daemon where this plugin is installed and running.

- The screen header has a host picker. If several daemons are connected, confirm the selected host is the machine where the plugin is installed.
- If the sidebar row is missing, check Settings → Sidebar: plugin sidebar items can be hidden there.
- On the daemon machine, run `paseo plugin ls`: the `usage` row must show `running` with an empty ERROR column. `paseo plugin logs usage` shows daemon-side output ("Plugin ready" on a healthy start).
- The composer pill requires the agent to belong to a workspace (agents without a workspace cannot carry pills by API design) and the client must render composer pills at all; on hosts that do not render them, the screen and sidebar item still work.
- Mobile clients connect to their own configured daemon. If that daemon is not the machine with the data, install the plugin there as well; usage data is local to each machine.
