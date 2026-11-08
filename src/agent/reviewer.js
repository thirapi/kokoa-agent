// Reviewer independen: panggilan model TERPISAH (tanpa persona, tanpa tools, tanpa
// riwayat chat) yang hanya melihat diff. Agent yang menulis/ingin merge tidak
// me-review dirinya sendiri — merge diblokir bila reviewer meminta perubahan.
import { postChatCompletions } from "../services/openai-compat.js";

const MAX_DIFF_CHARS = 30000;

export const REVIEWER_PROMPT =
  "You are a strict senior code reviewer. Review ONLY the diff below for: correctness bugs, " +
  "data races, broken or wrong tests, security issues (injection, XSS, secrets), and obvious crashes. " +
  "Ignore style nits. Reply with ONLY a JSON object: " +
  '{"verdict":"approve"|"request_changes","reasons":["short reason", ...]} . ' +
  "Use request_changes only for real defects that should block a merge.";

export function parseVerdict(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const verdict = o.verdict === "approve" ? "approve" : o.verdict === "request_changes" ? "request_changes" : null;
    if (!verdict) return null;
    const reasons = Array.isArray(o.reasons) ? o.reasons.map(String).slice(0, 6) : [];
    return { verdict, reasons };
  } catch (_) {
    return null;
  }
}

async function callGemini(env, prompt) {
  const key = (env.GEMINI_API_KEYS || "").split(",")[0].trim();
  if (!key) return null;
  const models = (env.REVIEWER_MODELS || env.GEMINI_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  for (const model of models.slice(0, 2)) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: REVIEWER_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const v = parseVerdict(text);
      if (v) return { ...v, model: `gemini/${model}` };
    } catch (_) {}
  }
  return null;
}

async function callOpenAICompat(url, key, model, label, prompt) {
  try {
    const data = await postChatCompletions(url, { Authorization: `Bearer ${key}` }, {
      model, temperature: 0,
      messages: [{ role: "system", content: REVIEWER_PROMPT }, { role: "user", content: prompt }],
    }, `${label.toUpperCase()}_REVIEW_ERROR`);
    const v = parseVerdict(data.choices?.[0]?.message?.content);
    return v ? { ...v, model: `${label}/${model}` } : null;
  } catch (_) {
    return null;
  }
}

// Return { verdict, reasons, model } atau null bila tidak ada reviewer yang bisa dihubungi.
export async function independentReview(env, { diff, title = "" }) {
  const body = String(diff || "");
  const prompt = `PR: ${title}\n\n${body.length > MAX_DIFF_CHARS ? body.slice(0, MAX_DIFF_CHARS) + "\n[diff dipotong]" : body}`;
  const order = [
    () => callGemini(env, prompt),
    () => env.CEREBRAS_API_KEY && callOpenAICompat("https://api.cerebras.ai/v1/chat/completions",
      env.CEREBRAS_API_KEY.split(",")[0].trim(), "gpt-oss-120b", "cerebras", prompt),
    () => env.OPENROUTER_API_KEY && callOpenAICompat("https://openrouter.ai/api/v1/chat/completions",
      env.OPENROUTER_API_KEY.split(",")[0].trim(), "openrouter/free", "openrouter", prompt),
  ];
  for (const attempt of order) {
    const v = await attempt();
    if (v) return v;
  }
  return null;
}

// Ambil teks diff hasil getPRDiff untuk PR yang sama dari riwayat loop.
export function findPRDiff(contents, args = {}) {
  const want = String(args.pull_number ?? "");
  let pending = false;
  for (const c of contents || []) {
    for (const p of c.parts || []) {
      if (p.functionCall?.name === "getPRDiff") pending = String(p.functionCall.args?.pull_number ?? "") === want;
      if (pending && p.functionResponse?.name === "getPRDiff") {
        let r = p.functionResponse.response?.content;
        if (r && typeof r === "object" && "untrusted_content" in r) r = r.untrusted_content;
        return typeof r === "string" ? r : JSON.stringify(r ?? "");
      }
    }
  }
  return null;
}
