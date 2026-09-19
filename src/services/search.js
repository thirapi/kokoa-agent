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
