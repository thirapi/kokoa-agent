# Analisis HuggingClaw: Connection Strategy & Perbandingan Arsitektur

**Repo:** https://github.com/somratpro/huggingclaw
**Tanggal:** 2026-07-07 (Revisi: analisis mendalam dengan clone repo)

---

## 1. Ringkasan Arsitektur HuggingClaw

HuggingClaw menggunakan pendekatan **forward proxy** — semua traffic outbound dari HF Spaces (ke Telegram API, Discord, WhatsApp, dll.) dialihkan ke Cloudflare Worker yang bertindak sebagai proxy. HF Spaces **tidak pernah** connect langsung ke API eksternal, melainkan selalu melalui Worker.

```
HF Space (OpenClaw)
  └─ https.request / fetch / undici → cloudflare-proxy.js
       └─ Deteksi: hostname di BLOCKED_DOMAINS?
            ├─ Ya:   rewrite → Cloudflare Worker → API eksternal
            └─ Tidak: pass-through langsung
```

### Perbedaan Fundamental dengan Arsitektur Kita

| Aspek | HuggingClaw | Kita (kokoa-agent) |
|-------|-------------|---------------|
| **Direction of communication** | Space → Worker (Space initiate semua outbound via proxy) | Worker → Spaces (submit task), Spaces → Worker (callback result) |
| **Main challenge** | Outbound HTTP dari Space diblokir HF | **Callback** dari Space ke Worker diblokir HF NAT |
| **Solution** | Route ALL traffic through Cloudflare Worker proxy | ~~Persistent keepAlive + heartbeat~~ (GAGAL — lihat Seksi 6) |
| **Telegram API access** | Via Cloudflare Worker proxy | Langsung dari Worker (Worker → Telegram works) |

---

## 2. Mekanisme Proxy: `cloudflare-proxy.js`

File di-load via `NODE_OPTIONS="--require /opt/cloudflare-proxy.js"` di Dockerfile, jalan **sebelum** kode aplikasi apapun.

### 2a. Layer yang di-patch

| Layer | Primitive | Metode |
|-------|-----------|--------|
| Node `https.request` | Function | `patch(originalHttpsRequest, "https")` |
| Node `http.request` | Function | `patch(originalHttpRequest, "http")` |
| Web API `fetch` | Global | Replace `globalThis.fetch` |
| Undici `.dispatch` | Prototype | Patch `Pool.prototype.dispatch`, `Client.prototype.dispatch`, `Agent.prototype.dispatch`, `getGlobalDispatcher()` |
| Module loader | `require()` | Hook `Module.prototype.require` untuk catch undici kapanpun di-load |

### 2b. Algoritma Proxy

Untuk setiap request:

```
1. Extract hostname dari options / URL
2. Cek: hostname ∈ BLOCKED_DOMAINS?
     - Default: api.telegram.org, discord.com, web.whatsapp.com, googleapis.com
3. Jika ya DAN belum di-proxy:
     a. Rewrite hostname → worker-name.subdomain.workers.dev
     b. Rewrite protocol → https:
     c. Tambah header:
        - x-target-host: <original-hostname>
        - x-proxy-key: <shared-secret>
     d. Delete newOptions.host (raw host field)
     e. Delete newOptions.agent        ← KRUSIAL
     f. Forward ke Worker proxy
4. Jika tidak: pass-through unchanged
```

### 2c. Kenapa `delete newOptions.agent`?

Ketika hostname di-rewrite dari `api.telegram.org` ke `my-worker.workers.dev`, **agent yang terikat ke hostname asal akan bermasalah**:

- TLS sessions tersimpan untuk SNI yang salah
- Connection pools指向 origin yang salah
- Sertifikat TLS tidak cocok

Dengan `delete newOptions.agent`, setiap proxied request **memaksa fresh connection tanpa keepAlive** ke Worker proxy. Efek samping krusial: **TIDAK ADA persistent socket** yang dijaga hidup. Setiap request adalah koneksi baru yang ditutup setelah selesai.

### 2d. Fetch handling

Tidak seperti `https.request` yang di-patch dengan rewrite options, `fetch` di-handle dengan **tidak me-spread `init`**:

