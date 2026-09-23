# Dokumentasi Fitur & Implementasi Gemini Telegram Bot

Dokumen ini berisi analisis detail mengenai fitur-fitur yang dimiliki oleh Gemini Telegram Bot, detail teknis implementasinya di lingkungan Cloudflare Workers, masalah-masalah yang ditemukan, serta perbaikan yang telah diterapkan.

---

## 1. Arsitektur & Teknologi Utama

Bot ini berjalan di platform **Cloudflare Workers** (tanpa server VPS/Docker tradisional) dengan memori penyimpanan sementara/status obrolan menggunakan **Cloudflare KV (CHAT_HISTORY)**.

### Alur Kerja Utama:
1. **Webhook Fast-Path:** Menerima pesan dari Telegram Webhook, memeriksa otorisasi pengirim, memproses command langsung, lalu mengembalikan respons `200 OK` ke Telegram.
2. **Pemrosesan Asinkron (`ctx.waitUntil`):** Logika pemrosesan pesan utama dijalankan di latar belakang agar webhook tidak mengalami timeout.
3. **Agentic Tool Calling (Gemini):** Bot memanggil Gemini API dengan membawa sekumpulan perkakas (tools) GitHub. Gemini dapat memutuskan untuk memanggil tools ini secara berulang hingga target/jawaban tercapai sebelum memberikan teks final ke pengguna.

### Batasan Cloudflare Workers Free Tier:
| Batasan | Nilai |
| :--- | :--- |
| Wall-clock time (maks. eksekusi per request) | **30 detik** |
| CPU time (maks. komputasi per request) | **10 ms** |
| Koneksi keluar bersamaan per host | **6 koneksi** |
| Cloudflare KV write consistency | **Eventually consistent** (bisa 60 detik) |

---

## 2. Analisis Fitur & Detail Implementasi

### A. Obrolan Interaktif dengan Persona "Cocoa"
*   **Deskripsi:** Bot memiliki kepribadian/persona sebagai "Cocoa", seorang mantan idola STU48 yang ramah, hangat, dan berbahasa santai (kasual).
*   **Detail Implementasi:** 
    *   Sistem instruksi persona digabungkan dari `GEMINI_SYSTEM_PERSONA` dan `GEMINI_SYSTEM_INSTRUCTION` di `wrangler.jsonc`.
    *   Waktu Jakarta (WIB) ditambahkan secara dinamis di setiap request agar model mengetahui waktu terkini.
    *   Format keluaran teks bot diubah dari Markdown biasa ke **Telegram Rich HTML** menggunakan modul `formatter.js` untuk mendukung tebal, miring, coret, quote, tautan, dan blok kode (`<pre><code>`).

### B. Pemrosesan Media (Foto & Suara)
*   **Deskripsi:** Bot dapat menerima input foto (untuk analisis gambar) dan pesan suara (voice message).
*   **Detail Implementasi:**
    *   File media diunduh dari server Telegram menggunakan API `getFile` dan token bot.
    *   Media dikonversi ke format Base64 dan dikirimkan sebagai bagian dari `inline_data` di payload Gemini API.
    *   Telah dioptimalkan menggunakan fungsi **`bufferToBase64`** berbasis chunking untuk menghindari kelelahan CPU.
    *   Proses download file diberi timeout (5 detik untuk `getFile`, 10 detik untuk download konten).

### C. Integrasi GitHub API (Agentic Tools)
*   **Deskripsi:** Bot bertindak sebagai agen pengembang yang dapat mengelola repositori GitHub pengguna secara remote.
*   **Daftar Perkakas (Tools):**
    *   **Issues:** `listGitHubIssues`, `createGitHubIssue`, `createIssueComment`, `updateIssueState`.
    *   **Pull Requests (PR):** `getPRDiff`, `createPullRequest`, `mergePullRequest`, `updatePRState`.
    *   **File Manager:** `getFileContent`, `createOrUpdateFile`, `deleteFile`, `listDirectoryContents`.
    *   **Search & Workflow:** `searchInFiles`, `triggerDeveloperWorkflow` (memicu GitHub Actions runner untuk tugas berat di backend).
