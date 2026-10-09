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

## 5. Composer pill "current usage" (ide user 2026-10-08 malam)
Pill per-agent di composer track bar (sejajar pill MCP & Subagents) via `addComposerPill`:
- Label compact usage periode berjalan (default 1d): in / out / cache-hit% / total (cost) — mis. `12.4M/1.2M · 92% · $12` (title/tooltip = breakdown lengkap).
- onPress → `openScreen({ screenId: "usage" })`.
- Data: `useRpc(usage.summary {period:"1d"})` + TanStack Query `refetchInterval` 60s (server cache TTL 5 menit sudah ada; pill cukup baca cache).
- Registrasi WAJIB owned list subscription: `client.paseo.agents.list({ subscribe: {}, signal })` → `subscription.subscribe({ snapshot, update })` + AbortController cleanup. JANGAN `agents.subscribe(cb)` (listener kosong — lessons:paseo-plugin-09).
- Pill API return `{ update, remove }` (bukan remover polos); `remove()` idempotent; cleanup = remove semua pill + abort.
- Reload/reconnect: snapshot ulang = daftar ulang pill, jangan duplikat.

## 6. FIX pill (review user 2026-10-08 malam, screenshot desktop)
1. **Pill scope = PER SESI**, bukan total 1d. Mapping ADA: `~/.paseo/agents/<workspace>/<agentId>.json` → `.persistence.sessionId` / `.runtimeInfo.sessionId` = `ses_...` (opencode). RPC baru `usage.sessionSummary {sessionId}` (atau agentId di-resolve server-side) → row tabel `session` by id (tokens_* + cost sudah per-row). Label pill: `in/out · cache% · $cost` milik SESI itu. Title: breakdown + judul sesi. Backend non-opencode (codex): mapping sesi beda → fallback "—" dulu, jangan ngarang.
2. **Pill tidak muncul di mobile** — investigasi & fix: cek filter `agent.workspaceId` (mobile entries?), availability addComposerPill di client mobile, logs app; pastikan registrasi jalan di semua client. Audit compact layout.
3. **Lebar pill** — cek API pill (label length limit? custom width?). Chrome pill milik host; kalau width host-fixed → format label paling padat per karakter, breakdown lengkap di title. Kalau ada jalan melebar → pakai.

## 7. FIX round-2 (review user 2026-10-08, screenshot desktop lebar)
1. **Tabel full width beneran**: container sudah 100% tapi kolom menggumpal kiri (lebar by content). Distribusi kolom ke seluruh lebar (flex per kolom / persentase), header + rows sejajar, tetap horizontal scroll di window sempit.
2. **Dashboard interaktif**: hover/press di heatmap cell & bar chart → tooltip (tanggal, in/out/cost/sesi). Desktop: Pressable onHoverIn/onHoverOut; mobile: onPress toggle tooltip overlay. Juga pastikan dashboard benar-benar RENDER di client (user pernah lihat build basi — cek query error, jangan return null diam-diam; kasih error state visible).
3. **Sources/Coverage filter ACTIVE only**: default tampilkan hanya provider yang enabled/active di Paseo (toggle on). Provider disabled yang punya data (codex used) — sembunyikan di default, collapse "show disabled" opsional.
4. **Label Antigravity**: baris user-facing jangan "gemini: ... protobuf spikes" (membingungkan — memang store-nya di ~/.gemini/antigravity). Rename jadi **Antigravity**, note jelas: "data lokal terenkripsi, tidak terbaca; usage via OmniRoute tetap terhitung di provider omniroute".

## 8. FIX round-3 (review user 2026-10-08)
1. **Pill fallback ke daily** (user setuju): urutan = sesi (session_summary found) → fallback **1d totals** (usage.summary period 1d) saat sesi belum ada / tidak terlacak / backend non-opencode. Title kasih mode eksplisit: "Session: <judul>" vs "Daily fallback — sesi tidak terlacak". Label format sama.
2. **Mobile: pill + sidebar item tidak muncul** — kemungkinan besar HOST (mobile app connect ke daemon lain yang belum install plugin), tapi tetap harden: (a) pastikan registrasi sidebar + pill jalan tanpa throw di mobile (icon name valid lintas client, SidebarRow dari /client/ui), (b) wrap component render defensively (error di satu kontribusi jangan bunuh yang lain), (c) dokumentasikan checklist user di OVERVIEW.md: cek host picker di header screen, Settings > Sidebar visibility, `paseo plugin ls` di daemon yang di-connect harus memuat `usage running`.

