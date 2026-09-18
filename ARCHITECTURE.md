# Telegram Bot Agent Architecture & Harness Flow

Dokumen ini menjelaskan alur kerja dan harness agent yang diadopsi dari arsitektur OpenSource / standard agent runtime.

## 1. Topologi Deployment & Dual Engine

1. **Cloudflare Workers (Edge Router & Lightweight Agent)**:
   - Menangani Webhook Telegram, Auth, D1 Database, dan Chat Lock.
   - Menjalankan agent loop via lightweight harness untuk task sederhana (<23s).
   - Menggunakan Provider Failover (Gemini <-> Groq).

2. **HuggingFace Spaces (`agent-server.js`)**:
   - Berfungsi sebagai **Dedicated Workspace Agent Engine** (Free CPU Tier).
   - Dilengkapi filesystem lokal, akses shell command, dan tool repository local.

3. **GitHub Actions (GHA Runner)**:
   - Target eskalasi otomatis untuk tugas berat (misal: analisis besar atau pengerjaan fitur >4 menit).

---

## 2. Diagram Alur Harness Agent

```
[ Telegram User / Web Chat ]
             │
             ▼
┌─────────────────────────────────────────┐
│       Cloudflare Worker / Express       │  (Lightweight Router)
└────────────────────┬────────────────────┘
                     │
         ┌───────────┴───────────┐
         │ Heavy / Local Task?   │
         └───┬───────────────┬───┘
         Tidak               Ya
         │                   │
         ▼                   ▼
┌─────────────────┐ ┌─────────────────────────────────┐
│ Single Agent    │ │ HF Spaces Agent Server          │
│ Harness (Worker)│ │ (Persistent Disk + Shell Tool)  │
└────────┬────────┘ └────────────────┬────────────────┘
         │                           │ > 4 Min Execution
         │                           ▼
         │                  ┌─────────────────────────┐
         │                  │ GitHub Actions Runner   │
         │                  │ (Background Heavy Job)  │
         │                  └─────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  Core Harness Layer (Unified Harness Standard)      │
│  - Automated Tool Calling & Validation              │
│  - Memory & Context Truncation Guard                │
│  - Failover Management & Safety Truncation          │
└─────────────────────────────────────────────────────┘
```

---

## 3. Ketentuan Tier & Biaya (100% Free Plan)

- **Cloudflare Workers**: Tier Gratis (100.000 request/hari).
- **HuggingFace Spaces**: Tier Gratis (CPU Basic).
- **GitHub Actions**: Tier Gratis (2.000 menit/bulan public repo).
- **Groq & Gemini API**: Tier Gratis API Key (dengan rotasi & failover otomatis).
