import { updateTaskStatus, setMemory, deleteMemoriesByPrefix, getGHAContext, consumeGHAContext, getMemory, saveGHAContext, acquireChatLock, releaseChatLock, removePendingSpace, getHistory, addHistory, trimHistory, getAllMemories, getTasks, clearHistory } from "../db/index.js";
import { MAX_HISTORY } from "../config.js";
import { processWebChatViaSend } from "../services/web-chat.js";

const CALLBACK_TOKEN = "kokoa-runner-secret";

const RESULT_TTL = 60 * 60; // 1 jam (detik, untuk KV expiration)

function resultKey(chatId) {
  return `web_chat_result:${chatId}`;
}

async function setResult(env, chatId, data) {
  await env.CHAT_HISTORY.put(resultKey(chatId), JSON.stringify(data), { expirationTtl: RESULT_TTL });
}

async function getResult(env, chatId) {
  const raw = await env.CHAT_HISTORY.get(resultKey(chatId));
  return raw ? JSON.parse(raw) : null;
}

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

  // Web Chat: Send message (auto-routes to Spaces or Worker)
  if (path === "/api/web-chat/send" && request.method === "POST") {
    try {
      const body = await request.json();
      const { message } = body;

      if (!message) {
        return new Response(JSON.stringify({ error: "Missing message" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const chatId = "web_user";

      await setResult(env, chatId, { status: 'processing', ts: Date.now() });

      ctx.waitUntil((async () => {
        try {
          // Auto-detect mode and route
          const mode = env.HF_SPACES_URL ? 'spaces' : 'worker';
          console.log(`[Web Chat] Processing message via ${mode}`);

          const result = await processWebChatViaSend(env, message, mode);
          await setResult(env, chatId, { ...result, ts: Date.now() });
        } catch (err) {
          console.error('[Web Chat] Processing error:', err);
          await setResult(env, chatId, {
            status: 'complete',
            finalText: null,
            error: err.message,
            ts: Date.now()
          });
        }
      })());

      // Don't wait for processing, respond immediately
      return new Response(JSON.stringify({ status: 'processing', chatId }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error('[Web Chat] Send error:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Web Chat: Reset history
  if (path === "/api/web-chat/reset" && request.method === "POST") {
    try {
      const chatId = "web_user";
      await clearHistory(env, chatId);
      await env.CHAT_HISTORY.delete(resultKey(chatId));
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error('[Web Chat] Reset error:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Web Chat: Get history
  if (path === "/api/web-chat/history" && request.method === "GET") {
    try {
      const chatId = "web_user";
      const history = await getHistory(env, chatId, 100);
      return new Response(JSON.stringify({ history }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error('[Web Chat] History error:', err);
      return new Response(JSON.stringify({ error: err.message, history: [] }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Web Chat: Get result (polling)
  if (path === "/api/web-chat/result" && request.method === "GET") {
    try {
      const chatId = "web_user";
      const data = await getResult(env, chatId);

      if (!data) {
        return new Response(JSON.stringify({ status: "not_found" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (data.status === "processing" || data.status === "complete") {
        return new Response(JSON.stringify({
          status: data.status === "complete" ? "ready" : "processing",
          finalText: data.finalText,
          error: data.error
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        status: "ready",
        finalText: data.finalText,
        error: data.error
      }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error('[Web Chat] Result error:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (path === "/api/runner-callback") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
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
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
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
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = await request.json();
      await saveGHAContext(env, { id: contextId, ...body });
      return new Response("OK", { status: 200 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  if (path === "/api/memory" || path.startsWith("/api/memory/")) {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

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

  // Spaces menitipkan snapshot approval ke KV Worker (agar survive restart + bisa di-resume)
  if (path === "/api/approval-store" && request.method === "POST") {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      const body = await request.json();
      const { id, snapshot } = body;
      if (!id || !snapshot) {
        return new Response("Missing id/snapshot", { status: 400 });
      }
      await env.CHAT_HISTORY.put(`approval:${id}`, JSON.stringify({ status: "pending", snapshot }), { expirationTtl: 3600 });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
    }
  }

  // Outbound AI proxy: meneruskan request dari Spaces ke API AI eksternal
  // (generativelanguage.googleapis.com, api.groq.com, openrouter.ai).
  // Mengatasi pemblokiran NAT HF Spaces yang me-RST TLS langsung ke host AI.
  // Pola diadopsi dari HuggingClaw.
  if (path.startsWith("/api/ai-proxy/")) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const targetHost = request.headers.get("x-target-host");
    if (!targetHost) {
      return new Response("Missing x-target-host", { status: 400 });
    }
    const subPath = path.slice("/api/ai-proxy".length);
    const targetUrl = `https://${targetHost}${subPath}`;
    try {
      const bodyText = await request.text();
      const reqHeaders = { "Content-Type": "application/json" };
      const authHeader = request.headers.get("x-target-auth");
      if (authHeader) reqHeaders["Authorization"] = authHeader;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      const aiRes = await fetch(targetUrl, {
        method: "POST",
        headers: reqHeaders,
        body: bodyText,
        signal: controller.signal,
      });
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

    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
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
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

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

  if (path === "/api/health") {
    return new Response(JSON.stringify({ status: "ok", ts: Date.now() }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not Found", { status: 404 });
}