## 9. FIX round-4 (mobile, daemon SUDAH benar — plugin running di host yang sama)
Temuan user: pill MUNCUL di mobile (fix icon Gauge terbukti) tapi (a) tap pill tidak membuka detail/screen, (b) sidebar item tetap tidak ada.
1. **Pill press → screen cross-platform**: investigasi tipe `PluginButton` behavior (kind apa saja yang ada — mungkin ada `{kind:"screen", screenId}` yang di-handle host, atau `onPress` + `client.openScreen` butuh params). Pastikan tap di mobile membuka screen "usage". Kalau API hanya "action", pastikan `openScreen({screenId:"usage", params:{}})` benar terpanggil dan tidak silent-fail (guard try/catch + log).
2. **Sidebar item mobile + fallback entry**: tambah `addSidebarFooterItem` DAN `addCommandCenterItem` ("Open Usage", openScreen) sebagai jalur alternatif buka screen di semua client. Investigasi kenapa header item tidak render di mobile (mobile layout mungkin tidak menampilkan sidebar header items — laporkan jujur kalau itu keputusan host).
3. Semua entry point (sidebar header/footer, command center, pill) arahkan ke screen yang sama; dokumentasikan di OVERVIEW.md entry mana yang tersedia per platform.

## 10. UX round (review user 2026-10-09, referensi: dashboard DeepSeek)
1. **Crosshair + floating tooltip** di bar chart (Model Usage Over Time, Weekly): hover bar → garis vertikal dashed di posisi bar + tooltip card melayang (tanggal + nilai per seri) — gaya DeepSeek. RN: absolute-positioned View (dash = segmented views), posisi dari koordinat bar via onLayout.
2. **Hover terhubung** Overview ↔ Model Usage Over Time: state hoveredDate di parent Dashboard — hover tanggal di heatmap → bar tanggal sama highlight di trend chart (dan sebaliknya).
3. **Heatmap hover = floating card**: tooltip card (tanggal + in/out/cost/sesi) melayang dekat cell, bukan cuma detail line bawah kartu. Detail line tetap fallback untuk mobile press.
4. **Bar chart flex width**: lebar bar mengikuti lebar container / jumlah segment (All = ratusan bar harus muat), bukan lebar statis.
5. **Filter periode baru**: `Week` / `Month` + tombol ‹ › (geser minggu/bulan sebelum-sesudah) + `Custom` (pilih start/end). Keep "All". RPC extend: optional `startDate`/`endDate` (YYYY-MM-DD) override periode; week/month = sugar client yang ngitung range.