*   **Timeout:** Semua panggilan ke GitHub API memiliki timeout 15 detik via `AbortController`.

### D. Manajemen Rotasi API Key & Model (Key & Model Rolling)
*   **Deskripsi:** Bot membawa beberapa API Key Gemini (`GEMINI_API_KEYS`) dan beberapa model fallback (`GEMINI_MODELS`). Jika salah satu key mengalami limit/error, bot otomatis berputar mencari key/model yang aktif.
*   **Detail Implementasi:**
    *   **`blacklistedKeysPerModel`** — Menonaktifkan key hanya untuk model tertentu. Digunakan saat terjadi rate limit (429) atau server sibuk (503). Key tetap bisa digunakan untuk model fallback lain.
    *   **`blacklistedKeysGlobal`** — Menonaktifkan key untuk semua model. Digunakan saat API key tidak valid (400) atau diblokir (403).
    *   **Cooldown di KV** — Menyimpan status cooldown key ke Cloudflare KV (`cooldown:keyShort`) selama 10 menit untuk key invalid/blocked, agar request dari invokasi Worker berikutnya langsung melewati key bermasalah.
    *   **Pre-fetch KV** — Status cooldown semua key dibaca secara paralel (`Promise.all`) di awal fungsi `processMessage` untuk menghindari pembacaan KV sekuensial di dalam loop.

### E. Pengecekan Kuota Key & Model (/quota)
*   **Deskripsi:** Perintah `/quota` atau `/keys` untuk mengetahui status keaktifan masing-masing API Key terhadap setiap model terdaftar.
*   **Detail Implementasi:**
    *   Menggunakan sistem **chunked concurrency** — mengirim maksimal 5 request bersamaan agar tidak melebihi batas koneksi Cloudflare (6 per host).
    *   Memiliki **Global Timeout 25 detik** — jika proses keseluruhan sudah mendekati batas waktu Worker, sisa pengecekan akan ditandai `⏳ SKIPPED` dan hasil yang sudah terkumpul langsung dikirim.

### F. Perintah Bot (Commands)

| Perintah | Deskripsi |
| :--- | :--- |
| `/start` atau `/reset` | Menghapus riwayat obrolan dan lock pemrosesan. |
| `/help` | Menampilkan daftar perintah yang tersedia. |
| `/unblock` | Menghapus semua status blacklist/cooldown API Key dan lock pemrosesan dari KV. Gunakan ini jika bot terasa "stuck" dan tidak merespons. |
| `/quota` atau `/keys` | Mengecek status keaktifan API Key dan model Gemini secara real-time. |

> **Penting:** Semua perintah di atas dieksekusi **sebelum** pengecekan lock pemrosesan, sehingga Anda selalu bisa mengirim `/unblock` atau `/reset` meskipun bot sedang dalam kondisi terkunci/stuck.

---

## 3. Masalah yang Diidentifikasi & Langkah Perbaikan

Berikut adalah rincian masalah teknis yang ditemukan dalam analisis mendalam dan solusi yang telah diimplementasikan ke dalam kode:

### 3.1 Bug Kritis: Blacklist Model Akibat API Key Bermasalah
*   **Masalah:** Jika salah satu API Key tidak valid (HTTP 400 `API_KEY_INVALID`), kode mendeteksi string `"400"` dan langsung mem-blacklist **seluruh model** (menonaktifkan `gemini-3.5-flash` sepenuhnya untuk sesi tersebut), padahal modelnya sendiri tidak bermasalah.
*   **Solusi:** Memisahkan deteksi error secara terperinci di `fetchGeminiGenerate`:
    *   Error `GEMINI_KEY_INVALID` (400) dan `GEMINI_KEY_BLOCKED` (403) → hanya menonaktifkan **key** tersebut secara global.
    *   Error `GEMINI_MODEL_NOT_FOUND` (404) → hanya menonaktifkan **model** tersebut.
    *   Error `GEMINI_RETRY_TRIGGER` (429/503) → hanya menonaktifkan **key untuk model tertentu** (per-model blacklist), sehingga key masih bisa dicoba pada model fallback.