```javascript
// JANGAN spread init — bisa bawa dispatcher/client yang terikat ke
// connection pool asal, menyebabkan undici throw UND_ERR_INVALID_ARG
const newInit = {
  method: init?.method || "GET",
  headers: mergedHeaders,
  body: init?.body,
};
// Hanya copy field yang aman secara eksplisit
```

Ini penting karena `RequestInit` bisa bawa `dispatcher` (undici) yang terikat ke origin asal.

---

## 3. KeepAlive Strategy

### 3a. Untuk Inbound (Health Server)

```javascript
// health-server.js
server.timeout = 0;
server.keepAliveTimeout = 65000;  // 65 detik untuk incoming connections
```

Ini untuk koneksi **masuk** ke Spaces (dashboard, webhook dari Worker). Bukan untuk outbound.

### 3b. Untuk Outbound (Proxy) — TIDAK ADA KEEPALIVE

**Ini temuan paling penting:** HuggingClaw **sengaja tidak pakai keepAlive** untuk semua koneksi outbound ke Worker proxy. `delete newOptions.agent` memastikan setiap request dapet fresh connection tanpa keepAlive.

### 3c. KeepAlive Spaces Container — External Cloudflare Cron

Terpisah dari proxy — menggunakan **Cloudflare Worker cron** yang ping `/health` Spaces setiap 10 menit:

```bash
# cloudflare-keepalive-setup.py
# Auto-create Worker script dengan cron trigger every 10 minutes
# Worker → GET https://<space>.hf.space/health
# Tujuannya: cegah HF Spaces sleep karena idle
```

**Ini penting:** KeepAlive adalah **external** — Cloudflare Worker yang ping Spaces, BUKAN Spaces yang ping Worker. Arahnya berbeda dengan heartbeat kita (Spaces → Worker).

### 3d. Kesimpulan KeepAlive

| Aspek | HuggingClaw | Kita (kokoa-agent) — SEBELUMNYA |
|-------|-------------|---------------------------|
| **Untuk proxy connections** | **No keepAlive** — fresh connection tiap request | KeepAlive agent (+ heartbeat 5s) |
| **Untuk Spaces container** | **External** Cloudflare cron (10 menit) | **Internal** heartbeat dari Spaces (5 detik) |
| **Arah keepAlive** | Worker → Spaces | Spaces → Worker |
| **Tujuan** | Cegah Spaces sleep | ~~Maintain NAT mapping~~ (GAGAL) |

---

## 4. Telegram Integration

### 4a. Mode: Long-Polling vs Webhook

Dual mode, dikontrol via OpenClaw config:

```bash
# start.sh
if TELEGRAM_MODE=polling:
  - Space actively polls Telegram via getUpdates
  - Request melalui cloudflare-proxy.js → Worker → Telegram API

if TELEGRAM_MODE=webhook (default):
  - Telegram kirim update ke Worker → Worker forward ke Space
  - Space tidak perlu polling
```

### 4b. API Root Override — Kunci Keberhasilan

OpenClaw dikonfigurasi dengan `apiRoot`指向 Worker proxy:

```bash
TELEGRAM_API_ROOT="$(resolve_telegram_api_root)"
# apiRoot = https://my-worker.workers.dev/telegram

CONFIG_JSON=$(echo "$CONFIG_JSON" | jq --arg proxy_url "$TELEGRAM_API_ROOT" '
    .channels.telegram.apiRoot = $proxy_url
')
```

Ini membuat OpenClaw **secara native** mengirim request Telegram ke Worker proxy. `cloudflare-proxy.js` jadi **lapisan kedua** (fallback jika ada kode lain yang panggil Telegram langsung).

### 4c. IPv4 Force

```bash
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"
export OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1
export OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first
```

---

## 5. Perbandingan Detail: HuggingClaw vs Kita

### 5a. Diagram Alur

**HuggingClaw:**
```
Telegram → Cloudflare Worker (proxy) → HF Space (OpenClaw)
                                            ↓
HF Space (OpenClaw) → Cloudflare Worker (proxy) → Telegram API
                                            ↓
HF Space (OpenClaw) → GitHub API (direct, tidak diblokir)
```

