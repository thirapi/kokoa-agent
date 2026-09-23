import { buildSystemMessage, convertContentsToMessages, convertGroqResponse, selectTools, fitMessagesForBudget } from "./groq.js";
import { detectScope, isRepoTool, extractLatestUserText, recentUserTexts } from "../agent/scope.js";
import { withNetworkRetry } from "../utils/net.js";
import { buildSkillsBlock, getForcedSkill } from "../agent/skills.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export async function fetchOpenRouterGenerate(model, key, contents, env, chatId) {
  const latestText = extractLatestUserText(contents);
  const scope = detectScope(latestText, recentUserTexts(contents, 4));
  const forcedSkill = await getForcedSkill(env, chatId).catch(() => null);
  const skillsBlock = buildSkillsBlock(latestText, forcedSkill);
  const systemMessage = await buildSystemMessage(env, chatId, scope, skillsBlock);
  const messages = convertContentsToMessages(contents);
  const userText = contents.filter(c => c.role === 'user').flatMap(c => c.parts.map(p => p.text || '')).join(' ');
  let tools = selectTools(userText, env.IS_SPACES, recentUserTexts(contents, 4));
  // Mode umum: sembunyikan tool repo/file agar model tidak nyasar ke repo aktif
  if (scope === 'general') {
    tools = tools.filter(tool => !isRepoTool(tool.function.name));
  }
  // Batasi payload seperti Groq agar tidak jebol limit TPM Efektif.
  const { kept } = fitMessagesForBudget(systemMessage, messages, tools);

  const payload = {
    model,
    messages: kept,
    tools: tools.length > 0 ? tools : undefined,
    temperature: 0.7,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  const response = await withNetworkRetry(() => fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`OPENROUTER_API_ERROR: ${response.status} - ${errorData}`);
  }

  const data = await response.json();
  return convertGroqResponse(data);
}
