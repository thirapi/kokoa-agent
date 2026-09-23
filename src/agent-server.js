import { createServer } from 'http';
import https from 'https';
import { execSync } from 'child_process';
import { runAgentLoop, buildProviderConfigs } from './handlers/message.js';
import { executeTool } from './tools/executor.js';
import { executeSpacesTool, isSpacesTool } from './tools/spaces-executor.js';
import { ApprovalPending, approvalButtons, approvalPromptText } from './agent/approval.js';

function isDirectNetworkError(e) {
  const m = String(e?.message || e);
  // Error API Telegram ("gagal (4xx)") BUKAN network — jangan fallback.
  if (/gagal \(\d{3}\)/.test(m)) return false;
  return /fetch failed|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timeout|network/i.test(m);
}

// Kirim via Worker proxy (Worker -> Telegram, bukan Spaces -> Telegram).
// Dipakai sebagai fallback saat egress Spaces putus tapi jalur ke Worker masih hidup.
function proxyTelegramDirect(method, body, timeoutMs = 45000) {
  if (!lastWorkerUrl) return Promise.resolve(null);
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve) => {
    try {
      const u = new URL(`/api/telegram-proxy/${method}`, lastWorkerUrl);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer kokoa-runner-secret',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(bodyStr);
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

export { isDirectNetworkError, proxyTelegramDirect, hybridExecutor, queuePendingMedia, takePendingMedia };

// Media yang gagal dikirim dari Spaces (egress putus) diantre di sini,
// lalu dikirim dari sisi Worker oleh spaces-poll (jalur Worker -> Telegram terbukti hidup).
// chatId -> array, maks 2 per sesi agar tidak spam bila model mencoba banyak URL.
const pendingMediaStore = new Map();

function queuePendingMedia(chatId, item) {
  const key = String(chatId);
  const arr = pendingMediaStore.get(key) || [];
  if (arr.length >= 2) arr.shift();
  arr.push(item);
  pendingMediaStore.set(key, arr);
}

function takePendingMedia(chatId) {
  const key = String(chatId);
  const arr = pendingMediaStore.get(key) || [];
  pendingMediaStore.delete(key);
  return arr;
}

async function hybridExecutor(name, args, env, chatId) {
  if (isSpacesTool(name)) {
    return executeSpacesTool(name, args, env, chatId);
  }
  try {
    return await executeTool(name, args, env, chatId);
  } catch (e) {
    // Fallback media: Spaces -> Telegram putus, coba Worker -> Telegram.
    if ((name === 'sendPhoto' || name === 'sendAudio') && isDirectNetworkError(e)) {
      console.log(`[Spaces] Direct ${name} gagal (${e.message}), coba via Worker proxy...`);
      const body = name === 'sendPhoto'
        ? { chat_id: Number(chatId), photo: args.imageUrl, ...(args.caption ? { caption: String(args.caption).slice(0, 1000) } : {}) }
        : {
            chat_id: Number(chatId), audio: args.audioUrl,
            ...(args.performer ? { performer: String(args.performer).slice(0, 200) } : {}),
            ...(args.title ? { title: String(args.title).slice(0, 200) } : {}),
            ...(args.caption ? { caption: String(args.caption).slice(0, 1000) } : {}),
          };
      const r = await proxyTelegramDirect(name === 'sendPhoto' ? 'sendPhoto' : 'sendAudio', body);
      if (r?.ok) {
        console.log(`[Spaces] ${name} terkirim via Worker proxy`);
        return r.result || { ok: true, via: 'worker-proxy' };
      }
      console.log(`[Spaces] Worker proxy juga gagal untuk ${name}`);
      // Antre untuk pengiriman dari sisi Worker (spaces-poll). Kembalikan pesan
      // sukses-tertunda agar model memberi tahu user medianya menyusul, bukan error.
      const item = name === 'sendPhoto'
        ? { kind: 'photo', url: args.imageUrl, caption: args.caption || '' }
        : { kind: 'audio', url: args.audioUrl, performer: args.performer || '', title: args.title || '', caption: args.caption || '' };
      queuePendingMedia(chatId, item);
      console.log(`[Spaces] ${name} antre untuk pengiriman via Worker`);
      return {
        queued: true,
        message: 'Jaringan ke Telegram sedang putus, jadi file ini DIANTRE dan akan dikirim otomatis menyusul dari server (bukan olehmu). Beri tahu user dengan santai bahwa fotonya/audionya segera menyusul. JANGAN tempel URL di teks jawaban.',
      };
    }
    throw e;
  }
}

// Install system dependencies at startup
try {
  execSync('apt-get update -qq && apt-get install -y -qq git', { stdio: 'pipe', timeout: 60000 });
  console.log('Git installed successfully');
} catch (e) {
  console.log('Git install failed (non-fatal):', e.message);
}

const PORT = parseInt(process.env.PORT || '7860', 10);

const workspaceStore = new Map();
// Task plan in-session per chat (Spaces tidak punya D1). Bentuk: { [chatId]: { seq, items: [...] } }
const tasksMemStore = {};
const resultsStore = new Map();
const RESULT_TTL = 60 * 60 * 1000; // 1 jam (sama dengan TTL pending di KV)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of resultsStore) {
    if (now - val.ts > RESULT_TTL) resultsStore.delete(key);
  }
}, 60000);
let lastWorkerUrl = null;

