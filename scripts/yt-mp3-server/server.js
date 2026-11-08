#!/usr/bin/env node
// Konverter YouTube -> MP3 pribadi (untuk belajar, non-komersial, dipakai sendiri).
//
// Kenapa server terpisah?
// - Konversi butuh binary `yt-dlp` + `ffmpeg`. Cloudflare Worker & Vercel tidak punya itu.
// - YouTube sering memblokir IP datacenter (HF Spaces, GitHub Actions). Jalankan server ini
//   di laptop/PC/home server (IP rumahan) lalu buka ke internet lewat tunnel (cloudflared).
//
// Alur:
//   bot (tool youtubeMp3) --GET /prepare--> server ini: mulai konversi di background
//   bot --sendAudio(url=/mp3?...)--> Telegram --GET /mp3--> server ini: kirim file .mp3
//
// Keamanan: setiap URL ditandatangani HMAC-SHA256 (MP3_CONVERTER_SECRET) + waktu kedaluwarsa,
// jadi orang lain yang tahu alamat tunnel-mu tidak bisa memakai konverter ini.
//
// Tanpa dependency npm: hanya modul bawaan Node (>= 18).

import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, existsSync, statSync, createReadStream, readdirSync, renameSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.MP3_CONVERTER_SECRET || "";
const CACHE_DIR = process.env.CACHE_DIR || join(process.cwd(), "mp3-cache");
const BITRATE = process.env.MP3_BITRATE || "128K"; // 128 kbps ≈ 1 MB/menit
const MAX_DURATION = Number(process.env.MAX_DURATION_SEC || 1200); // Telegram: file via URL maks 20 MB
const CACHE_HOURS = Number(process.env.CACHE_HOURS || 24);
const MAX_JOBS = Number(process.env.MAX_JOBS || 2);
const YTDLP = process.env.YTDLP_BIN || "yt-dlp";

if (SECRET.length < 16) {
  console.error("MP3_CONVERTER_SECRET wajib diset (min 16 karakter). Contoh: openssl rand -hex 24");
  process.exit(1);
}
mkdirSync(CACHE_DIR, { recursive: true });

// ID video YouTube selalu 11 karakter [A-Za-z0-9_-]. Validasi ketat = tidak ada injeksi argumen.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Harus identik dengan signMp3Url() di src/services/search.js.
function sign(videoId, exp) {
  return createHmac("sha256", SECRET).update(`${videoId}.${exp}`).digest("base64url");
}

function verify(videoId, exp, sig) {
  if (!VIDEO_ID.test(videoId || "")) return "videoId tidak valid";
  if (!exp || !sig) return "link tidak bertanda tangan";
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return "link kedaluwarsa";
  const expected = Buffer.from(sign(videoId, exp));
  const given = Buffer.from(String(sig || ""));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "tanda tangan salah";
  return null;
}

const mp3Path = (id) => join(CACHE_DIR, `${id}.mp3`);
const jobs = new Map(); // videoId -> Promise<path>; konversi yang sedang jalan dipakai bersama

function runYtDlp(videoId, outDir) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-playlist",
      "--no-progress",
      "--match-filter", `duration <= ${MAX_DURATION} & !is_live`,
      "-f", "bestaudio/best",
      "-x", "--audio-format", "mp3", "--audio-quality", BITRATE, // yt-dlp memanggil ffmpeg
      "--embed-metadata", // tag ID3 judul/artis
      "-o", join(outDir, "%(id)s.%(ext)s"),
      "--", videoId, // "--" : argumen setelahnya pasti bukan opsi
    ];
    const p = spawn(YTDLP, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    p.on("error", reject); // misal yt-dlp belum terpasang
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}: ${stderr.trim().split("\n").pop()}`))));
  });
}

function ensureMp3(videoId) {
  const final = mp3Path(videoId);
  if (existsSync(final)) return Promise.resolve(final);
  if (jobs.has(videoId)) return jobs.get(videoId);
  if (jobs.size >= MAX_JOBS) return Promise.reject(new Error("konverter sibuk, coba lagi sebentar"));

  const job = (async () => {
    // Kerja di folder sementara, lalu rename: file di cache selalu utuh.
    const tmp = mkdtempSync(join(CACHE_DIR, ".tmp-"));
    try {
      await runYtDlp(videoId, tmp);
      const out = join(tmp, `${videoId}.mp3`);
      if (!existsSync(out)) throw new Error(`video kepanjangan (> ${MAX_DURATION} detik), live, atau tidak tersedia`);
      renameSync(out, final);
      return final;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  })().finally(() => jobs.delete(videoId));
  jobs.set(videoId, job);
  return job;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const q = Object.fromEntries(url.searchParams);

  if (url.pathname === "/health") return json(res, 200, { ok: true, jobs: jobs.size });

  if (url.pathname !== "/prepare" && url.pathname !== "/mp3") return json(res, 404, { error: "not found" });
  const err = verify(q.v, q.exp, q.sig);
  if (err) return json(res, 403, { error: err });

  // /prepare: mulai konversi, tunggu sebentar (wait detik), lalu jawab statusnya.
  if (url.pathname === "/prepare") {
    const wait = Math.min(Number(q.wait || 0), 25) * 1000;
    let failed = null;
    const p = ensureMp3(q.v).catch((e) => { failed = e; });
    await Promise.race([p, new Promise((r) => setTimeout(r, wait))]);
    if (failed) return json(res, 422, { error: failed.message });
    return json(res, 200, { ok: true, status: existsSync(mp3Path(q.v)) ? "ready" : "converting" });
  }

  // /mp3: dipanggil Telegram. Kalau belum siap, tunggu konversinya selesai.
  try {
    const file = await ensureMp3(q.v);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": statSync(file).size,
      "Content-Disposition": `attachment; filename="${q.v}.mp3"`,
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 422, { error: e.message });
  }
});

// Bersihkan cache lama tiap jam.
setInterval(() => {
  const cutoff = Date.now() - CACHE_HOURS * 3600_000;
  for (const name of readdirSync(CACHE_DIR)) {
    const p = join(CACHE_DIR, name);
    try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true }); } catch {}
  }
}, 3600_000).unref();

server.listen(PORT, () => console.log(`yt-mp3-server jalan di http://localhost:${PORT} (cache: ${CACHE_DIR})`));