### 3.2 Bug Kritis: Rate Limit (503) Mem-blacklist Key Secara Global
*   **Masalah:** Saat model `gemini-3.5-flash` mengembalikan error 503 (High Demand), bot memasukkan API Key ke `blacklistedKeysGlobal` **dan** menulis cooldown ke KV. Akibatnya, saat bot hendak mencoba model fallback (`gemini-3.1-flash-lite`), semua key sudah di-blacklist global sehingga bot langsung menyerah tanpa mencoba fallback sama sekali.
*   **Solusi:** Error rate limit / high demand (`GEMINI_RETRY_TRIGGER`) kini hanya memasukkan key ke `blacklistedKeysPerModel` (per-model), bukan ke global blacklist. Key tersebut bebas digunakan pada model lain.

### 3.3 Silent Worker Death: Perintah `/quota` Tanpa Respon
*   **Masalah:** Pengecekan `/quota` sebelumnya mengirim seluruh request secara bersamaan (`Promise.all` untuk 6 key × 3 model = 18 request). Cloudflare membatasi 6 koneksi keluar per host. Sisanya mengantre dan melebihi timeout 5 detik, lalu totalnya melebihi batas 30 detik Worker, sehingga Worker dibunuh paksa tanpa sempat mengirim pesan.
*   **Solusi:** Menggunakan chunked concurrency (maks 5 request bersamaan) dengan global timeout 25 detik yang menjamin bot selalu mengirim respon sebelum batas 30 detik.

### 3.4 Silent Worker Death: Perintah Terblokir oleh Lock
*   **Masalah:** Semua perintah (`/quota`, `/unblock`, `/reset`, `/help`) dieksekusi **setelah** pengecekan lock. Jika proses sebelumnya macet dan lock belum dihapus, seluruh perintah akan ditolak dengan pesan "masih proses yang tadi" — termasuk perintah darurat `/unblock` yang seharusnya bisa memperbaiki situasi.
*   **Solusi:** Memindahkan parsing dan eksekusi perintah ke **sebelum** pengecekan lock dan rate limit. Perintah utilitas selalu bisa dijalankan kapan saja. Lock dan rate limit hanya berlaku untuk pesan obrolan biasa.

### 3.5 Silent Worker Death: Telegram API Tanpa Timeout
*   **Masalah:** Fungsi `sendTelegramMessage` dan `sendTelegramAction` memanggil `fetch()` tanpa `AbortController`. Jika server Telegram lambat atau tidak merespon, Worker menggantung hingga batas 30 detik dan mati tanpa mengirim apapun.
*   **Solusi:** Menambahkan helper `fetchWithTimeout` di `telegram.js`:
    *   `sendTelegramAction` (typing indicator): timeout 5 detik.
    *   `sendTelegramMessage` (kirim pesan): timeout 10 detik.

### 3.6 Silent Worker Death: Download Media Tanpa Timeout
*   **Masalah:** `prepareMediaPart` mengunduh file dari server Telegram tanpa timeout. File besar (foto resolusi tinggi, voice panjang) bisa memakan waktu lama dan Worker mati paksa.
*   **Solusi:** Menambahkan `AbortController` timeout:
    *   `getFile` API call: timeout 5 detik.
    *   Download konten file: timeout 10 detik.

### 3.7 Memory Leak: Typing Timer Tidak Dihentikan
*   **Masalah:** `sendTyping` menggunakan `setTimeout` secara rekursif tetapi referensi timer tidak pernah dibersihkan. Meskipun flag `isProcessing` dicek, timer yang sudah terjadwal tetap akan berjalan sekali lagi setelah proses selesai.
*   **Solusi:** Menyimpan referensi `typingTimer` dan menambahkan `clearTimeout(typingTimer)` di blok `finally` dari `processMessage`.

### 3.8 Bottleneck CPU: Konversi Base64 Per-Byte
*   **Masalah:** Konversi ArrayBuffer ke Base64 menggunakan `for` loop per byte karakter. Untuk gambar 1 MB, loop berjalan 1 juta kali dan pasti memicu CPU limit exceeded.
*   **Solusi:** Fungsi `bufferToBase64` di `src/utils/array.js` menggunakan chunking 8KB dengan `String.fromCharCode.apply` dan `subarray`.

