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

async function imageSearchOpenverse(query) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=6&filter_dead=false`;
  const res = await fetch(url, {
    headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Openverse HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.results || [])
    .filter(r => r.url)
    .map(r => ({ title: r.title || "", pageUrl: r.foreign_landing_url || "", imageUrl: r.url }));
  if (results.length === 0) throw new Error("Openverse kosong");
  return results;
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
        .slice(0, 6)
        .map(r => ({ title: r.title || "", pageUrl: r.url || "", imageUrl: r.img_src }));
      if (results.length === 0) continue;
      return results;
    } catch (e) {
      errors.push(`${instance}: ${e.message}`);
    }
  }
  throw new Error("Semua image backend gagal: " + errors.join("; "));
}

export async function songSearch(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=5&lang=id_id`;
  const res = await fetch(url, {
    headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`iTunes returned HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.results || []).map(t => ({
    track: t.trackName || "",
    artist: t.artistName || "",
    album: t.collectionName || "",
    previewUrl: t.previewUrl || "",
    artworkUrl: (t.artworkUrl100 || "").replace("100x100", "600x600"),
    songUrl: t.trackViewUrl || "",
  }));
  if (results.length === 0) return { message: "Tidak ada lagu yang ketemu. Coba kata kunci lain ya!" };
  return results;
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
export async function youtubeSearch(query) {
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

// Audio FULL lagu dari YouTube via Piped instance (tanpa key).
// PENTING: stream asli YouTube itu m4a/webm (opus), BUKAN mp3 — YouTube tidak punya stream mp3.
// - Tanpa COBALT_INSTANCE: return audioUrl langsung (m4a, bisa dikirim via sendAudio, Telegram bisa putar).
// - Dengan COBALT_INSTANCE (self-host imput/cobalt): resolve ke file MP3 beneran,
//   return mp3Url siap kirim via sendAudio.
// Env (Worker KV/secrets atau process.env di Spaces): PIPED_INSTANCE (opsional),
// COBALT_INSTANCE (opsional, misal https://cobalt.milikmu.id).
export async function pipedAudioSearch(query, env) {
  const envOf = (k) => (env && env[k]) || (typeof process !== 'undefined' && process.env?.[k]) || null;
  const customPiped = envOf("PIPED_INSTANCE");
  const instances = [
    ...(customPiped ? [customPiped.replace(/\/+$/, "")] : []),
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.reallyaweso.me",
  ];
  const errors = [];
  for (const base of instances) {
    try {
      // 1. Cari video pertama yang cocok
      const searchUrl = `${base}/search?q=${encodeURIComponent(query)}&filter=videos`;
      const res = await fetch(searchUrl, {
        headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        errors.push(`${base}: search HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      const video = items.find(i => typeof i?.url === "string" && i.url.includes("watch?v="));
      if (!video) {
        errors.push(`${base}: tidak ada video yang cocok`);
        continue;
      }
      const m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(video.url);
      if (!m) {
        errors.push(`${base}: videoId tidak kebaca`);
        continue;
      }
      const videoId = m[1];
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

      // 2. Ambil daftar audio stream (direct GoogleVideo URL)
      const sRes = await fetch(`${base}/streams/${videoId}`, {
        headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!sRes.ok) {
        errors.push(`${base}: streams HTTP ${sRes.status}`);
        continue;
      }
      const streams = await sRes.json();
      const audioStreams = (streams.audioStreams || []).filter(a => a?.url);
      if (audioStreams.length === 0) {
        errors.push(`${base}: tidak ada audio stream`);
        continue;
      }
      const byBitrate = [...audioStreams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const m4a = byBitrate.find(a => /mp4a|m4a/i.test(`${a.codec || ""} ${a.mimeType || ""}`));
      const best = m4a || byBitrate[0];
      const ext = /opus|webm/i.test(`${best.codec || ""} ${best.mimeType || ""}`) ? "webm" : "m4a";

      const result = {
        title: streams.title || video.title || "",
        artist: streams.uploader || video.uploaderName || "",
        watchUrl,
        format: ext, // format asli stream: m4a/webm (BUKAN mp3)
        mimeType: best.mimeType || "",
        bitrate: best.bitrate || null,
        audioUrl: best.url, // direct GoogleVideo URL — cepat kedaluwarsa, langsung kirim via sendAudio
        duration: streams.duration ?? null,
      };

      // 3. Cobalt (opsional): convert ke file MP3 beneran
      const cobalt = envOf("COBALT_INSTANCE");
      if (cobalt) {
        try {
          const cRes = await fetch(cobalt.replace(/\/+$/, "") + "/", {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ url: watchUrl, downloadMode: "audio", audioFormat: "mp3" }),
            signal: AbortSignal.timeout(30000),
          });
          if (cRes.ok) {
            const cData = await cRes.json();
            if ((cData.status === "tunnel" || cData.status === "redirect") && cData.url) {
              result.format = "mp3";
              result.mp3Url = cData.url; // URL file MP3 — kirim ini via sendAudio
              result.via = "cobalt";
            } else {
              result.cobaltNote = `cobalt status: ${cData.status || "unknown"}`;
            }
          } else {
            result.cobaltNote = `cobalt HTTP ${cRes.status}`;
          }
        } catch (e) {
          result.cobaltNote = `cobalt gagal: ${e.message}`;
        }
      } else {
        result.note = "mau file MP3 beneran? set COBALT_INSTANCE (self-host imput/cobalt) — tanpa itu hasilnya stream m4a/webm langsung.";
      }
      return result;
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }
  throw new Error("Semua Piped backend gagal: " + errors.join("; "));
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