## 11. FIX round UX (review user 2026-10-09 — layout RUSAK)
1. **Repair heatmap**: balikin layout lama (cell fixed-size, horizontal scroll, grid rapat). Flex-width di round 10 meremuk grid jadi kolom sempit + tooltip melayang salah posisi. Tooltip card wajib anchor ke cell (clamp ke grid), bukan ngambang.
2. **Trend bars DINAMIS + scrollable** (bukan shrink-to-fit): lebar bar = clamp(8px, container/segments, ~28px). Segmen sedikit → bar melebar (bahkan rata penuh); segmen banyak → bar min-width + **horizontal scroll** yang nyaman — JANGAN mengecil sampai "upil".
3. **Hover INDEPENDEN per chart** (revert section 10 #2 — salah baca): heatmap & trend masing-masing punya focus sendiri, TIDAK terhubung.
4. **Filter: kembalikan 1d/7d/30d** (user minta tetap ada) di samping Week/Month/Custom/All. Konsultasi UX agent soal redundansi → trim sesuai rekomendasi.

## 12. FIX round (review user 2026-10-09 — pill Context & layout monitoring)
1. **HAPUS baris "Context" di pill** (index.client.tsx ~:103) — implementasi liar di luar spek (ctx = latest prompt vs window, `shared/usage.ts:42`), angka salah kalibrasi (380% = 498.4K/131.1K, prompt > window, mustahil). Kembalikan rows pill = Input/Output/Reasoning/Cache Read/Cache Write/Cache Hit/Cost. Matikan/hapus juga `ctx` computation kalau cuma dipakai itu (biar ga dead code sesat).
2. **Heatmap vertikal (BUG)**: grid ke-transpose — 53 minggu jadi tumpukan ke bawah. Harus horizontal: 7 baris weekday × 53 kolom minggu, width = 53×(cell+gap), horizontal scroll di sempit. Tooltip tetap anchor ke cell.
3. **Spacing header**: baris "93 active days · 3.3B tokens · 365 days" jangan nempel ke judul OVERVIEW — kasih gap.
4. **Trend chart kosong di filter 7d (BUG)**: debug daily bucketing utk window 7d (kemungkinan salah di filterDateRange/endMs pasca round 10). Acceptance: 7d menampilkan 7 bar, terisi kalau ada sesi. Tambah test bucketing 7d.
5. **Tinggi card**: kartu MOST ACTIVE DAY memanjang kosong (grid stretch) — card harus hug content / tinggi baris seimbang (alignItems flex-start atau tinggi natural per kartu).

Acceptance: typecheck pass · test pass (44+ dengan test 7d bucketing baru) · reload → `plugin ls` running ERROR kosong · logs bersih · verify script tak berubah · audit RN 0 hit · commit (`fix:` deskriptif) JANGAN push.

## 13. Antigravity usage + context meter (lanjutan 2026-10-09)
Strategi: cek dulu jalur TANPA proxy — wire protocol agy bawa token (inputTokens/outputTokens/cache_read_tokens, dari riset bundle Paseo 0.11.1) dan conversation db = SQLite berisi blob protobuf. Pencarian LIKE '%token%' waktu itu TIDAK VALID utk blob protobuf (tanpa nama field).
1. **Spike decode**: `protoc --decode_raw` (atau walker varint) pada `steps.step_payload`/`metadata`/`gen_metadata`/`executor_metadata` dari `~/.gemini/antigravity-cli/conversations/*.db` (pilih yang steps-nya banyak) + `~/.gemini/antigravity-acp/conversations/*.db`. Cari pola 3-4 varint berdekatan = kandidat (input, output, cache). Cross-check ke jumlah yang masuk akal.
2. **Recon binary agy**: env support (HTTPS_PROXY / *_BASE_URL / *_ENDPOINT / SSL_CERT_FILE) via strings + lokasi binary.
3. **Keputusan (2026-10-09, spike SELESAI)**: usage LOKAL BISA DIBACA. Field map `gen_metadata.data` protobuf: **f1.4.2=input_tokens, f1.4.3=output_tokens**, f1.4.5/f1.4.9-10=kumulatif, **f1.19=model**, **f1.9.10={context_used, context_max}** ← meter! Validated 2 ACP db + 1 CLI db. cache_read TIDAK ada di blob (hanya wire frame) → kolom cache = 0/null jujur. **Keputusan: adapter decode protobuf (zero-dep walker) — BUKAN proxy.** Proxy (pola kimi-proxy; binary agy dukung HTTPS_PROXY/SSL_CERT_FILE/GOOGLE_GEMINI_BASE_URL; endpoint aicode.googleapis.com dll.) ditunda opsional — hanya kalau butuh cache_read real-time.

## Handoff (pindah device)
- Repo: https://github.com/Davnn1/paseo-usage-plugin.git (branch `main`).
- Install di mesin baru: `git clone` → `npm install` → cek `pluginsEnabled` di `~/.paseo/config.json` daemon lokal → `paseo plugin install ./usage` **dari parent folder (path RELATIF — path absolut = silent no-op, pitfall terverifikasi)** → `paseo plugin ls` harus `running`, cek kolom ERROR.
- JANGAN restart daemon (bunuh agent); reload via `paseo plugin reload usage`.
- Data sources bersifat LOKAL per mesin (opencode.db + ~/.codex) — mesin baru = angka mesin itu.
- Verifikasi angka di mesin baru: jalankan `npx tsx scripts/verify-usage.ts` — self-validating vs SQL ground-truth mesin tsb.
- Konvensi commit repo: `fix: ...` / `feat: ...` terpisah dari `chore: bump version to X` (npm version --no-git-tag-version).
