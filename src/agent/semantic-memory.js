// Memori semantik: Cloudflare Vectorize + embedding multibahasa Workers AI (bge-m3, 1024 dim).
// Setiap memori (remember) juga di-embed; sebelum menjawab, Worker mencari memori yang
// MAKNANYA relevan dengan pesan user (bukan cuma nama key) dan menyisipkannya ke prompt.
// Namespace = chatId, jadi memori antar-chat tidak pernah tercampur.

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const MIN_SCORE = 0.45;

export function semanticMemoryAvailable(env) {
  return !!(env?.VECTORIZE?.query && env?.AI?.run);
}

// ID stabil per (chat, key) -> upsert menimpa, forget menghapus tepat.
export async function memoryVectorId(chatId, key) {
  const data = new TextEncoder().encode(`${chatId}:${key}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function embed(env, texts) {
  const out = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  return out?.data || [];
}

export async function indexMemory(env, chatId, key, value) {
  if (!semanticMemoryAvailable(env)) return false;
  try {
    const [vector] = await embed(env, [`${key}: ${value}`]);
    if (!vector) return false;
    await env.VECTORIZE.upsert([{
      id: await memoryVectorId(chatId, key),
      values: vector,
      namespace: String(chatId),
      metadata: { key: String(key).slice(0, 200), value: String(value).slice(0, 1500) },
    }]);
    return true;
  } catch (e) {
    console.error("[SemanticMemory] index gagal:", e.message);
    return false;
  }
}

export async function forgetMemoryVector(env, chatId, key) {
  if (!semanticMemoryAvailable(env)) return;
  try {
    await env.VECTORIZE.deleteByIds([await memoryVectorId(chatId, key)]);
  } catch (e) {
    console.error("[SemanticMemory] hapus gagal:", e.message);
  }
}

// -> [{ key, value, score }] terurut paling relevan
export async function searchMemories(env, chatId, query, topK = 4) {
  if (!semanticMemoryAvailable(env) || !String(query || "").trim()) return [];
  try {
    const [vector] = await embed(env, [String(query).slice(0, 2000)]);
    if (!vector) return [];
    const res = await env.VECTORIZE.query(vector, { topK, namespace: String(chatId), returnMetadata: "all" });
    return (res?.matches || [])
      .filter((m) => m.score >= MIN_SCORE && m.metadata?.key)
      .map((m) => ({ key: m.metadata.key, value: m.metadata.value, score: Math.round(m.score * 100) / 100 }));
  } catch (e) {
    console.error("[SemanticMemory] cari gagal:", e.message);
    return [];
  }
}

export function relevantMemoriesBlock(list) {
  if (!Array.isArray(list) || list.length === 0) return "";
  return "[memori yang relevan dengan pesan ini:]\n" + list.map((m) => `- ${m.key}: ${m.value}`).join("\n");
}