---

## 4. Timeout Budget Keseluruhan

Ringkasan alokasi timeout di seluruh sistem untuk memastikan total eksekusi tidak melebihi 30 detik (batas Cloudflare Workers Free Tier):

| Komponen | Timeout | Keterangan |
| :--- | :--- | :--- |
| `fetchGeminiGenerate` | 8 detik | Per-request ke Gemini API |
| `callGitHubAPI` | 15 detik | Per-request ke GitHub API |
| `sendTelegramMessage` | 10 detik | Per-pengiriman pesan ke Telegram |
| `sendTelegramAction` | 5 detik | Per-pengiriman typing indicator |
| `prepareMediaPart` (getFile) | 5 detik | Mendapatkan info file dari Telegram |
| `prepareMediaPart` (download) | 10 detik | Download konten media dari Telegram |
| `processMessage` (total) | **25 detik** | Batas total eksekusi pemrosesan pesan |
| `checkGeminiQuota` (total) | **25 detik** | Batas total eksekusi pengecekan kuota |
| `lockKey` TTL | 60 detik | Auto-expire lock jika Worker crash |

---

## 5. HF Spaces Integration (Docker Deployment)

### 5.1 Latar Belakang

Cloudflare Workers memiliki batasan CPU time (10ms per request di free tier, 30s wall-clock). Untuk tugas kompleks seperti cloning repo, menjalankan shell command, atau membaca banyak file secara lokal, diperlukan environment dengan resource lebih besar.

**Hugging Face Spaces (Docker)** menyediakan:
- CPU/memory lebih besar (tanpa batasan 10ms)
- Eksekusi hingga 240 detik per task
- Filesystem lokal (clone repo, baca/tulis file)
- Kemampuan menjalankan shell command (`git`, `npm`, dll)

### 5.2 Arsitektur Sebelumnya (Callback)

Awalnya, arsitektur menggunakan **callback langsung** dari Spaces ke Worker:

```
Telegram → Cloudflare Worker → HF Spaces (proses AI + tools)
                                ├── Spaces → Telegram API (kirim response)
                                └── Spaces → Worker /api/spaces-callback (simpan history + release lock)
```

Spaces bertanggung jawab mengirim response ke Telegram dan callback ke Worker.

### 5.3 Masalah: HF Memblokir Outbound HTTPS

Setelah deploy, ditemukan bahwa **semua outbound HTTPS dari HF Spaces gagal** dengan `ConnectTimeoutError`:

```
Telegram:     149.154.166.110:443 → ❌ ConnectTimeout
Cloudflare:   172.67.157.80:443   → ❌ ConnectTimeout
Cloudflare:   104.21.13.197:443   → ❌ ConnectTimeout
```

DNS resolve berhasil (IP benar), TCP SYN dikirim tapi **diam-diam di-drop firewall HF**.

Berdasarkan forum Hugging Face, ini adalah **intentional policy** — HF memblokir akses ke domain social media API dan beberapa IP range Cloudflare untuk mencegah abuse. Google API (Gemini) tetap berfungsi normal.

### 5.4 Solusi: Proxy + Short-Poll + Cron

Spaces bisa menerima koneksi masuk (inbound) di port 7860. Setelah selesai, Spaces **mengirim response via proxy** ke Worker (`/api/telegram-proxy/sendMessage`). Worker **short-poll** hasilnya untuk simpan history + cleanup. Cron sebagai jaring pengaman akhir.

```
Telegram → Worker → Spaces (POST /api/process)
                     ├── Respond {status: "processing"} immediately
                     ├── Proses AI + tools di background
                     ├── Kirim response via proxy ke Worker
                     │   └── POST /api/telegram-proxy/sendMessage → Worker → Telegram API
                     └── Result tersimpan di /api/result/{chatId}

Proxy sukses:
  Response terkirim cepat ke user ✅
  [WaitUntil] Worker short-poll Spaces → simpan history + release lock

Proxy gagal (NAT block):
  [WaitUntil] Worker short-poll Spaces tiap 10s, max 30s → deliver + simpan history

Short-poll gagal (Spaces lambat):
  [Cron tiap 60s] Worker polling Spaces → deliver + cleanup
```