Keterangan:
- Semua komunikasi HF Spaces → Dunia luar melalui Worker proxy
- Worker proxy → Telegram API (direct, works)
- Worker proxy juga handle webhook inbound (Telegram → Space)
- **Tidak ada callback dari Space ke Worker** — Space selalu initiate
- **Tidak ada keepAlive** — setiap request fresh connection

**Kita (kokoa-agent):**
```
Telegram → Cloudflare Worker (webhook)
              ↓
Worker → HF Spaces (POST /api/process) → proses task
              ↓
HF Spaces → Worker (callback POST /api/spaces-callback) ← PROBLEMATIK
              ↓
Worker → Telegram (send response)
```

Keterangan:
- Worker initiate komunikasi ke Spaces (inbound Spaces, works)
- Spaces perlu callback ke Worker (outbound → diblokir HF NAT)
- ~~Heartbeat 5s untuk maintain NAT mapping~~ (terbukti gagal dari log)
- Short-poll + Cron sebagai fallback (ini yang works)

### 5b. Kenapa HuggingClaw Bisa Fresh Connection Tiap Kali

Kunci yang terlewat dari analisis sebelumnya: **fresh connection tetap works** di HuggingClaw karena setiap koneksi bersifat **mandiri dan pendek**:

1. Setiap request proxy buka koneksi baru ke workers.dev
2. Request selesai → socket ditutup (karena `delete newOptions.agent` dan default Node.js agent `keepAlive: false`)
3. NAT state untuk koneksi itu masuk TIME_WAIT (~60 detik)
4. Request berikutnya datang **bermenit-menit kemudian** (antar pesan Telegram)
5. TIME_WAIT sudah clear → koneksi baru dianggap "first connection" oleh NAT → ✅

Ini berbeda dengan keepAlive:
- Socket tetap hidup terus
- NAT track sebagai koneksi permanen
- Ketika mati (TLS error), NAT masuk TIME_WAIT
- Heartbeat 5 detik coba bikin koneksi baru di TIME_WAIT → NAT blokir
- Terjebak loop: destroy → create → blocked → destroy → ...

### 5c. Implikasi untuk Arsitektur Kita

Pola HuggingClaw tidak bisa langsung diterapkan karena masalah kita berbeda struktur, tapi PRINSIP fresh connections bisa diterapkan:

| Prinsip | Di HuggingClaw | Bisa di Kita? |
|---------|---------------|---------------|
| `delete newOptions.agent` | Proxy request fresh tiap kali | Callback & heartbeat pakai fresh connection |
| External keepAlive | Cloudflare Worker ping Spaces | Bisa adopt — Worker kita cron ping Spaces |
| No persistent socket | Semua connection short-lived | Lepas keepAlive, callback fresh tiap kali |
| apiRoot pattern | OpenClaw kirim request ke proxy | Kita perlu endpoint proxy di Worker |

---

## 6. Evaluasi `workerAgent.destroy()` — ANALISIS SEBELUMNYA SALAH

### 6a. Koreksi: `destroy()` BERTENTANGAN dengan konsep 1 persistent connection

**Analisis sebelumnya (SALAH):** `agent.destroy()` hanya bersihin socket, agent tetap hidup, tidak bertentangan.

**Koreksi:** Justru dengan `destroy()` kita menciptakan masalah:

```
Timeline:
1. KeepAlive socket A dibuat → NAT izinkan (first connection) ✅
2. Socket A dipakai untuk heartbeat & callback berkali-kali ✅
3. Socket A mati (TLS error, NAT drop, dll) ❌
4. workerAgent.destroy() → Socket A dibersihkan
5. NAT masih punya state Socket A di TIME_WAIT (~60-120s)
6. Heartbeat 5s kemudian coba bikin Socket B baru
7. NAT lihat sebagai "second connection" ke origin yang sama → BLOCKIR ❌
8. workerAgent.destroy() lagi → loop selamanya
```

**Intinya:** keepAlive membuat NAT "aware" terhadap koneksi kita. Begitu koneksi pertama mati, NAT masuk TIME_WAIT dan memblokir koneksi baru dalam window itu.

