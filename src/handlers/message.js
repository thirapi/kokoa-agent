import { MAX_HISTORY, MAX_AGENT_ITERATIONS, EXECUTION_TIMEOUT, AGENT_ITERATION_TIMEOUT } from "../config.js";
import { fetchGeminiGenerate } from "../services/gemini.js";
import { fetchGroqGenerate } from "../services/groq.js";
import { fetchOpenRouterGenerate } from "../services/openrouter.js";
import { prepareMediaPart } from "../services/media.js";
import {
  sendTelegramAction,
  sendTelegramMessage,
} from "../services/telegram.js";
import { executeTool } from "../tools/executor.js";
import { runHarnessToolCall, isWriteTool } from "../tools/harness.js";
import { validateToolArgs } from "../agent/registry.js";
import { getValidModelsForProvider } from "../agent/models-discovery.js";
import { markdownToRichHtml } from "../utils/formatter.js";
import { shuffleArray } from "../utils/array.js";
import { logError } from "../utils/logger.js";
import {
  getHistory,
  addHistory,
  trimHistory,
  clearHistory,
  saveGHAContext,
  getTasks,
  getAllMemories,
  acquireChatLock,
  releaseChatLock,
} from "../db/index.js";
import { callGitHubAPI } from "../services/github.js";
import { webSearch, webFetch } from "../services/search.js";

export async function buildProviderConfigs(env) {
  const configs = [];

  if (env.GEMINI_API_KEYS) {
    const key = env.GEMINI_API_KEYS.split(",")[0].trim();
    const models = await getValidModelsForProvider(
      "gemini", key,
      env.GEMINI_MODELS || "gemini-3.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-3-flash-preview,gemini-3.1-pro-preview",
      env
    );
    configs.push({
      name: "gemini",
      keys: env.GEMINI_API_KEYS.split(",").map((k) => k.trim()),
      models,
      callAI: fetchGeminiGenerate,
    });
  }

  if (env.GROQ_API_KEY) {
    const key = env.GROQ_API_KEY.split(",")[0].trim();
    const models = await getValidModelsForProvider(
      "groq", key,
      env.GROQ_MODELS || "openai/gpt-oss-20b,openai/gpt-oss-120b",
      env
    );
    configs.push({
      name: "groq",
      keys: env.GROQ_API_KEY.split(",").map((k) => k.trim()),
      models,
      callAI: fetchGroqGenerate,
    });
  }

  if (env.OPENROUTER_API_KEY) {
    const key = env.OPENROUTER_API_KEY.split(",")[0].trim();
    const models = await getValidModelsForProvider(
      "openrouter", key,
      env.OPENROUTER_MODELS || "openrouter/free,openai/gpt-oss-20b:free,openai/gpt-oss-120b:free",
      env
    );
    configs.push({
      name: "openrouter",
      keys: env.OPENROUTER_API_KEY.split(",").map((k) => k.trim()),
      models,
      callAI: fetchOpenRouterGenerate,
    });
  }

  const priority = (env.AI_PROVIDERS || "gemini,groq")
    .split(",").map((s) => s.trim());
  configs.sort((a, b) => priority.indexOf(a.name) - priority.indexOf(b.name));

  return configs;
}