### 5.5 Kenapa Polling?

| Alternatif | Masalah |
|---|---|
| WebSocket (Worker → Spaces) | Worker wall-clock 30s, Spaces perlu 240s |
| Reverse tunnel (Spaces → Worker) | Butuh outbound — blocked |
| Sync HTTP (Worker tunggu Spaces) | Worker timeout 30s |
| **Polling via cron** | ✅ Work dengan inbound-only. Latensi ~60s acceptable |

### 5.6 Kelebihan HF Spaces

- **Filesystem akses:** Clone repo, baca file lokal, grep, run command → `runCommand` tool
- **Waktu eksekusi panjang:** 240 detik vs 30s Worker
- **GitHub Actions delegation:** Untuk tugas berat, Spaces bisa trigger GHA runner
- **Self-reflection:** Spaces jalankan self-review kode setelah modifikasi file

### 5.7 Progress Message ("Cocoa sedang bekerja... ⏳")

Flow penanganan pesan progress:

1. Worker kirim task ke Spaces → Spaces return `{status: "processing"}`
2. Worker kirim "Cocoa sedang bekerja..." ke Telegram
3. Worker simpan `progress_msg:{chatId}` ke KV
4. Cron ambil result → kirim response → **hapus progress message** dari chat
5. Kalau gagal (Spaces restart): cron kirim pesan error + hapus progress message

Dengan polling, progress message **selalu dihapus** setelah response tiba — tidak seperti pendekatan callback yang rawan ghost message saat Spaces tidak bisa menghubungi Worker.

### 5.8 Temuan: HF Spaces Membatasi Koneksi Outbound ke Cloudflare Workers

#### 5.8.1 Gejala

Callback dari Spaces ke Worker (`{space}.workers.dev/api/spaces-callback`) menunjukkan pola gagal yang konsisten:

| Percobaan | Hasil |
|---|---|
| Callback pertama (segera setelah Worker→Spaces) | ✅ Sukses |
| Callback kedua (30 detik kemudian) | ❌ `Client network socket disconnected before secure TLS connection was established` |
| Semua heartbeat ping | ❌ `timeout` (socketevent) |

DNS resolve berhasil, TCP connect sukses, tetapi **TLS handshake gagal** — koneksi di-RST oleh middleware jaringan setelah koneksi pertama.

#### 5.8.2 Akar Masalah

HF Spaces menggunakan **NAT gateway bersama** untuk semua container. Gateway ini:

1. Mengizinkan **1 koneksi aktif** ke satu origin (`workers.dev`) dalam satu window waktu
2. Koneksi kedua dan seterusnya di-drop diam-diam (RST saat TLS handshake)
3. Tidak terkait dengan IPv6 (`--dns-result-order=ipv4first` sudah dipasang) atau DNS

Dengan arsitektur **callback** (Spaces→Worker terjadi hanya saat ada pesan), jeda antar pesan bisa berjam-jam — koneksi pertama selalu berhasil (karena Worker baru saja menghubungi Spaces), tetapi koneksi berikutnya gagal.

#### 5.8.3 Perbandingan dengan HuggingClaw / n8n

**HuggingClaw** (OpenClaw + Cloudflare Proxy) menggunakan arsitektur **fundamental berbeda** — forward proxy, bukan callback. Lihat `docs/research/huggingclaw-analysis.md` untuk analisis lengkap.

Perbedaan arsitektur:

| Aspek | HuggingClaw | Kita (kokoa-agent) |
|-------|-------------|---------------|
| **Arah komunikasi utama** | Space → Worker (Space initiate semua outbound via proxy) | Worker → Spaces (submit task), Spaces → Worker via proxy (response via telegram-proxy, callback simpan history) |
| **Masalah utama** | Outbound HTTP dari Space diblokir HF | **Callback** dari Space ke Worker diblokir HF NAT |
| **Solusi** | Route SEMUA traffic melalui Cloudflare Worker proxy | **Hybrid:** proxy pattern untuk Telegram response, callback untuk history save + lock release, short-poll sebagai fallback |
| **Telegram API access** | Via Cloudflare Worker proxy | Via Cloudflare Worker proxy (Spaces kirim ke Worker `/api/telegram-proxy/{method}`, Worker teruskan ke Telegram API) |