async function postWorkerJSON(path, obj, timeoutMs = 10000, attempts = 1) {
  if (!lastWorkerUrl) throw new Error('WORKER_URL belum tersedia');
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await postWorkerJSONOnce(path, obj, timeoutMs);
    } catch (e) {
      lastErr = e;
      // 4xx = salah request/auth, retry tidak membantu. 5xx/network/timeout = coba lagi.
      if (/Worker 4\d\d/.test(e.message)) throw e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

function postWorkerJSONOnce(path, obj, timeoutMs) {
  const bodyStr = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const u = new URL(path, lastWorkerUrl);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer kokoa-runner-secret',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve(d) : reject(new Error(`Worker ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

async function proxyFinalText(proxyTelegram, stringChatId, finalText) {
  const { markdownToRichHtml } = await import("./utils/formatter.js");
  const richHtml = markdownToRichHtml(finalText);
  const r = await proxyTelegram("sendMessage", {
    chat_id: Number(stringChatId), text: richHtml, parse_mode: "HTML",
  });
  return r?.ok === true;
}

async function finishSpacesResult(stringChatId, { finalText, newContent, escalationTriggered, progressMsgId, filesModified }, proxyTelegram) {
  const entry = {
    status: 'complete',
    finalText,
    newContent,
    escalationTriggered: !!escalationTriggered,
    filesModified: filesModified ?? null,
    error: null,
    proxySent: false,
    historySynced: false,
    pendingMedia: takePendingMedia(stringChatId),
    progressMsgId: progressMsgId || null,
    ts: Date.now(),
  };
  resultsStore.set(stringChatId, entry);
  if (!lastWorkerUrl) return entry;
  if (finalText) {
    try {
      if (await proxyFinalText(proxyTelegram, stringChatId, finalText)) entry.proxySent = true;
    } catch (e) {
      console.error('[Spaces] proxy final failed:', e.message);
    }
  }
  if (newContent && newContent.length > 0) {
    // Retry 3x: jalur Spaces -> Worker kadang ECONNRESET sesaat (TLS reset).
    let synced = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !synced; attempt++) {
      try {
        await postWorkerJSON('/api/spaces-callback', {
          chatId: stringChatId, newContents: newContent, token: 'kokoa-runner-secret', isFinal: true,
        });
        synced = true;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    if (synced) {
      entry.historySynced = true;
      console.log(`[Spaces] Synced new history to D1 for chat ${stringChatId}`);
    } else {
      console.error('[Spaces] Failed sync to D1 (3x):', lastErr?.message);
    }
  }
  return entry;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function buildProxyEnv(envVars) {
  const inMemoryKV = new Map();

  const proxyEnv = {
    ...envVars,
    TELEGRAM_BOT_TOKEN: envVars.TELEGRAM_BOT_TOKEN || '',
    GEMINI_API_KEYS: envVars.GEMINI_API_KEYS || '',
    GEMINI_MODELS: envVars.GEMINI_MODELS || 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3-flash-preview',
    GROQ_API_KEY: envVars.GROQ_API_KEY || '',
    GROQ_MODELS: envVars.GROQ_MODELS || 'openai/gpt-oss-20b,openai/gpt-oss-120b',
    OPENROUTER_API_KEY: envVars.OPENROUTER_API_KEY || '',
    OPENROUTER_MODELS: envVars.OPENROUTER_MODELS || 'openrouter/free,openai/gpt-oss-20b:free,openai/gpt-oss-120b:free',
    AI_PROVIDERS: envVars.AI_PROVIDERS || 'gemini,groq,openrouter',
    AGENT_MODE: envVars.AGENT_MODE || 'build',
    GITHUB_PAT_TOKEN: envVars.GITHUB_PAT_TOKEN || '',
    GEMINI_SYSTEM_PERSONA: envVars.GEMINI_SYSTEM_PERSONA || '',
    GEMINI_SYSTEM_INSTRUCTION: envVars.GEMINI_SYSTEM_INSTRUCTION || '',
    WORKER_URL: envVars.WORKER_URL || '',
    IS_SPACES: 'true',
    __TASKS_MEM: tasksMemStore,
    CHAT_HISTORY: {
      get: async (key) => inMemoryKV.get(key) || null,
      put: async (key, value, opts) => {
        inMemoryKV.set(key, value);
        if (opts?.expirationTtl) {
          setTimeout(() => inMemoryKV.delete(key), opts.expirationTtl * 1000);
        }
      },
      delete: async (key) => inMemoryKV.delete(key),
    },
    DB: {
      // Stub D1: task plan & pengingat jalan di memori in-session (lihat __TASKS_MEM),
      // sisanya no-op aman. .all()/.batch() wajib ada — db/index.js memakainya.
      prepare: () => ({
        bind: () => ({
          run: async () => {},
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async () => [],
    },
  };
  return proxyEnv;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    return;
  }

  if (url.pathname.startsWith('/api/result/') && req.method === 'GET') {
    const chatId = url.pathname.slice('/api/result/'.length);
    const data = resultsStore.get(chatId);
    if (!data) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    if (data.status === 'processing') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processing' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const { status: _s, ...cleanData } = data;
    res.end(JSON.stringify({ status: 'ready', ...cleanData }));
    return;
  }

  if (url.pathname === '/api/result' && req.method === 'DELETE') {
    const chatId = (new URL(req.url, `http://localhost:${PORT}`)).searchParams.get('chatId');
    if (chatId) resultsStore.delete(chatId);
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'deleted' }));
    return;
  }

  if (url.pathname === '/api/process' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { chatId, userPrompt, currentContents: rawContents, memories, tasks, mode, workerUrl: reqWorkerUrl, progressMsgId } = body;

      if (!chatId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing chatId' }));
        return;
      }

      // Store worker url for proxy & result polling
      if (reqWorkerUrl) {
        lastWorkerUrl = reqWorkerUrl;
      }

      const stringChatId = String(chatId);

      // Respond immediately to the Cloudflare Worker to prevent HTTP timeout
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processing' }));

      // Initialize result as 'processing' so cron doesn't clean up prematurely
      resultsStore.set(stringChatId, { status: 'processing', ts: Date.now() });

      (async () => {
        const proxyEnv = buildProxyEnv(process.env);
        if (lastWorkerUrl) {
          proxyEnv.WORKER_URL = lastWorkerUrl;
        }
        if (mode === 'plan' || mode === 'build') {
          proxyEnv.AGENT_MODE = mode;
        }

        async function proxyTelegram(method, body) {
          const url = new URL(`${lastWorkerUrl}/api/telegram-proxy/${method}`);
          const bodyStr = JSON.stringify(body);
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const result = await new Promise((resolve, reject) => {
                const req = https.request({
                  hostname: url.hostname,
                  path: url.pathname + url.search + `?_=${Date.now()}`,
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer kokoa-runner-secret',
                    'Content-Length': Buffer.byteLength(bodyStr),
                  },
                  timeout: 15000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
                  });
                });
                req.on('error', () => reject());
                req.on('timeout', () => { req.destroy(); reject(); });
                req.write(bodyStr);
                req.end();
              });
              if (result?.ok) return result;
            } catch {}
            if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
          }
          return null;
        }

        try {
          const originalHistoryLength = rawContents ? rawContents.length - 1 : 0;
          const currentContents = rawContents || [{ role: 'user', parts: [{ text: userPrompt || '' }] }];
          console.log(`[Spaces] Received chat ${stringChatId} rawContents.length=${rawContents?.length} historyLength=${originalHistoryLength} userPrompt="${(userPrompt || '').slice(0,50)}"`);

          if (memories) proxyEnv.__INJECTED_MEMORIES = memories;
          if (tasks) proxyEnv.__INJECTED_TASKS = tasks;

          // Restore persisted workspace for this chat session
          const workspaceKey = `workspace:${stringChatId}`;
          const savedState = workspaceStore.get(workspaceKey);
          if (savedState) {
            const savedPath = typeof savedState === 'string' ? savedState : savedState.path;
            const savedRepo = typeof savedState === 'string' ? null : savedState.repo;
            const { existsSync } = await import('fs');
            if (existsSync(savedPath)) {
              proxyEnv.__WORKSPACE = savedPath;
              if (savedRepo) proxyEnv.CURRENT_REPO = savedRepo;
              console.log(`[Spaces] Restored workspace for chat ${stringChatId}: ${savedPath}${savedRepo ? ` (repo: ${savedRepo})` : ''}`);
            } else {
              console.log(`[Spaces] Persisted workspace folder not found on disk (likely container restarted), clearing: ${savedPath}`);
              workspaceStore.delete(workspaceKey);
            }
          }

          const providerConfigs = await buildProviderConfigs(proxyEnv);
          if (providerConfigs.length === 0) {
            throw new Error('No AI providers configured');
          }

          const startTime = Date.now();
          const result = await runAgentLoop(
            currentContents, proxyEnv, stringChatId, userPrompt || '',
            providerConfigs, [], startTime,
            {
              executionTimeout: 240000, iterationTimeout: 30000, toolExecutor: hybridExecutor,
              runtime: 'spaces',
              saveSnapshot: async (id, snap) => {
                await postWorkerJSON('/api/approval-store', { id, snapshot: snap }, 10000, 3);
              },
              notifyApproval: async ({ id, tool, toolArgs }) => {
                await proxyTelegram('sendMessage', {
                  chat_id: Number(stringChatId),
                  text: approvalPromptText(tool, toolArgs),
                  parse_mode: 'HTML',
                  reply_markup: approvalButtons(id),
                });
              },
            }
          );

          // Persist workspace update if cloneRepo was called during this loop
          const newPath = proxyEnv.__WORKSPACE;
          const newRepo = proxyEnv.CURRENT_REPO;
          if (newPath && (!savedState || newPath !== (typeof savedState === 'string' ? savedState : savedState.path))) {
            workspaceStore.set(workspaceKey, { path: newPath, repo: newRepo || null });
            console.log(`[Spaces] Saved workspace for chat ${stringChatId}: ${newPath}${newRepo ? ` (repo: ${newRepo})` : ''}`);
          }

          const newContent = currentContents.slice(originalHistoryLength)
            .filter(c => !c._selfReflection);
          console.log(`[Spaces] originalHistoryLength=${originalHistoryLength} curLen=${currentContents.length} newLen=${newContent.length} roles=${newContent.map(c=>c.role).join(',')}`);
          let finalText = null;
          if (!result.escalationTriggered) {
            finalText = result.finalText || null;
          }

          await finishSpacesResult(stringChatId, {
            finalText, newContent,
            escalationTriggered: result.escalationTriggered,
            progressMsgId,
            filesModified: result.filesModified,
          }, proxyTelegram);
          console.log(`[Spaces] Result stored for chat ${stringChatId}`);

        } catch (err) {
          if (err instanceof ApprovalPending || err?.message === '__APPROVAL_PENDING__') {
            resultsStore.set(stringChatId, { status: 'awaiting_approval', approvalId: err.approvalId, ts: Date.now() });
            console.log(`[Spaces] Loop paused awaiting approval ${err.approvalId} for chat ${stringChatId}`);
            return;
          }
          console.error('[Spaces] Async agent loop error:', err);
          const errorMsg = err.message;
          const errorResult = {
            status: 'complete',
            finalText: null,
            newContent: [],
            escalationTriggered: false,
            error: errorMsg,
            proxySent: false,
            pendingMedia: takePendingMedia(stringChatId),
            progressMsgId: progressMsgId || null,
            ts: Date.now()
          };
          resultsStore.set(stringChatId, errorResult);
          console.log(`[Spaces] Error result stored for chat ${stringChatId}`);

          if (lastWorkerUrl) {
            // Send error via proxy
            const proxyOk = await proxyTelegram("sendMessage", {
              chat_id: Number(stringChatId),
              text: `yah eror pas jalanin di server: ${errorMsg}. coba kirim lagi ya!`,
            });

            // Mark proxySent in stored result
            if (proxyOk?.ok === true) {
              const existing = resultsStore.get(stringChatId);
              if (existing) { existing.proxySent = true; }
            }
          }

        }
      })();

      return;
    } catch (err) {
      console.error('Agent server error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/resume' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { approvalId, decision, snapshot } = body;
      if (!approvalId || !snapshot) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing approvalId/snapshot' }));
        return;
      }
      const stringChatId = String(snapshot.chatId || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'resumed' }));
      resultsStore.set(stringChatId, { status: 'processing', ts: Date.now() });

      (async () => {
        async function proxyTelegram2(method, body) {
          const url = new URL(`${lastWorkerUrl}/api/telegram-proxy/${method}`);
          const bodyStr = JSON.stringify(body);
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const result = await new Promise((resolve, reject) => {
                const req = https.request({
                  hostname: url.hostname,
                  path: url.pathname + url.search + `?_=${Date.now()}`,
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer kokoa-runner-secret',
                    'Content-Length': Buffer.byteLength(bodyStr),
                  },
                  timeout: 15000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
                  });
                });
                req.on('error', () => reject());
                req.on('timeout', () => { req.destroy(); reject(); });
                req.write(bodyStr);
                req.end();
              });
              if (result?.ok) return result;
            } catch {}
            if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
          }
          return null;
        }

        try {
          const proxyEnv = buildProxyEnv(process.env);
          if (lastWorkerUrl) proxyEnv.WORKER_URL = lastWorkerUrl;
          if (snapshot.mode === 'plan' || snapshot.mode === 'build') proxyEnv.AGENT_MODE = snapshot.mode;

          const workspaceKey = `workspace:${stringChatId}`;
          const savedState = workspaceStore.get(workspaceKey);
          if (savedState) {
            const savedPath = typeof savedState === 'string' ? savedState : savedState.path;
            const savedRepo = typeof savedState === 'string' ? null : savedState.repo;
            const { existsSync } = await import('fs');
            if (existsSync(savedPath)) {
              proxyEnv.__WORKSPACE = savedPath;
              if (savedRepo) proxyEnv.CURRENT_REPO = savedRepo;
            } else {
              workspaceStore.delete(workspaceKey);
            }
          }

          const providerConfigs = await buildProviderConfigs(proxyEnv);
          if (providerConfigs.length === 0) throw new Error('No AI providers configured');

          const resume = {
            contents: snapshot.contents,
            historyLen: snapshot.historyLen || 0,
            pendingTool: snapshot.pending || null,
            grantedKey: decision === 'approve' ? snapshot.pending?.key : null,
            deniedKey: decision === 'deny' ? snapshot.pending?.key : null,
          };
          const result = await runAgentLoop(
            snapshot.contents, proxyEnv, stringChatId, snapshot.userPrompt || '',
            providerConfigs, [], Date.now(),
            {
              executionTimeout: 240000, iterationTimeout: 30000, toolExecutor: hybridExecutor,
              runtime: 'spaces', resume,
              saveSnapshot: async (id, snap) => {
                await postWorkerJSON('/api/approval-store', { id, snapshot: snap }, 10000, 3);
              },
              notifyApproval: async ({ id, tool, toolArgs }) => {
                await proxyTelegram2('sendMessage', {
                  chat_id: Number(stringChatId),
                  text: approvalPromptText(tool, toolArgs),
                  parse_mode: 'HTML',
                  reply_markup: approvalButtons(id),
                });
              },
            }
          );

          const newPath = proxyEnv.__WORKSPACE;
          const newRepo = proxyEnv.CURRENT_REPO;
          if (newPath && (!savedState || newPath !== (typeof savedState === 'string' ? savedState : savedState.path))) {
            workspaceStore.set(workspaceKey, { path: newPath, repo: newRepo || null });
          }

          const fullContents = result.contents || snapshot.contents;
          const newContent = fullContents.slice(snapshot.historyLen || 0).filter(c => !c._selfReflection);
          let finalText = null;
          if (!result.escalationTriggered) {
            finalText = result.finalText || null;
          }
          await finishSpacesResult(stringChatId, {
            finalText, newContent,
            escalationTriggered: result.escalationTriggered,
            progressMsgId: null,
            filesModified: result.filesModified,
          }, proxyTelegram2);
          console.log(`[Spaces] Resume completed for chat ${stringChatId}`);
        } catch (err) {
          if (err instanceof ApprovalPending || err?.message === '__APPROVAL_PENDING__') {
            resultsStore.set(stringChatId, { status: 'awaiting_approval', approvalId: err.approvalId, ts: Date.now() });
            console.log(`[Spaces] Resume paused again awaiting approval ${err.approvalId}`);
            return;
          }
          console.error('[Spaces] Resume error:', err);
          resultsStore.set(stringChatId, {
            status: 'complete', finalText: null, newContent: [],
            escalationTriggered: false, error: err.message,
            proxySent: false, historySynced: false,
            pendingMedia: takePendingMedia(stringChatId),
            progressMsgId: null, ts: Date.now(),
          });
        }
      })();
      return;
    } catch (err) {
      console.error('Resume endpoint error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent server running on port ${PORT}`);
});
