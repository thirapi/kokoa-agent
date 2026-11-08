async function searchBing(query) {
  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&hl=en`;
  const res = await fetch(bingUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Bing returned HTTP ${res.status}`);
  let html = await res.text();
  html = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const MAX = 6000;
  return html.slice(0, MAX) || "Tidak ada hasil.";
}

async function searchSearxng(query) {
  const customInstance = (typeof process !== 'undefined' && process.env?.SEARXNG_INSTANCE) ? process.env.SEARXNG_INSTANCE : null;
  const instances = [
    ...(customInstance ? [customInstance] : []),
    "https://searx.be",
    "https://searx.namejeff.xyz",
    "https://sx.andrewyu.org",
  ];
  for (const instance of instances) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=id&categories=general`;
      const res = await fetch(url, {
        headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 429) continue;
      if (!res.ok) continue;
      const data = await res.json();
      const results = (data.results || []).slice(0, 8);
      if (results.length === 0) continue;
      return JSON.stringify(results.map(r => ({ title: r.title, url: r.url, snippet: (r.content || "").slice(0, 400) })));
    } catch (_) {}
  }
  throw new Error("SearXNG all failed");
}

// User-Agent sesuai kebijakan Wikimedia (nama bot + kontak). UA generik + banyak request
// paralel dibalas 403/429 -> dulu semua gambar Wikimedia dianggap "mati".
export const BOT_USER_AGENT = "KokoaBot/1.0 (https://github.com/thirapi/kokoa-agent; Telegram bot)";

// Host besar yang membatasi request beruntun (403/429) walau file-nya ada.
// Telegram yang mengunduh gambarnya nanti, jadi status itu tidak berarti file mati.
const RATE_LIMITED_IMAGE_HOSTS = /(^|\.)(upload\.wikimedia\.org|staticflickr\.com|flickr\.com)$/i;

// Cek URL gambar masih hidup via HEAD (Telegram harus bisa download URL-nya).
// 405/501 = server tidak suka HEAD tapi file biasanya ada -> anggap hidup.
export async function isImageAlive(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch (_) { return false; }
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": BOT_USER_AGENT },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return true;
    if (res.status === 405 || res.status === 501) return true;
    if ((res.status === 403 || res.status === 429) && RATE_LIMITED_IMAGE_HOSTS.test(host)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

// Cek bertahap (maks 2 paralel) & berhenti setelah cukup — tidak membanjiri satu host.
export async function keepAliveImages(results, want = 4) {
  const alive = [];
  for (let i = 0; i < results.length && alive.length < want; i += 2) {
    const batch = results.slice(i, i + 2);
    const ok = await Promise.all(batch.map((r) => (r.imageUrl ? isImageAlive(r.imageUrl) : false)));
    batch.forEach((r, j) => { if (ok[j]) alive.push(r); });
  }
  return alive;
}

async function imageSearchOpenverse(query) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=8&filter_dead=true`;
  const res = await fetch(url, {
    headers: { "User-Agent": BOT_USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Openverse HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.results || [])
    .filter(r => r.url)
    .map(r => ({ title: r.title || "", pageUrl: r.foreign_landing_url || "", imageUrl: r.url }));
  if (results.length === 0) throw new Error("Openverse kosong");
  const alive = await keepAliveImages(results);
  if (alive.length === 0) throw new Error("Openverse: semua URL gambar mati");
  return alive.slice(0, 6);
}

export async function imageSearch(query) {
  const errors = [];
  try {
    return await imageSearchOpenverse(query);
  } catch (e) {
    errors.push(`openverse: ${e.message}`);
  }
  const customInstance = (typeof process !== 'undefined' && process.env?.SEARXNG_INSTANCE) ? process.env.SEARXNG_INSTANCE : null;
  const instances = [
    ...(customInstance ? [customInstance] : []),
    "https://searx.be",
    "https://searx.namejeff.xyz",
    "https://sx.andrewyu.org",
  ];
  for (const instance of instances) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=id&categories=images`;
      const res = await fetch(url, {
        headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const results = (data.results || [])
        .filter(r => r.img_src)
        .slice(0, 8)
        .map(r => ({ title: r.title || "", pageUrl: r.url || "", imageUrl: r.img_src }));
      if (results.length === 0) continue;
      const alive = await keepAliveImages(results);
      if (alive.length === 0) continue;
      return alive.slice(0, 6);
    } catch (e) {
      errors.push(`${instance}: ${e.message}`);
    }
  }
  throw new Error("Semua image backend gagal: " + errors.join("; "));
}

// Cuplikan lagu (30 detik). iTunes membalas 429 ke IP Cloudflare Worker (IP bersama),
// jadi Deezer (gratis, tanpa key, cuplikan mp3) dipakai sebagai cadangan.
async function songSearchITunes(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=5&lang=id_id`;
  const res = await fetch(url, { headers: { "User-Agent": BOT_USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).filter((t) => t.previewUrl).map((t) => ({
    track: t.trackName || "",
    artist: t.artistName || "",
    album: t.collectionName || "",
    previewUrl: t.previewUrl,
    artworkUrl: (t.artworkUrl100 || "").replace("100x100", "600x600"),
    songUrl: t.trackViewUrl || "",
    source: "itunes",
  }));
}

async function songSearchDeezer(query) {
  const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`, {
    headers: { "User-Agent": BOT_USER_AGENT }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Deezer HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Deezer: ${data.error.message || "error"}`);
  return (data.data || []).filter((t) => t.preview).map((t) => ({
    track: t.title || "",
    artist: t.artist?.name || "",
    album: t.album?.title || "",
    previewUrl: t.preview,
    artworkUrl: t.album?.cover_xl || t.album?.cover_big || "",
    songUrl: t.link || "",
    source: "deezer",
  }));
}

export async function songSearch(query) {
  const errors = [];
  for (const [name, fn] of [["itunes", songSearchITunes], ["deezer", songSearchDeezer]]) {
    try {
      const results = await fn(query);
      if (results.length) return results;
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  if (errors.length === 2) throw new Error("Semua sumber lagu gagal: " + errors.join("; "));
  return { message: "Tidak ada lagu yang ketemu. Coba kata kunci lain ya!" };
}

// Groq built-in browser search (server-side, Exa-powered, no scraping).
// Model default kita (gpt-oss-20b/120b) support native — jauh lebih andal dari scrape Bing.
async function searchGroqBrowser(query, env) {
  const keys = ((env && env.GROQ_API_KEY) || "").split(",").map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("Tidak ada GROQ_API_KEY");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${keys[0]}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "user", content: `jawab ringkas dalam bahasa indonesia berdasarkan hasil browsing: ${query}` },
      ],
      temperature: 1,
      max_completion_tokens: 2048,
      top_p: 1,
      stream: false,
      reasoning_effort: "low",
      tool_choice: "required",
      tools: [{ type: "browser_search" }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Groq browser_search HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Groq browser_search kosong");
  return content;
}

// YouTube search via Invidious public API (tanpa key).
// Dipakai untuk full playback legal: bot bagikan link watch, user putar di YouTube.
// Pencarian YouTube tanpa key lewat endpoint Innertube (dipakai web YouTube sendiri).
// Instance Invidious publik sudah mati semua (diukur 2026-11-09) — jadi cadangan saja.
export async function youtubeSearchInnertube(query) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "id", gl: "ID" } },
      query,
    }),
  });
  if (!res.ok) throw new Error(`Innertube HTTP ${res.status}`);
  const data = await res.json();
  const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const results = sections
    .flatMap((sec) => sec.itemSectionRenderer?.contents || [])
    .map((c) => c.videoRenderer)
    .filter((v) => v?.videoId)
    .slice(0, 5)
    .map((v) => ({
      title: v.title?.runs?.map((r) => r.text).join("") || "",
      channel: v.ownerText?.runs?.[0]?.text || "",
      duration: v.lengthText?.simpleText || "",
      videoId: v.videoId,
      watchUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
    }));
  if (results.length === 0) throw new Error("Innertube kosong");
  return results;
}