**Detail proxy HuggingClaw:**
- `cloudflare-proxy.js` di-load via `NODE_OPTIONS="--require"` — jalan sebelum kode apapun
- Memonkey-patch `https.request`, `http.request`, `fetch`, `undici.dispatch`, dan `require()`
- Setiap request ke BLOCKED_DOMAINS (`api.telegram.org`, `discord.com`, dll.):
  - Di-rewrite hostname-nya ke Cloudflare Worker proxy
  - **`delete newOptions.agent`** — bukan "hapus connection pool", tapi **safety measure**: ketika hostname berubah, agent yang terikat ke hostname asal akan memberikan TLS sessions untuk SNI yang salah. Ini memaksa fresh connection tiap request.
  - Ditambah header `x-target-host` (original hostname) dan `x-proxy-key` (shared secret)
- OpenClaw dikonfigurasi dengan `apiRoot`指向 Worker proxy, jadi secara native sudah kirim request ke proxy

**Kenapa HuggingClaw tidak perlu heartbeat untuk NAT:**
HuggingClaw tidak punya pola Spaces→Worker callback. Semua komunikasi Spaces→Worker melalui proxy request yang di-initiate oleh Spaces — arah inbound-friendly. Tidak perlu maintain NAT mapping karena setiap request sudah melewati proxy yang tidak diblokir.

**Yang bisa dipelajari:**
- `delete newOptions.agent` penting ketika hostname di-rewrite — jika kita perlu rewrite URL di masa depan, ini pattern yang harus diikuti
- HuggingClaw menggunakan **external** Cloudflare Worker cron (10 menit interval) untuk cegah Spaces sleep — ini lapisan terpisah dari proxy, mirip dengan cron kita untuk polling result

#### 5.8.4 Solusi yang Gagal: Persistent TLS Connection via keepAlive Agent

**Peringatan: Strategi ini terbukti GAGAL di HF Spaces. Dokumentasi sebagai pelajaran, bukan rekomendasi.**

Awalnya kita coba `keepAlive: true` + `maxSockets: 1` + heartbeat 5s:

```javascript
const workerAgent = new https.Agent({
  keepAlive: true,      // socket tetap hidup setelah request selesai
  maxSockets: 1,        // maksimal 1 koneksi ke origin
  keepAliveMsecs: 30000 // kirim TCP keepalive tiap 30 detik
});
```

**Mengapa gagal:**

```
1. KeepAlive socket A dibuat → NAT izinkan (first connection) ✅
2. Socket A dipakai heartbeat & callback ✅
3. Socket A mati (TLS error, NAT drop) ❌
4. workerAgent.destroy() → Socket A dibersihkan
5. NAT masih track Socket A di TIME_WAIT (~60-120 detik)
6. Heartbeat 5s coba bikin Socket B → NAT blokir ("second connection") ❌
7. workerAgent.destroy() lagi → loop tidak pernah recover ❌
```

`destroy()` justru MEMPERPARAH: bikin koneksi baru saat NAT masih di TIME_WAIT. Bandingkan dengan pendekatan HuggingClaw (`delete newOptions.agent`) yang pakai **fresh connections tanpa keepAlive** dan **interval request >60 detik** — setiap koneksi dianggap sebagai "first connection" oleh NAT karena TIME_WAIT sudah clear.

**Kesimpulan:** KeepAlive + heartbeat 5s + destroy on error tidak cocok untuk HF Spaces NAT. Fresh connections (tanpa keepAlive) dengan interval cukup panjang lebih reliable.

#### 5.8.5 Heartbeat: Tidak Efektif untuk Maintain NAT

Heartbeat 5 detik dari Spaces → Worker menggunakan agent keepAlive **terbukti tidak efektif** dari log:

