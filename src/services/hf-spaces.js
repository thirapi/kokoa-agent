import { getHistory, getAllMemories, getTasks, addHistory, trimHistory, addPendingSpace } from "../db/index.js";
import { resolveAgentMode } from "../agent/mode.js";
import { sendTelegramMessage } from "./telegram.js";
import { markdownToRichHtml } from "../utils/formatter.js";
import { MAX_HISTORY } from "../config.js";

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
    headers: { "Content-Type": "application/json" },
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
    return { status: "processing" };
  }

  const newContent = (result.newContents || currentContents).slice(history.length);
  if (newContent.length > 0) {
    const cleaned = newContent.map(c => ({
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
    await addHistory(env, chatId, cleaned);
    await trimHistory(env, chatId, maxHistory);
  }

  if (result.escalationTriggered) {
    // already saved above
  } else if (result.finalText) {
    const richHtml = markdownToRichHtml(result.finalText);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);
  } else {
    console.warn("Spaces did not provide final text output.");
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update",
    );
  }

  return result;
}