export async function youtubeSearch(query) {
  try {
    return await youtubeSearchInnertube(query);
  } catch (e) {
    console.warn("[youtubeSearch] Innertube gagal, coba Invidious:", e.message);
  }
  const instances = [
    "https://invidious.f5.si",
    "https://inv.invidious.nerdvpn.de",
    "https://vid.puffyan.us",
  ];
  const errors = [];
  for (const base of instances) {
    try {
      const url = `${base}/api/v1/search?q=${encodeURIComponent(query)}&page=1&type=video`;
      const res = await fetch(url, {
        headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const results = (Array.isArray(data) ? data : [])
        .filter(r => r.type === "video" && r.videoId)
        .slice(0, 5)
        .map(r => ({
          title: r.title || "",
          channel: r.author || "",
          videoId: r.videoId,
          watchUrl: `https://www.youtube.com/watch?v=${r.videoId}`,
        }));
      if (results.length === 0) continue;
      return results;
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }
  throw new Error("Semua YouTube backend gagal: " + errors.join("; "));
}

// YouTube -> file MP3 lewat konverter pribadi (scripts/yt-mp3-server, yt-dlp + ffmpeg).
// YouTube tidak punya stream mp3, jadi harus dikonversi; Worker tidak bisa menjalankan ffmpeg.
// Env: MP3_CONVERTER_URL (alamat server/tunnel), MP3_CONVERTER_SECRET (kunci HMAC, sama dgn server).
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const MP3_MAX_SEC = 1200; // Telegram: file via URL maks 20 MB (~20 menit @128 kbps)

export function extractYouTubeId(text) {
  const s = String(text || "").trim();
  if (YT_ID.test(s)) return s;
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/.exec(s);
  return m ? m[1] : null;
}

// "4:05" / "1:02:03" -> detik. Innertube dengan hl=id memakai titik: "3.46" / "1.02.03".
export function parseDuration(text) {
  if (!text) return null;
  const parts = String(text).trim().split(/[:.]/).map(Number);
  if (parts.length > 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function base64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Harus identik dengan sign() di scripts/yt-mp3-server/server.js.
// Web Crypto dipakai agar jalan di Worker, Vercel, dan Node.
export async function signMp3Url(base, secret, videoId, ttlSec = 3600, path = "/mp3") {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${videoId}.${exp}`)));
  return `${base.replace(/\/+$/, "")}${path}?v=${videoId}&exp=${exp}&sig=${sig}`;
}

async function youtubeOEmbed(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return {};
    const d = await res.json();
    return { title: d.title || "", channel: d.author_name || "" };
  } catch {
    return {};
  }
}

export async function youtubeMp3(query, env) {
  const envOf = (k) => (env && env[k]) || (typeof process !== "undefined" && process.env?.[k]) || null;
  const base = envOf("MP3_CONVERTER_URL");
  const secret = envOf("MP3_CONVERTER_SECRET");

  // 1. Tentukan video: link/ID langsung, atau cari di YouTube.
  let video;
  const directId = extractYouTubeId(query);
  if (directId) {
    video = { videoId: directId, watchUrl: `https://www.youtube.com/watch?v=${directId}`, ...(await youtubeOEmbed(directId)) };
  } else {
    const results = await youtubeSearchInnertube(query);
    // lewati live (tanpa durasi) & video kepanjangan (mix 1 jam dll)
    video = results.find((v) => {
      const sec = parseDuration(v.duration);
      return sec && sec <= MP3_MAX_SEC;
    });
    if (!video) return { error: "Tidak ada video yang durasinya cocok (maks 20 menit).", results };
  }

  if (!base || !secret) {
    return {
      ...video,
      error: "Konverter MP3 belum dipasang (MP3_CONVERTER_URL/MP3_CONVERTER_SECRET kosong). Bagikan watchUrl saja ke user.",
    };
  }

  // 2. URL bertanda tangan untuk Telegram + minta server mulai konversi sekarang,
  //    supaya saat sendAudio dipanggil filenya sudah (hampir) siap.
  const mp3Url = await signMp3Url(base, secret, video.videoId);
  const prepareUrl = (await signMp3Url(base, secret, video.videoId, 3600, "/prepare")) + "&wait=12";
  let status = "unknown";
  try {
    const res = await fetch(prepareUrl, { signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ...video, error: `Konversi MP3 gagal: ${data.error || `HTTP ${res.status}`}. Bagikan watchUrl saja.` };
    status = data.status || "unknown";
  } catch (e) {
    if (e?.name !== "TimeoutError") {
      return { ...video, error: `Konverter MP3 tidak bisa dihubungi (${e.message}). Bagikan watchUrl saja.` };
    }
    status = "converting";
  }

  return {
    title: video.title || "",
    channel: video.channel || "",
    duration: video.duration || "",
    watchUrl: video.watchUrl,
    format: "mp3",
    status, // ready | converting
    mp3Url, // kirim via sendAudio (audioUrl=mp3Url, title, performer=channel)
  };
}

// Musik gratis berlisensi Creative Commons (ccMixter, tanpa key).
// Satu-satunya jalur file-full yang legal: kirim downloadUrl via sendAudio + cantumkan artis.
export async function freeMusicSearch(query) {
  const url = `https://ccmixter.org/api/query?f=json&limit=2&tags=${encodeURIComponent(query)}`;
  let data = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`ccMixter HTTP ${res.status}`);
      data = await res.json();
      break;
    } catch (e) {
      lastErr = e.message;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  if (!data) throw new Error(`ccMixter gagal 3x: ${lastErr}`);
  const results = (Array.isArray(data) ? data : [])
    .map(u => {
      const mp3 = (u.files || []).find(f => f.file_nicname === 'mp3' && f.download_url);
      if (!mp3) return null;
      return {
        title: u.upload_name || "",
        artist: u.user_real_name || u.user_name || "",
        license: u.license_name || "",
        licenseUrl: u.license_url || "",
        downloadUrl: mp3.download_url,
        pageUrl: u.file_page_url || "",
      };
    })
    .filter(Boolean);
  if (results.length === 0) return { message: "Tidak ada musik gratis yang cocok. Coba kata kunci mood/genre (misal: chill, rock, jazz) ya!" };
  return results;
}

export async function webSearch(query, env) {
  const errors = [];
  for (const searchFn of [(q) => searchGroqBrowser(q, env), searchBing, searchSearxng]) {
    try {
      const result = await searchFn(query);
      if (result) return result;
    } catch (e) {
      errors.push(`${searchFn.name || 'groqBrowser'}: ${e.message}`);
    }
  }
  throw new Error("Semua search backend gagal: " + errors.join("; "));
}


export async function webFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} saat fetch ${url}`);
  }

  const html = await res.text();

  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const MAX_LENGTH = 8000;
  if (text.length > MAX_LENGTH) {
    text = text.slice(0, MAX_LENGTH) + "... [dipotong]";
  }

  return text || "Halaman web tidak mengandung teks yang bisa dibaca.";
}
