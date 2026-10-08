# Plan: Paseo plugin "usage" — konsolidasi usage semua provider

Keputusan user: cover SEMUA backend/provider yang Paseo dukung (keinstall & pernah dipake), detail per model (input/output/reasoning/cache/cost). Sumber otoritatif = opencode.db + codex sessions; kimi-proxy/OmniRoute TIDAK dihitung (redundan). Anti dobel-hitung harga mati.

## Lokasi project (konvensi referensi agent 5f44cbfc)
`/home/davnn/paseo-plugins/usage` — sejajar `opencode-mcp-toggle`. `paseo plugin init` di path ini → npm install → implement.
Manifest ikut konvensi repo: `{ id: "usage", requirements: { paseo: ">=0.9.0" }, build: [["npm","install","--omit=dev"]] }` (naikkan requirements kalau pakai API baru; daemon sekarang **0.11.1**).
devDeps `@getpaseo/*` WAJIB match daemon (pin 0.11.x — jangan 0.9.2; lessons:paseo-plugin-09 soal sinkronisasi tipe).

## Sumber data (adapter per backend)
1. **opencode** → `~/.local/share/opencode/opencode.db`, tabel `session` (sqlite READ-ONLY):
   `model` = JSON {"id","providerID","variant"}, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost`, `time_created` (epoch ms). Covers kimi, xiaomi-token-plan-sgp, alibaba-token-plan, omniroute (agy/*), deepseek, dll.
2. **codex** → `~/.codex/sessions/*.jsonl`: `input_tokens`/`output_tokens`/`cached_input_tokens` + `last_token_usage` + `model`. Precedence: `last_token_usage` kalau ada, else field per-entry.
3. **gemini cli** → spike `~/.gemini/`; cuma protobuf (*.pb) = status "no_data_source", jangan dipaksa.
4. Backend lain → interface adapter siap, return "not implemented".

Aturan: tiap baris = TEPAT SATU adapter. providerID within opencode = dimensi `provider`, bukan source terpisah.

## Discovery (keinstall & pernah dipake)
- Server handler pakai Paseo SDK (`{ paseo }`): enumerate providers/backends terdaftar.
- Status per backend: `used` / `never_used` / `no_data_source` / `error`. Tabel utama hanya usage > 0.
- PITFALL (lessons:paseo-plugin-09): `client.paseo.agents.subscribe(cb)` = listener lokal TANPA data. Kalau butuh subscription, pakai owned list pattern: `paseo.agents.list({ subscribe: {}, signal })` → `subscription.subscribe({ snapshot, update })` + AbortController cleanup. Untuk screen usage, idealnya cukup RPC biasa (tanpa subscription live).

## Kontrak (shared/, Zod, defineRpc)
- `usage.summary { period: "1d"|"7d"|"30d"|"all" }` → `totals` (inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, costUsd, sessions, cacheHitRatio), `byProvider[]` ({backend, provider, entries: UsageEntry[]}), `sources[]` ({backend, status, detail?}).
- `UsageEntry`: { backend, provider, model, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, costUsd, sessions, firstUsed, lastUsed, cacheHitRatio }.
- `usage.refresh` → force re-agregasi.

## Server (index.server.ts + server/)
- adapters/opencode.ts — sqlite read-only (`node:sqlite` built-in; fallback better-sqlite3). SUM per (providerID, model id) filter time_created.
- adapters/codex.ts — stream-parse jsonl; file kosong/rusak tidak crash.
- adapters/gemini.ts — spike; gagal = no_data_source.
- aggregator.ts — periode filter, turunan: cacheHitRatio = cacheRead/(cacheRead+input), cost sum, sessions, first/last.
- Cache per period TTL 5 menit + refresh force. TIDAK PERNAH tulis ke sumber data.

## Client (index.client.tsx + client/)
- `addScreen({ id: "usage", title: "Usage" })` + `addSidebarHeaderItem` (Lucide name valid).
- Layout: period selector 1d/7d/30d/all · overview cards (cost, tokens in+out, cache hit %, sessions) · tabel provider→model (model, in, out, reasoning, cache-r, cache-w, cache hit %, cost, sesi; default sort cost desc) · footer source-status.
- RN primitives ONLY (View/Text/Pressable/ScrollView/TextInput) — zero DOM, zero className. `theme.colors` semua teks. `layout.compact` aware. TanStack Query + `useRpc`.
- Empty state + error state per-source (adapter error jangan bunuh layar).

## Verifikasi (konvensi repo + acceptance)
- `npm run typecheck` pass (`tsc --noEmit`).
- **Live-proof script** (konvensi repo, script `scripts/verify-usage.ts` dipanggil `npx tsx`): panggil handler agregasi langsung, print totals per periode, assert ±0.1% vs:
  - `all`: cost 387.25, input 227.6M, output 13.7M, cacheRead 3236.2M
  - `30d`: input 119.416.587, output 3.383.154, cacheRead 1.380.369.410, cost 118.94
  - codex totals ≈ hasil parse manual `~/.codex/sessions/*.jsonl`
- Unit test minimal `node:test` utk matematika agregasi (periode, cacheHitRatio, totals==sum, precedence codex) — project baru, zero-dep, biar regresi ketangkep.
- `paseo plugin install /home/davnn/paseo-plugins/usage` → `paseo plugin ls` = `running`, ERROR kosong; `paseo plugin logs usage` ada "Plugin ready".
- Buka screen di Paseo: angka cocok; dark theme OK; compact OK.

## Pitfall referensi (WAJIB dihindari)
- Reload gagal nempel → cek kolom ERROR `paseo plugin ls` + `paseo plugin logs`; edit sumber tanpa reload = UI basi. JANGAN restart daemon (bunuh agent).
- Import boundary: client↔server cross-import, `node:` di client, modul di root = compile error. Root hanya manifest.
- Upstream fetch timeout default pendek (~2.5s) = error palsu "aborted" — kalau nambah fetch external, timeout-nya sadar.
- Kalau bikin git repo: konvensi commit `fix: ...` / `chore: bump version to X` (npm version --no-git-tag-version), push main. (Keputusan push ke GitHub = user.)

## Rollout
1. `paseo plugin init /home/davnn/paseo-plugins/usage` → npm install → cek devDeps @getpaseo/* match daemon 0.11.x
2. Implement (spec di atas) + typecheck + verify script
3. Install → ls running → logs bersih
4. Cek UI di Paseo (angka, theme, compact)
5. Memory update: projects (plugin usage + keputusan anti dobel-hitung) + lessons kalau ada pitfall baru

## Constraints
- `pluginsEnabled` sudah true (~/.paseo/config.json) — jangan edit config daemon; `paseo plugin install` yang mendaftarkan.
- Read-only semua sumber data. Jangan log kredensial.
- Ikuti skill `paseo-plugin` (struktur client/server/shared, boundary, mobile-safe).

---

# NEXT (belum dikerjakan — permintaan user 2026-10-08, lanjut dari device lain)

## 1. Full width (bug layout)
Tabel & konten screen masih maxWidth sempit. Harus full width ngikuti lebar window Paseo: root flex:1 / width 100%, hapus maxWidth container & tabel. Tabel tetap usable (horizontal scroll kalau kolom overflow di window sempit).

## 2. Dashboard widgets (gaya screenshot referensi user — GitHub-ish)
Tambah section dashboard DI ATAS tabel:
- **Heatmap "OVERVIEW"**: grid kalender 365 hari (kolom bulan × baris weekday Mon/Wed/Fri), intensitas warna per hari dari total tokens, header "N active days · X tokens · 365 days", legend Less→More. Pure RN Views.
- **MOST ACTIVE DAY** card (weekday + tanggal + tokens) + **WEEKLY** strip (7 bar weekday, tinggi/intensitas dari tokens periode terpilih).
- **MODEL USAGE OVER TIME**: bar per hari (input+output) + garis cost overlay, legend Input/Output/Cost. Coba `react-native-svg` (kalau host-provided); kalau runtime reject → FALLBACK pure Views wajib (bar murni View, cost = seri kedua).
- **COST BY PROVIDER**: donut + legend + total; fallback tanpa svg = stacked horizontal bar + legend.
- Layout: kartu grid responsif (2 kolom di window lebar, 1 kolom compact).

## 3. Data: extend RPC
`series` di summary atau RPC baru `usage.dashboard {period}`: `daily[] {date, inputTokens, outputTokens, cacheReadTokens, costUsd, sessions}` (gap-filling hari kosong = 0), `weekly[] {weekday, tokens, costUsd}`, `byProviderCost[] {provider, costUsd}`, `mostActiveDay {weekday, date, tokens}`. Heatmap SELALU 365d; chart trend ikut periode terpilih.

## 4. Acceptance lanjutan
typecheck pass · test lama+baru pass (weekly bucketing, mostActiveDay, daily gap-fill) · `paseo plugin reload usage` running ERROR kosong · verify script existing TIDAK berubah · audit RN-only (zero DOM) · compact layout dicek.

## Handoff (pindah device)
- Repo: https://github.com/Davnn1/paseo-usage-plugin.git (branch `main`).
- Install di mesin baru: `git clone` → `npm install` → cek `pluginsEnabled` di `~/.paseo/config.json` daemon lokal → `paseo plugin install ./usage` **dari parent folder (path RELATIF — path absolut = silent no-op, pitfall terverifikasi)** → `paseo plugin ls` harus `running`, cek kolom ERROR.
- JANGAN restart daemon (bunuh agent); reload via `paseo plugin reload usage`.
- Data sources bersifat LOKAL per mesin (opencode.db + ~/.codex) — mesin baru = angka mesin itu.
- Verifikasi angka di mesin baru: jalankan `npx tsx scripts/verify-usage.ts` — self-validating vs SQL ground-truth mesin tsb.
- Konvensi commit repo: `fix: ...` / `feat: ...` terpisah dari `chore: bump version to X` (npm version --no-git-tag-version).