### 6b. Kenapa `destroy()` Tidak Sama dengan `delete newOptions.agent` HuggingClaw

| Operasi | Efek pada socket | Efek pada NAT |
|---------|-----------------|---------------|
| `delete newOptions.agent` | Paksa fresh connection, tanpa keepAlive | Setiap koneksi mandiri, NAT treat sebagai koneksi independent |
| `workerAgent.destroy()` | Hapus socket keepAlive yang rusak | NAT tahu ada koneksi yang mati → TIME_WAIT → blokir koneksi baru |
| `new https.Agent({keepAlive:true})` | Bikin socket persistent | NAT track sebagai 1 koneksi aktif yang dijaga hidup |

### 6c. Verifikasi dari Log

Dari log kita:

```
11:39:09 — Container start
           [Heartbeat] Starting keep-warm pings every 5000ms
           (heartbeat pertama ✅ — bikin koneksi keepAlive A)
11:39:xx — First message received & processed
           [Spaces] Result stored
           (callback pakai socket A — mungkin sukses?)
           [Heartbeat] Ping error: Client network socket disconnected...
           (socket A mati, destroy(), coba bikin socket B)
11:40:xx — [Heartbeat] Ping error... (socket B gagal)
11:41:xx — [Heartbeat] Ping error... (socket C gagal)
           ... semua koneksi baru gagal karena TIME_WAIT belum clear
```

Pola ini konsisten: **setelah keepAlive socket mati, tidak ada recovery yang berhasil**.

### 6d. Lesson Learned

1. **KeepAlive + heartbeat 5s adalah strategi yang salah** untuk HF Spaces NAT.
2. **Fresh connections (seperti HuggingClaw) works** karena setiap koneksi independent.
3. **External keepAlive** (Worker → Spaces) lebih baik dari internal (Spaces → Worker) karena arah inbound tidak kena NAT restriction.
4. **Callback pattern** (Spaces → Worker) inherently bermasalah karena butuh outbound connection yang diblokir NAT. Short-poll (Worker → Spaces, inbound) lebih reliable.

---

## 7. Kesimpulan — REVISI

1. ~~HuggingClaw solve "outbound diblokir" dengan proxy. Kita solve "callback diblokir" dengan persistent connection + heartbeat.~~ **SALAH — persistent connection + heartbeat GAGAL.**

2. ~~`workerAgent.destroy()` kita tidak bertentangan dengan persistent connection.~~ **SALAH — `destroy()` justru memperparah dengan memicu TIME_WAIT yang blokir koneksi baru.**

3. ~~Heartbeat 5s adalah solusi paling tepat untuk maintain NAT mapping.~~ **SALAH — Heartbeat 5s malah bikin kita stuck di loop destroy→create→blocked.**

4. **Yang benar:** fresh connections (tanpa keepAlie) + interval cukup panjang antar request (>60s biar TIME_WAIT clear) adalah pendekatan yang terbukti works (HuggingClaw).

5. **Untuk arsitektur kita:** callback tidak bisa diandalkan. Short-poll (Worker → Spaces, inbound) adalah primary path yang reliable. Jika mau pakai callback, harus tanpa keepAlive dan siap gagal.

---

## 8. Catatan untuk Implementasi ke Depan

### 8a. Yang Bisa Diadopsi dari HuggingClaw

1. **apiRoot pattern** — buat endpoint proxy di Worker untuk Telegram, sehingga Spaces bisa kirim response via proxy (tidak perlu callback ke Worker untuk kirim response).
2. **External keepAlive** — Worker cron ping Spaces (inbound, tidak kena NAT restriction) lebih baik dari Spaces ping Worker.
3. **Fresh connections** — untuk callback, pakai default agent (tanpa keepAlive). Jika gagal, retry dengan delay >60s.

### 8b. Yang Tetap Berbeda

1. **Callback pattern** — kita tetap perlu Spaces → Worker communication karena Worker yang handle Telegram webhook. Tidak bisa dieliminasi sepenuhnya.
2. **Short-poll fallback** — tetap perlu karena callback tidak 100% reliable. Tapi short-poll perlu dioptimasi (hdl TTL fix sudah dilakukan).
