import { getHistory, getAllMemories, getTasks, addHistory, trimHistory, addPendingSpace } from "../db/index.js";
import { resolveAgentMode } from "../agent/mode.js";
import { sendTelegramMessage } from "./telegram.js";
import { markdownToRichHtml } from "../utils/formatter.js";
import { MAX_HISTORY } from "../config.js";
import { runnerAuthHeaders } from "../utils/auth.js";
import { cleanContentsForHistory } from "../utils/history.js";

export async function processViaSpaces(env, chatId, userPrompt, mediaData, history, progressMsgId) {
  const maxHistory = MAX_HISTORY;
  const memories = await getAllMemories(env, chatId);
  const tasks = await getTasks(env, chatId);

  const agentMode = await resolveAgentMode(env, chatId).catch(() => 'build');

  const userParts = [{ text: userPrompt }];
  if (mediaData) userParts.push(mediaData);

  const currentContents = [...history, { role: "user", parts: userParts }];

  const response = await fetch(`${env.HF_SPACES_URL}/api/process`, {
    method: "POST",
    headers: runnerAuthHeaders(env, { "Content-Type": "application/json" }),
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      chatId,
      userPrompt,
      currentContents,
      memories,
      tasks,
      mode: agentMode,
      workerUrl: env.WORKER_URL || "",
      progressMsgId: progressMsgId || null,
    }),
  });

  if (!response.ok) {
    if (response.status === 429) {
      return { status: "busy" };
    }
    const errBody = await response.text();
    throw new Error(`HF Spaces error (${response.status}): ${errBody}`);
  }

  const result = await response.json();

  if (result.status === "processing") {
    await addPendingSpace(env, chatId);
    // Reset penanda antar-sesi: callback_done/hdl milik percobaan SEBELUMNI (TTL 300s/120s)
    // tidak boleh memblokir pengiriman hasil percobaan INI.
    await env.CHAT_HISTORY.delete(`callback_done:${chatId}`).catch(() => {});
    await env.CHAT_HISTORY.delete(`hdl:${chatId}`).catch(() => {});
    return { status: "processing" };
  }

  const newContent = (result.newContents || currentContents).slice(history.length);
  if (newContent.length > 0) {
    await addHistory(env, chatId, cleanContentsForHistory(newContent));
    await trimHistory(env, chatId, maxHistory);
  }

  if (result.escalationTriggered) {
    // already saved above
  } else if (result.finalText) {
    const richHtml = markdownToRichHtml(result.finalText);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);
  } else {
    console.warn("Spaces did not provide final text output.");
    const { noFinalTextMessage } = await import("../utils/net.js");
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      noFinalTextMessage(result),
    );
  }

  return result;
}
