import { getHistory, addHistory, trimHistory, getAllMemories, getTasks } from "../db/index.js";
import { MAX_HISTORY } from "../config.js";

/**
 * Service untuk menangani web chat requests
 * Bisa di-route ke Worker (synchronous) atau Spaces (asynchronous)
 */

export async function processWebChatViaSend(env, message, mode = 'auto') {
  const chatId = 'web_user';
  const history = await getHistory(env, chatId);
  const memories = await getAllMemories(env, chatId);
  const tasks = await getTasks(env, chatId);

  const userParts = [{ text: message }];
  const currentContents = [...history, { role: "user", parts: userParts }];

  // If mode is 'auto', decide based on env
  if (mode === 'auto') {
    mode = env.HF_SPACES_URL ? 'spaces' : 'worker';
  }

  if (mode === 'spaces' && env.HF_SPACES_URL) {
    // Route to HuggingFace Spaces
    return routeToSpaces(env, chatId, message, currentContents, history, memories, tasks);
  } else {
    // Route to local processing (Worker or agent-server)
    return routeToLocalWorker(env, chatId, message, currentContents, history, memories, tasks);
  }
}

async function routeToSpaces(env, chatId, userPrompt, currentContents, history, memories, tasks) {
  try {
    const { resolveAgentMode } = await import("../agent/mode.js");
    const agentMode = await resolveAgentMode(env, chatId).catch(() => 'build');
    const response = await fetch(`${env.HF_SPACES_URL}/api/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId,
        userPrompt,
        currentContents,
        memories,
        tasks,
        mode: agentMode,
        workerUrl: env.WORKER_URL || '',
        progressMsgId: null,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return { status: 'busy', chatId };
      }
      const errBody = await response.text();
      throw new Error(`HF Spaces error (${response.status}): ${errBody}`);
    }

    const result = await response.json();

    if (result.status === 'processing') {
      // Will be polled by frontend
      return { status: 'processing', chatId };
    }

    // If synchronous result, save and return immediately
    const newContent = (result.newContents || currentContents).slice(history.length);
    if (newContent.length > 0) {
      const cleaned = cleanContent(newContent);
      await addHistory(env, chatId, cleaned);
      await trimHistory(env, chatId, MAX_HISTORY);
    }

    return {
      status: 'ready',
      chatId,
      finalText: result.finalText || null,
      error: result.error || null,
    };
  } catch (err) {
    console.error('Spaces processing error:', err);
    throw err;
  }
}

async function routeToLocalWorker(env, chatId, userPrompt, currentContents, history, memories, tasks) {
  try {
    // Use the runAgentLoop directly from message handler
    const { runAgentLoop, buildProviderConfigs } = await import("../handlers/message.js");

    const providerConfigs = buildProviderConfigs(env);
    if (providerConfigs.length === 0) {
      throw new Error('No AI providers configured');
    }

    const startTime = Date.now();
    const result = await runAgentLoop(
      currentContents,
      env,
      chatId,
      userPrompt,
      providerConfigs,
      history,
      startTime
    );

    const newContent = currentContents.slice(history.length)
      .filter(c => !c._selfReflection);

    if (newContent.length > 0) {
      const cleaned = cleanContent(newContent);
      await addHistory(env, chatId, cleaned);
      await trimHistory(env, chatId, MAX_HISTORY);
    }

    return {
      status: 'ready',
      chatId,
      finalText: result.finalText || null,
      error: null,
      escalationTriggered: result.escalationTriggered || false,
    };
  } catch (err) {
    console.error('Local worker processing error:', err);
    return {
      status: 'ready',
      chatId,
      finalText: null,
      error: err.message || 'Unknown error',
    };
  }
}

function cleanContent(newContent) {
  return newContent.map(c => ({
    role: c.role,
    parts: c.parts.map(p => {
      if (p.inline_data) return { text: `[Media: ${p.inline_data.mime_type}]` };
      const cleaned = {};
      if (p.text !== undefined) cleaned.text = p.text;
      if (Object.keys(cleaned).length > 0) return cleaned;
      if (p.functionCall) return { text: `[FunctionCall: ${p.functionCall.name}]` };
      if (p.functionResponse) return { text: `[FunctionResponse: ${p.functionResponse.name}]` };
      return { text: '' };
    }).filter(p => p.text || Object.keys(p).length > 0)
  }));
}

export async function getWebChatHistory(env) {
  const chatId = 'web_user';
  try {
    const history = await getHistory(env, chatId, 100);
    return { history };
  } catch (err) {
    console.error('Failed to get history:', err);
    return { history: [], error: err.message };
  }
}

export async function getProcessingMode(env) {
  // Determine which mode the system is using
  let mode = 'worker'; // default
  
  if (env.HF_SPACES_URL) {
    mode = 'spaces';
  } else if (env.IS_SPACES) {
    mode = 'spaces';
  }

  return { mode };
}
