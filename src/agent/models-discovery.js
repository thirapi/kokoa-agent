export async function fetchLiveGroqModels(apiKey) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data || [])
      .map((m) => m.id)
      .filter((id) => !id.includes("whisper") && !id.includes("guard") && !id.includes("vision"));
  } catch (_) {
    return null;
  }
}

export async function fetchLiveOpenRouterModels(apiKey) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data || [])
      .filter((m) => m.id?.endsWith(":free"))
      .map((m) => m.id);
  } catch (_) {
    return null;
  }
}

export async function fetchLiveGeminiModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models || [])
      .map((m) => (m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  } catch (_) {
    return null;
  }
}

export async function getValidModelsForProvider(providerName, apiKey, defaultModelsStr, env) {
  const fallbackModels = defaultModelsStr.split(",").map((m) => m.trim()).filter(Boolean);
  if (!apiKey || !env?.CHAT_HISTORY) return fallbackModels;

  const cacheKey = `live_models:${providerName}`;
  try {
    const cached = await env.CHAT_HISTORY.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  let liveModels = null;
  if (providerName === "groq") {
    liveModels = await fetchLiveGroqModels(apiKey);
  } else if (providerName === "openrouter") {
    liveModels = await fetchLiveOpenRouterModels(apiKey);
  } else if (providerName === "gemini") {
    liveModels = await fetchLiveGeminiModels(apiKey);
  }

  if (liveModels && liveModels.length > 0) {
    // Gemini: saring daftar konfigurasi dengan yang benar-benar hidup.
    // Model pensiun (mis. gemini-2.5-flash) otomatis terbuang tanpa perlu
    // update kode. Kalau irisannya kosong, pakai fallback (rotasi 404 yang urus).
    if (providerName === "gemini") {
      const alive = fallbackModels.filter((m) => liveModels.includes(m));
      if (alive.length > 0) {
        try {
          await env.CHAT_HISTORY.put(cacheKey, JSON.stringify(alive), { expirationTtl: 86400 });
        } catch (_) {}
        return alive;
      }
      return fallbackModels;
    }
    try {
      await env.CHAT_HISTORY.put(cacheKey, JSON.stringify(liveModels), { expirationTtl: 86400 });
    } catch (_) {}
    return liveModels;
  }

  return fallbackModels;
}