export async function runAgentLoop(currentContents, env, chatId, userPrompt, providerConfigs, history, startTime, options = {}) {
  const maxTime = options.executionTimeout || EXECUTION_TIMEOUT;
  const iterTimeout = options.iterationTimeout || AGENT_ITERATION_TIMEOUT;
  const execTool = options.toolExecutor || executeTool;
  let iteration = 0;
  let finalText = null;
  const failedProviders = new Set();
  let lastError = null;
  let escalationHinted = false;
  let escalationTriggered = false;
  const toolCache = new Map();
  let selfReflectionRun = false;
  let filesModified = false;
  const isSpaces = !!env.IS_SPACES;

  // Throttle progress updates to avoid Telegram editMessageText rate limits
  let lastProgressTime = 0;
  const PROGRESS_THROTTLE_MS = 5000;
  async function sendProgress(text) {
    return; // disabled — uses cron polling instead
    const now = Date.now();
    if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
    lastProgressTime = now;
    try {
      await fetch(`${env.WORKER_URL}/api/spaces-callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer kokoa-runner-secret'
        },
        body: JSON.stringify({ chatId: String(chatId), progressText: text })
      });
    } catch (e) {
      console.error("Failed to send progress callback:", e);
    }
  }

  function truncateToolResult(result, maxChars = 15000) {
    if (result === null || result === undefined) return result;
    if (typeof result === 'string') {
      if (result.length > maxChars) {
        return result.slice(0, maxChars) + "\n\n... [Hasil dipotong karena terlalu panjang] ...";
      }
      return result;
    }
    if (typeof result === 'object') {
      const cloned = { ...result };
      let wasTruncated = false;
      if (typeof cloned.content === 'string' && cloned.content.length > maxChars) {
        cloned.content = cloned.content.slice(0, maxChars) + "\n\n... [Isi file dipotong karena terlalu panjang] ...";
        wasTruncated = true;
      }
      if (typeof cloned.stdout === 'string' && cloned.stdout.length > maxChars) {
        cloned.stdout = cloned.stdout.slice(0, maxChars) + "\n\n... [Stdout dipotong karena terlalu panjang] ...";
        wasTruncated = true;
      }
      if (typeof cloned.stderr === 'string' && cloned.stderr.length > maxChars) {
        cloned.stderr = cloned.stderr.slice(0, maxChars) + "\n\n... [Stderr dipotong karena terlalu panjang] ...";
        wasTruncated = true;
      }
      if (wasTruncated) {
        cloned.is_truncated = true;
        return cloned;
      }
      try {
        const serialized = JSON.stringify(cloned);
        if (serialized.length > maxChars * 1.5) {
          return {
            warning: "Hasil tool terlalu panjang untuk ditampilkan sepenuhnya.",
            content: serialized.slice(0, maxChars) + "\n\n... [Output JSON dipotong] ...",
            is_truncated: true
          };
        }
      } catch (_) {}
      return cloned;
    }
    return result;
  }

  // Tools that mutate state must NOT be cached (read-after-write must be fresh)
  const WRITE_TOOLS = new Set([
    'createOrUpdateFile', 'deleteFile', 'createGitHubIssue', 'createIssueComment',
    'createPullRequest', 'mergePullRequest', 'updateIssueState', 'updatePRState',
    'addLabels', 'assignUser', 'remember', 'forget', 'createTaskPlan',
    'updateTaskStatus', 'clearTaskPlan', 'setReminder', 'deleteReminder',
    'triggerDeveloperWorkflow',
  ]);

  if (!startTime) startTime = Date.now();

  while (iteration < MAX_AGENT_ITERATIONS) {
    iteration++;

    if (Date.now() - startTime > maxTime) {
      throw new Error(
        "duh, sori ya prosesnya kelamaan nih, keburu kehabisan batas waktu. coba pecah pertanyaannya biar lebih simpel aja ya!",
      );
    }

    let response = null;
    let providerUsed = null;
    lastError = null;

    for (const provider of providerConfigs) {
      if (failedProviders.has(provider.name)) continue;
      if (Date.now() - startTime > maxTime) break;

      const { name, keys, models, callAI } = provider;
      const blacklistedModels = new Set();
      const blacklistedKeysGlobal = new Set();
      const blacklistedKeysPerModel = new Set();
      let globalFailures = 0;

      const cooldownStatuses = await Promise.all(
        keys.map(async (key) => {
          const keyShort = key.slice(-6);
          const isGloballyDown = await env.CHAT_HISTORY.get(`cooldown:${keyShort}`);
          return { key, isGloballyDown: !!isGloballyDown };
        })
      );
      const kvCooldownedKeys = new Set(
        cooldownStatuses.filter(item => item.isGloballyDown).map(item => item.key)
      );

      let activeModels = models.filter((m) => !blacklistedModels.has(m));
      if (activeModels.length === 0) continue;

      outerLoop: for (const model of activeModels) {
        if (Date.now() - startTime > maxTime) break outerLoop;

        const availableKeys = [];
        for (const key of keys) {
          const isLocallyDown = blacklistedKeysPerModel.has(`${model}:${key}`);
          const isGloballyDown = blacklistedKeysGlobal.has(key) || kvCooldownedKeys.has(key);
          if (!isLocallyDown && !isGloballyDown) {
            availableKeys.push(key);
            if (availableKeys.length >= 3) break;
          }
        }

        if (availableKeys.length === 0) continue;

        const shuffledKeys = shuffleArray(availableKeys);

        let consecutiveFailures = 0;
        const MAX_FAILURES_BEFORE_SKIP = 2;

        for (const key of shuffledKeys) {
          if (Date.now() - startTime > maxTime) break outerLoop;

          const keyShort = key.slice(-6);
          try {
            const cleanContents = currentContents.map(c => {
              const { _selfReflection, ...rest } = c;
              return rest;
            });
            const fetchPromise = callAI(model, key, cleanContents, env, chatId);
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error("TIMEOUT_TRIGGER: Request Timeout")), iterTimeout)
            );

            response = await Promise.race([fetchPromise, timeoutPromise]);
            if (response) {
              providerUsed = name;
              break outerLoop;
            }
          } catch (err) {
            console.error(`[${name}] Error model ${model} [Key: ${keyShort}...]:`, err.message);
            lastError = err;
            globalFailures++;

            if (globalFailures >= 3) {
              break outerLoop;
            }

            const errMsg = err.message;

            if (errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.includes("SERVICE_UNAVAILABLE")) {
              blacklistedModels.add(model);
              break;
            }

            const isRetryable = errMsg.includes("TIMEOUT_TRIGGER") ||
              errMsg.includes("GEMINI_RETRY_TRIGGER") ||
              errMsg.includes("GROQ_RATE_LIMIT") ||
              errMsg.includes("429") ||
              errMsg.includes("RESOURCE_EXHAUSTED") ||
              errMsg.includes("GROQ_TIMEOUT");
            if (isRetryable) {
              blacklistedKeysGlobal.add(key);
              blacklistedKeysPerModel.add(`${model}:${key}`);

              let expirationTtl = 60;
              const match = errMsg.match(/"retryDelay":\s*"(\d+)s"/);
              if (match && match[1]) expirationTtl = parseInt(match[1], 10) + 5;
              await env.CHAT_HISTORY.put(`cooldown:${keyShort}`, "1", { expirationTtl });

              consecutiveFailures++;
              if (consecutiveFailures >= MAX_FAILURES_BEFORE_SKIP) break;
              continue;
            }

            const isKeyInvalid = errMsg.includes("GEMINI_KEY_INVALID") ||
              errMsg.includes("GEMINI_KEY_BLOCKED") ||
              errMsg.includes("GROQ_KEY_INVALID");
            if (isKeyInvalid) {
              blacklistedKeysGlobal.add(key);
              await env.CHAT_HISTORY.put(`cooldown:${keyShort}`, "1", { expirationTtl: 600 });
              continue;
            }

            if (errMsg.includes("GEMINI_MODEL_NOT_FOUND") || errMsg.includes("GROQ_MODEL_NOT_FOUND") || errMsg.includes("404")) {
              blacklistedModels.add(model);
              break;
            }
          }
        }
      }

      if (response) break;
      failedProviders.add(name);
    }

    if (!response) {
      if (failedProviders.size >= providerConfigs.length) {
        throw lastError || new Error("duh, semua provider AI lagi error atau kena limit nih. coba beberapa saat lagi ya");
      }
      throw lastError || new Error("Semua AI endpoint gagal merespon atau kehabisan waktu eksekusi.");
    }

    const candidate = response.candidates?.[0];
    const modelContent = candidate?.content;
    if (!modelContent) throw new Error("AI mengembalikan konten kosong.");

    currentContents.push(modelContent);
    const parts = modelContent.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (functionCalls.length > 0) {
      for (const call of functionCalls) {
        if (call.functionCall.name === 'triggerDeveloperWorkflow') {
          const { args } = call.functionCall;
          const contextId = crypto.randomUUID();
          const hist = currentContents.slice(-15);
          const memories = await getAllMemories(env, chatId);
          const taskPlan = await getTasks(env, chatId);
          await saveGHAContext(env, {
            id: contextId, chat_id: chatId,
            instruction: args.instruction || '',
            mode: args.mode || 'code',
            repo: args.target_repo || '',
            history: hist, memories,
            task_plan: taskPlan.length > 0 ? taskPlan : null,
            status: 'pending',
          });
          args.context_id = contextId;
          args.worker_url = env.WORKER_URL || '';
        }
      }

      const results = await Promise.all(functionCalls.map(call => {
        const { name, args } = call.functionCall;
        return (async () => {
          const validation = validateToolArgs(name, args || {});
          if (!validation.valid) {
            console.warn(`[Registry Validation Failed]: ${validation.error}`);
            return { error: validation.error };
          }
          console.log(`Executing Tool: ${name}`, args);
          if (isWriteTool(name)) {
            filesModified = true;
          }
          await sendProgress(`Menjalankan ${name}...`);
          const res = await runHarnessToolCall(name, args, env, chatId, toolCache, { toolExecutor: execTool });
          if (!res.ok) {
            console.error(`Tool "${name}" gagal:`, res.error);
            await sendProgress(`Gagal menjalankan ${name}: ${res.error}`);
            if (
              (res.error.includes("403") ||
               res.error.includes("401") ||
               res.error.includes("Resource not accessible")) &&
              res.error.includes("GitHub")
            ) {
              throw new Error(
                "gagal akses karena masalah izin. coba cek token github kamu ya!",
              );
            }
            return { error: res.error };
          }
          await sendProgress(`Selesai menjalankan ${name}.`);
          return res.result;
        })();
      }));

      const functionResponses = results.map((result, i) => ({
        functionResponse: {
          name: functionCalls[i].functionCall.name,
          response: { content: result },
        },
      }));

      if (!escalationTriggered && !env.IS_SPACES && isHeavyTask(iteration, functionCalls, userPrompt)) {
        const alreadyUsingGHA = functionCalls.some(tc => tc.functionCall?.name === 'triggerDeveloperWorkflow');
        if (!alreadyUsingGHA) {
          if (!escalationHinted) {
            escalationHinted = true;
            functionResponses.push({
              functionResponse: {
                name: '_system_escalation',
                response: { content: 'PETUNJUK: Tugas ini butuh akses sistem yang lebih dalam. Delegasikan ke GitHub Actions runner dengan panggil tool `triggerDeveloperWorkflow`. Isi target_repo dengan format owner/repo dan instruction dengan instruksi jelas.' }
              }
            });
          } else if (iteration >= 4) {
            escalationTriggered = true;
            const escResult = await autoEscalate(env, chatId, currentContents, iteration, functionCalls);
            await sendTelegramMessage(
              env.TELEGRAM_BOT_TOKEN,
              chatId,
              `tugas ini butuh akses sistem yang lebih dalam. aku kerjakan di GitHub Actions ya...\n\nrepo: \`${escResult.repo || 'thirapi/tg-bot'}\`\n\nnanti hasilnya aku kabarin kalo udah selesai!`
            );
          }
        }
      }

      currentContents.push({
        role: "function",
        parts: functionResponses,
      });

      if (escalationTriggered) break;
      continue;
    }

    const dynamicTextPart = parts.map(p => p.text).filter(Boolean).join("\n");

    if (dynamicTextPart) {
      // Self-reflection only on Spaces path (Worker has tight 23s timeout)
      if (isSpaces && filesModified && !selfReflectionRun) {
        selfReflectionRun = true;
        await sendProgress("Memeriksa ulang hasil pekerjaan (Self-Reflection)...");
        currentContents.push({
          role: "user",
          parts: [{ text: "Tolong periksa kembali pekerjaanmu (Self-Reflection). Apakah semua kode baru sudah bebas dari error sintaks, import yang kurang, atau bug logika? Jalankan perintah tsc/build/test jika perlu untuk memverifikasi. Jika ada yang kurang atau salah, perbaiki sekarang dengan tool. Jika sudah sempurna, berikan jawaban penutup." }],
          _selfReflection: true
        });
        continue;
      }
      finalText = dynamicTextPart;
      break;
    }

    if (functionCalls.length === 0) break;
  }

  return { finalText, escalationTriggered };
}

