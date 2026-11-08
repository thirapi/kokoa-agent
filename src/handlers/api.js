import { updateTaskStatus, setMemory, deleteMemoriesByPrefix, getGHAContext, consumeGHAContext, getMemory, saveGHAContext, getHistory } from "../db/index.js";
import { isAuthorizedRequest } from "../utils/auth.js";


async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("TG send error:", e);
  }
}

export async function handleAPI(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") {
    return new Response(JSON.stringify({ status: "ok", ts: Date.now() }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Semua endpoint /api/* lain hanya untuk Spaces & GHA runner (fail-closed).
  if (!isAuthorizedRequest(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Hasil agent dari Vercel (POST oleh api/agent.js). Diantar persis seperti hasil Spaces:
  // simpan riwayat, kirim jawaban/approval, lepas lock, proses antrean.
  if (path === "/api/agent-result") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    let body;
    try { body = await request.json(); } catch (_) { return new Response("Bad JSON", { status: 400 }); }
    const chatId = body?.chatId ? String(body.chatId) : "";
    if (!chatId || !body.data) return new Response("Missing chatId/data", { status: 400 });
    const mutexKey = `hdl:${chatId}`;
    if (await env.CHAT_HISTORY.get(mutexKey)) return new Response("Already handled", { status: 200 });
    await env.CHAT_HISTORY.put(mutexKey, "1", { expirationTtl: 120 });
    ctx.waitUntil((async () => {
      const { handleSpacesResult } = await import("../services/spaces-poll.js");
      // Gagal karena jaringan/provider & prompt tersimpan -> kerjakan ulang di Worker.
      const retryPrompt = await env.CHAT_HISTORY.get(`spaces_prompt:${chatId}`);
      const { retryable } = await handleSpacesResult(env, chatId, body.data, body.data.progressMsgId,
        { source: "vercel", fallbackOnRetryable: !!retryPrompt }) || {};
      if (retryable) {
        await env.CHAT_HISTORY.delete(`spaces_prompt:${chatId}`).catch(() => {});
        const { processMessage } = await import("./message.js");
        await processMessage({ chat: { id: chatId }, text: retryPrompt }, env, { forceRuntime: "worker" });
      }
    })());
    return new Response("OK", { status: 200 });
  }

  if (path === "/api/runner-callback") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }


    try {
      const body = await request.json();
      const { chat_id, type, data } = body;

      if (!chat_id) {
        return new Response("Missing chat_id", { status: 400 });
      }

      switch (type) {
        case "task_update": {
          if (data.task_id && data.status) {
            await updateTaskStatus(env, chat_id, data.task_id, data.status);
          }
          break;
        }
        case "memory": {
          if (data.key && data.value) {
            await setMemory(env, chat_id, data.key, data.value);
          }
          break;
        }
        case "analysis_result": {
          let analysis = data.analysis || "gak ada hasil analisis.";
          const repo = data.repo || "";
          const header = `**Analisis Repo: ${repo}**\n\n`;
          const maxLen = 4000;
          if (analysis.length + header.length > maxLen) {
            analysis = analysis.substring(0, maxLen - header.length - 100) + `\n\n... *(laporan dipotong, terlalu panjang)*`;
          }
          const msg = header + analysis;
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chat_id, msg);

          await deleteMemoriesByPrefix(env, chat_id, "last_analysis_");
          const memoryKey = `last_analysis_${(repo || "unknown").replace(/[^a-zA-Z0-9_]/g, "_")}`;
          const truncated = analysis.length > 2500 ? analysis.substring(0, 2500) + "\n\n... (truncated)" : analysis;
          await setMemory(env, chat_id, memoryKey, truncated);
          await setMemory(env, chat_id, "last_analysis_repo", repo);
          break;
        }
        case "workflow_result": {
          await deleteMemoriesByPrefix(env, chat_id, "workflow_");
          if (data.status) {
            await setMemory(env, chat_id, "workflow_status", data.status);
          }
          if (data.pr_url) {
            await setMemory(env, chat_id, "workflow_pr_url", data.pr_url);
          }
          if (data.branch) {
            await setMemory(env, chat_id, "workflow_branch", data.branch);
          }
          if (data.error) {
            const errTrunc = data.error.length > 1500 ? data.error.substring(0, 1500) + "\n\n...(truncated)" : data.error;
            await setMemory(env, chat_id, "workflow_error", errTrunc);
          }

          let notif = "";
          if (data.status === "success") {
            notif = `selesai! PR: ${data.pr_url || "gak tau"}`;
          } else if (data.status === "no_changes") {
            notif = "selesai! gak ada perubahan yang diperlukan.";
          } else {
            notif = `duh error: ${(data.error || "gak tau kenapa").substring(0, 300)}`;
          }
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chat_id, notif);
          break;
        }
        default:
          return new Response("Unknown type", { status: 400 });
      }

      return new Response("OK", { status: 200 });
    } catch (e) {
      console.error("API callback error:", e);
      return new Response("Bad Request", { status: 400 });
    }
  }

  if (path === "/api/context" || path.startsWith("/api/context/")) {
    const contextId = path.startsWith("/api/context/") ? path.split("/api/context/")[1] : null;

    if (request.method === "GET" && contextId) {
      const ctx = await getGHAContext(env, contextId);
      if (!ctx) {
        return new Response("Not Found", { status: 404 });
      }
      await consumeGHAContext(env, contextId);
      return new Response(JSON.stringify(ctx), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "PUT" && contextId) {
      const body = await request.json();
      await saveGHAContext(env, { id: contextId, ...body });
      return new Response("OK", { status: 200 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  if (path === "/api/memory" || path.startsWith("/api/memory/")) {

    if (request.method === "POST") {
      const body = await request.json();
      const { chat_id, key, value } = body;
      if (chat_id && key && value) {
        await setMemory(env, chat_id, key, value);
        return new Response("OK", { status: 200 });
      }
      return new Response("Missing fields", { status: 400 });
    }

    if (request.method === "GET" && path.startsWith("/api/memory/")) {
      const parts = path.split("/");
      const chatId = parts[3];
      const key = parts.slice(4).join("/");
      if (chatId && key) {
        const value = await getMemory(env, chatId, key);
        return new Response(JSON.stringify({ key, value }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Missing params", { status: 400 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  // Outbound AI proxy: meneruskan request dari Spaces ke API AI eksternal
  // (generativelanguage.googleapis.com, api.groq.com, openrouter.ai).
  // Mengatasi pemblokiran NAT HF Spaces yang me-RST TLS langsung ke host AI.
  // Pola diadopsi dari HuggingClaw.
  if (path.startsWith("/api/ai-proxy/")) {
    const targetHost = request.headers.get("x-target-host");
    if (!targetHost) {
      return new Response("Missing x-target-host", { status: 400 });
    }
    // Allowlist ketat: tanpa ini endpoint ini jadi open proxy
    // dan bisa dipakai menembak host internal Cloudflare.
    const ALLOWED_AI_HOSTS = [
      "generativelanguage.googleapis.com",
      "api.groq.com",
      "openrouter.ai",
    ];
    if (!ALLOWED_AI_HOSTS.includes(targetHost)) {
      return new Response(`Host tidak diizinkan: ${targetHost}`, { status: 403 });
    }
    const subPath = path.slice("/api/ai-proxy".length);
    // WAJIB sertakan query string — Gemini auth lewat ?key=..., tanpa ini
    // semua request proxied akan 401/403 dari sisi Google.
    const targetUrl = `https://${targetHost}${subPath}${url.search}`;
    try {
      const method = request.method;
      const reqHeaders = {};
      const contentType = request.headers.get("content-type");
      if (contentType) reqHeaders["Content-Type"] = contentType;
      const authHeader = request.headers.get("x-target-auth");
      if (authHeader) reqHeaders["Authorization"] = authHeader;

      const fetchOpts = { method, headers: reqHeaders };
      if (method !== "GET" && method !== "HEAD") {
        fetchOpts.body = await request.text();
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      const aiRes = await fetch(targetUrl, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timeoutId);
      const resText = await aiRes.text();
      return new Response(resText, {
        status: aiRes.status,
        headers: { "Content-Type": aiRes.headers.get("content-type") || "application/json" },
      });
    } catch (e) {
      console.error("AI proxy error:", e);
      return new Response(JSON.stringify({ error: { message: `Worker proxy error: ${e.message}` } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (path.startsWith("/api/telegram-proxy/")) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }


    const method = path.slice("/api/telegram-proxy/".length);
    if (!method) {
      return new Response("Missing method", { status: 400 });
    }

    try {
      const body = await request.json();
      const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
      const tgRes = await fetch(tgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const tgData = await tgRes.json();
      return new Response(JSON.stringify(tgData), {
        status: tgRes.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      console.error("Telegram proxy error:", e);
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (path.startsWith("/api/history/")) {

    const chatId = path.slice("/api/history/".length);
    if (!chatId) {
      return new Response("Missing chatId", { status: 400 });
    }

    try {
      const history = await getHistory(env, chatId);
      return new Response(JSON.stringify(history), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      console.error("History fetch error:", e);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}