```
11:39:09 — Container start, heartbeat mulai
11:39:xx — Heartbeat sukses (socket A terbentuk)
... beberapa menit ...
11:43:xx — Callback gagal / heartbeat error:
           "Client network socket disconnected before secure TLS connection was established"
11:43:xx — workerAgent.destroy()  
11:43:xx — Heartbeat 5s: socket baru → blocked → error → destroy → loop
... loop terus sampai container restart ...
```

**Masalah:**
- 5 detik terlalu cepat — tidak memberi waktu TIME_WAIT NAT untuk clear (~60-120 detik)
- Setelah koneksi pertama mati, semua koneksi berikutnya di blokir
- Loop: destroy → create → blocked → destroy → ... (tidak pernah recover)

**Rekomendasi:**
- Hapus heartbeat internal (Spaces → Worker)
- Ganti dengan external keepAlive (Worker cron ping Spaces) — arah inbound, tidak kena NAT restriction
- Jika pakai fresh connections untuk callback, pastikan interval retry >60 detik

#### 5.8.6 Kesimpulan untuk Arsitektur (Revisi)

| Pendekatan | Cara Kerja | Status |
|---|---|---|---|
| HuggingClaw: forward proxy via Cloudflare Worker | Fresh connections, no keepAlive, proxy all traffic | ✅ Works (berdasarkan repo dan user reports) |
| n8n: persistent connection (inferred) | Belum diverifikasi | ? |
| **Kita: keepAlive + heartbeat + destroy on error** | Satu koneksi persistent + ping 5s + cleanup | ❌ **GAGAL** (lihat seksi 5.8.4) |
| **Kita: proxy + short-poll** (sekarang) | Spaces kirim Telegram response via Worker proxy (`/api/telegram-proxy/{method}`). Short-poll ambil result untuk simpan history + cleanup. Tidak ada callback (dihapus karena retry-nya merusak NAT). Fresh connections, no keepAlive. | ✅ **Works** |

### 5.8.7 Arsitektur Hybrid (Adopsi dari HuggingClaw)

```
Telegram → Worker → Spaces (POST /api/process)
                     ├── Respond {status: "processing"} immediately
                     ├── Proses AI + tools di background
                     ├── Kirim response ke Telegram via Worker proxy
                     │   └── fresh POST /api/telegram-proxy/sendMessage → Worker → Telegram API
                     └── Result tersimpan di /api/result/{chatId}

Proxy pattern (Spaces→Worker→Telegram):
  - Spaces buka fresh connection ke Worker → Worker teruskan ke Telegram API
  - Tidak perlu keepAlive — setiap request independent
  - NAT treat sebagai "first connection" jika interval >60 detik dari request sebelumnya

Short-poll (Worker→Spaces, inbound):
  - Worker polling Spaces setiap 10s setelah submit task
  - Simpan history ke D1 + release lock + cleanup
  - Primary reliable path — proxy hanya optimasi untuk mengurangi latency

Dedup mechanism:
  - `proxySent` flag di result data → short-poll skip send jika proxy sukses
  - `callback_done` KV (TTL 300s) → cron skip jika short-poll sudah selesai
  - `hdl` mutex (TTL 120s) → cegah eksekusi concurrent
```

Kunci pelajaran:
1. **KeepAlive + destroy on error = GAGAL** — bikin NAT TIME_WAIT stuck
2. **Fresh connections** (tanpa keepAlive) works hanya untuk koneksi PERTAMA ke origin. Koneksi ke-2+ masuk TIME_WAIT → diblokir NAT. Periodic ping 90s juga gagal — NAT tidak bisa diakali.
3. **Proxy pattern** mengubah arah komunikasi: Spaces tidak perlu langsung ke Telegram API, cukup ke Worker yang teruskan. Fast path untuk first connection.
4. **Short-poll** (Worker → Spaces, inbound) satu-satunya reliable path. Tidak kena NAT restriction karena inbound.
5. **Callback dihapus** — retry 3× dengan delay 3s cuma memperparah NAT. Proxy (best-effort) + short-poll (reliable) sudah cukup.

---

## 6. Panduan Variabel Lingkungan (Environment Variables)