const HEAVY_FILE_TOOLS = new Set([
  'getFileContent','createOrUpdateFile','searchInFiles','listDirectoryContents','deleteFile'
]);

function isHeavyTask(iteration, toolCalls, userMessage) {
  const usedFileTools = toolCalls?.some(tc =>
    HEAVY_FILE_TOOLS.has(tc.functionCall?.name)
  );
  // Only escalate if BOTH: heavy file tools were used AND iterations are high
  // Removed userMessage keyword matching — too many false positives (e.g. "analisa" triggers GHA even for simple tasks)
  // Raised threshold from 3 to 5 so AI has room to complete moderate tasks independently
  return usedFileTools && iteration >= 5;
}

function extractTargetRepo(toolCalls, currentContents) {
  for (const tc of (toolCalls || [])) {
    const args = tc.functionCall?.args || {};
    if (args.owner && args.repo) return `${args.owner}/${args.repo}`;
  }
  for (const content of (currentContents || [])) {
    for (const part of (content.parts || [])) {
      if (part.text) {
        const match = part.text.match(/\b([\w-]+)\/([\w.-]+)\b/g);
        if (match) return match[0];
      }
    }
  }
  return null;
}

function buildEscalationInstruction(currentContents) {
  const userParts = currentContents
    .filter(c => c.role === 'user')
    .map(c => c.parts.map(p => p.text).filter(Boolean).join(' '))
    .filter(Boolean);
  return userParts.join('\n') || 'melakukan task development berdasarkan konteks percakapan';
}

async function autoEscalate(env, chatId, currentContents, iteration, functionCalls) {
  const contextId = crypto.randomUUID();
  const repo = extractTargetRepo(functionCalls, currentContents) || '';
  const instruction = buildEscalationInstruction(currentContents);
  const history = currentContents.slice(-10);
  const memories = await getAllMemories(env, chatId);
  const taskPlan = await getTasks(env, chatId);

  await saveGHAContext(env, {
    id: contextId,
    chat_id: chatId,
    instruction,
    mode: 'code',
    repo,
    history,
    memories,
    task_plan: taskPlan.length > 0 ? taskPlan : null,
    status: 'pending',
  });

  const dispatchBody = {
    event_type: 'kokoa-dev-task',
    client_payload: {
      target_repo: repo || 'thirapi/tg-bot',
      instruction,
      mode: 'code',
      chat_id: chatId,
      worker_url: env.WORKER_URL || '',
      context_id: contextId,
    },
  };

  const endpoint = 'repos/thirapi/tg-bot/dispatches';
  await callGitHubAPI(env, endpoint, 'POST', dispatchBody);
  return { contextId, repo, instruction };
}

export async function processMessage(message, env) {
  const chatId = String(message.chat.id);
  let isProcessing = true;
  let shouldReleaseLock = true;

  let typingTimer = null;
  const sendTyping = async () => {
    if (!isProcessing) return;
    try {
      await sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");
    } catch (_) { }
    if (isProcessing) {
      typingTimer = setTimeout(sendTyping, 4000);
    }
  };
  sendTyping();

  try {
    const maxHistory = MAX_HISTORY;
    let history = await getHistory(env, chatId, 15);

    while (history.length > 0 && history[0].role !== "user") {
      history.shift();
    }

    let mediaData = null;
    let userPrompt = message.text || message.caption || "";

    if (message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      mediaData = await prepareMediaPart(
        env.TELEGRAM_BOT_TOKEN,
        fileId,
        "image/jpeg",
      );
      if (!userPrompt) userPrompt = "Apa yang ada di foto ini?";
    } else if (message.voice) {
      mediaData = await prepareMediaPart(
        env.TELEGRAM_BOT_TOKEN,
        message.voice.file_id,
        "audio/ogg",
      );
      if (!userPrompt) userPrompt = "Tolong jelaskan/jawab pesan suara ini.";
    }

    if (!userPrompt && !mediaData) {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "aduh, sori ya ga ngerti maksudnya... coba kirim teks, foto, atau voice note aja biar aku paham!",
      );
      return;
    }

    if (env.HF_SPACES_URL) {
      try {
        const { sendTelegramMessage } = await import("../services/telegram.js");
        const sent = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Cocoa sedang bekerja... ⏳");
        const progressMsgId = sent && sent.length > 0 && sent[0].message_id ? String(sent[0].message_id) : null;
        console.log(`[MsgLock] progressMsgId=${progressMsgId} for chat ${chatId}`);
        if (progressMsgId) {
          await env.CHAT_HISTORY.put(`progress_msg:${chatId}`, progressMsgId, { expirationTtl: 600 });
        }

        const { processViaSpaces } = await import("../services/hf-spaces.js");
        const res = await processViaSpaces(env, chatId, userPrompt, mediaData, history, progressMsgId);
        console.log(`[MsgLock] Spaces returned status=${res?.status} for chat ${chatId}`);
        if (res && res.status === "processing") {
          shouldReleaseLock = false;
          console.log(`[MsgLock] shouldReleaseLock=false (Spaces processing) for chat ${chatId}`);
          const { pollSpacesResult } = await import("../services/spaces-poll.js");
          await pollSpacesResult(env, chatId, progressMsgId);
          return;
        }

        // Busy — hapus progress message, release lock, user can retry
        if (res && res.status === "busy") {
          console.log(`[MsgLock] Spaces busy, releasing lock for chat ${chatId}`);
          if (progressMsgId) {
            const { deleteTelegramMessage } = await import("../services/telegram.js");
            await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(progressMsgId)).catch(() => {});
            await env.CHAT_HISTORY.delete(`progress_msg:${chatId}`).catch(() => {});
          }
          // shouldReleaseLock stays true → lock released in finally block
          return;
        }
        // Sync atau unknown — hapus progress message
        if (progressMsgId) {
          const { deleteTelegramMessage } = await import("../services/telegram.js");
          await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(progressMsgId)).catch(() => {});
          await env.CHAT_HISTORY.delete(`progress_msg:${chatId}`).catch(() => {});
        }
        console.log(`[MsgLock] Spaces returned unknown status=${res?.status}, falling through for chat ${chatId}`);
        return;
      } catch (e) {
        console.error("Spaces unreachable, falling back to direct processing:", e.message);
        // Hapus progress message karena Spaces gagal
        const pid = await env.CHAT_HISTORY.get(`progress_msg:${chatId}`);
        if (pid) {
          const { deleteTelegramMessage } = await import("../services/telegram.js");
          await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(pid)).catch(() => {});
          await env.CHAT_HISTORY.delete(`progress_msg:${chatId}`).catch(() => {});
        }
      }
    }

    const providerConfigs = await buildProviderConfigs(env);
    if (providerConfigs.length === 0) {
      throw new Error("gak ada provider AI yang aktif. cek konfigurasi API key kamu ya!");
    }

    // Build userParts from text prompt and optional media
    const userParts = [];
    if (userPrompt) userParts.push({ text: userPrompt });
    if (mediaData) userParts.push(mediaData);

    let currentContents = [...history, { role: "user", parts: userParts }];
    const startTime = Date.now();

    const result = await runAgentLoop(
      currentContents, env, chatId, userPrompt,
      providerConfigs, history, startTime
    );

    if (result.escalationTriggered) {
      const newContent = currentContents.slice(history.length);
      if (newContent.length > 0) {
        const cleaned = newContent.map(content => ({
          role: content.role,
          parts: content.parts.map(part => {
            if (part.inline_data) {
              return { text: `[Media: ${part.inline_data.mime_type}]` };
            }
            return part;
          })
        }));
        await addHistory(env, chatId, cleaned);
        await trimHistory(env, chatId, maxHistory);
      }
    } else if (result.finalText) {
      const richHtml = markdownToRichHtml(result.finalText);
      // sendTelegramMessage already handles splitting for messages > TG_MAX_MESSAGE_LENGTH
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);

      const newContent = currentContents.slice(history.length);
      if (newContent.length > 0) {
        const cleaned = newContent.map(content => ({
          role: content.role,
          parts: content.parts.map(part => {
            if (part.inline_data) {
              return { text: `[Media: ${part.inline_data.mime_type}]` };
            }
            return part;
          })
        }));
        await addHistory(env, chatId, cleaned);
        await trimHistory(env, chatId, maxHistory);
      }
    } else {
      console.warn("AI did not provide final text output.");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update",
      );
    }
    } catch (err) {
    console.error("processMessage Error:", err);
    await logError(env, chatId, "processMessage", err);
    const userMsg = err.message.startsWith("duh,") || err.message.startsWith("server") || err.message.startsWith("gagal")
      ? err.message
      : "yah eror... coba kirim lagi ya, moga abis ini lancar! (kalo mau liat detailnya, ketik /logs)";
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      userMsg,
    );
  } finally {
    isProcessing = false;
    clearTimeout(typingTimer);
    console.log(`[MsgLock] finally block: shouldReleaseLock=${shouldReleaseLock} for chat ${chatId}`);
    if (shouldReleaseLock) {
      console.log(`[MsgLock] Releasing D1 lock for chat: ${chatId}`);
      await releaseChatLock(env, chatId);
      try {
        const pendingRaw = await env.CHAT_HISTORY.get(`pending:${chatId}`);
        if (pendingRaw) {
          await env.CHAT_HISTORY.delete(`pending:${chatId}`).catch(() => {});
          const pending = JSON.parse(pendingRaw);
          const acquired = await acquireChatLock(env, chatId);
          if (acquired) {
            const fakeMsg = {
              chat: { id: chatId },
              text: pending.text,
              caption: pending.caption,
              photo: pending.photo,
              voice: pending.voice,
            };
            await processMessage(fakeMsg, env);
          }
        }
      } catch (e) {
        console.error('Dequeue pending message failed:', e);
      }
    }
  }
}