Berikut variabel konfigurasi di `wrangler.jsonc` atau dashboard Cloudflare yang penting untuk operasional bot ini:

| Variabel | Deskripsi | Contoh Nilai |
| :--- | :--- | :--- |
| `GEMINI_API_KEYS` | Daftar API Key Gemini dari Google AI Studio (pisahkan dengan koma). | `AIzaSyA..., AIzaSyB...` |
| `GEMINI_MODELS` | Daftar model Gemini yang digunakan untuk rotasi (pisahkan dengan koma). | `gemini-3.6-flash,gemini-3.5-flash-lite` |
| `TELEGRAM_BOT_TOKEN` | Token Bot Telegram Anda dari @BotFather. | `123456789:ABCDefGh...` |
| `ALLOWED_USER_ID` | Telegram User ID Anda agar bot hanya merespon Anda (keamanan). | `987654321` |
| `GITHUB_PAT_TOKEN` | Personal Access Token GitHub dengan hak akses repositori yang sesuai. | `ghp_abc123...` |
| `GEMINI_SYSTEM_PERSONA`| Perilaku dan kepribadian Cocoa. | *(Lihat wrangler.jsonc)* |
| `GEMINI_SYSTEM_INSTRUCTION`| Instruksi teknis untuk tinjauan kode / PR GitHub. | *(Lihat wrangler.jsonc)* |
| `HF_SPACES_URL` | URL HF Spaces Docker (aktifkan pemrosesan via Spaces). | `https://user-space.hf.space` |
| `WORKER_URL` | URL Worker untuk callback dari Spaces/GHA (otomatis). | `https://tg-bot.workers.dev` |
| `GROQ_API_KEY` | API Key Groq (fallback jika Gemini error). | `gsk_abc...` |
| `BING_API_KEY` | API Key Bing Web Search. | `abc123...` |

---

## 7. Struktur Direktori Proyek

```
kokoa-agent/
├── src/
│   ├── index.js                # Cloudflare Worker entry (fetch + scheduled/cron)
│   ├── agent-server.js         # HF Spaces standalone HTTP server
│   ├── config.js               # Konstanta konfigurasi (TTL, limit, dll.)
│   ├── db/
│   │   ├── schema.sql          # D1 database schema
│   │   └── index.js            # Database access layer (CRUD)
│   ├── handlers/
│   │   ├── webhook.js          # Webhook, command routing, lock management
│   │   ├── message.js          # Agent loop & tool calling
│   │   ├── api.js              # REST endpoints (callback, context, memory)
│   │   └── cron.js             # Scheduled handler (reminders + Spaces polling)
│   ├── services/
│   │   ├── gemini.js           # Integrasi Gemini API & pengecekan kuota
│   │   ├── groq.js             # Integrasi Groq API (fallback)
│   │   ├── github.js           # REST client helper untuk GitHub API
│   │   ├── hf-spaces.js        # Bridge Worker → HF Spaces
│   │   ├── media.js            # Download & konversi media ke Base64
│   │   ├── search.js           # Web search + web fetch
│   │   └── telegram.js         # Kirim pesan & typing indicator
│   ├── tools/
│   │   ├── definitions.js      # Tool schema untuk Gemini function calling
│   │   ├── executor.js         # Eksekutor tool (GitHub, web, memory, dll)
│   │   └── spaces-executor.js  # Eksekutor tool untuk Spaces (filesystem, shell)
│   ├── utils/
│   │   ├── array.js            # Utilitas array (shuffle, bufferToBase64)
│   │   ├── formatter.js        # Konversi Markdown → Telegram HTML
│   │   └── logger.js           # Error logging ke KV
│   └── scripts/
│       ├── runner-executor.js  # GHA runner entry point
│       └── runner-gemini.js    # GHA runner agent loop
├── docs/
│   ├── features.md             # Dokumentasi utama
│   └── research/
│       └── huggingclaw-analysis.md  # Analisis mendalam HuggingClaw
├── Dockerfile                  # HF Spaces Docker build
├── wrangler.jsonc              # Konfigurasi Cloudflare Workers
├── package.json
└── README.md
```
