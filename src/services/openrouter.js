import { buildSystemMessage, convertContentsToMessages, convertGroqResponse, selectTools } from "./groq.js";
import { detectScope, isRepoTool, extractLatestUserText } from "../agent/scope.js";
import { buildSkillsBlock, getForcedSkill } from "../agent/skills.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export async function fetchOpenRouterGenerate(model, key, contents, env, chatId) {
  const latestText = extractLatestUserText(contents);
  const scope = detectScope(latestText);
  const forcedSkill = await getForcedSkill(env, chatId).catch(() => null);
  const skillsBlock = buildSkillsBlock(latestText, forcedSkill);
  const systemMessage = await buildSystemMessage(env, chatId, scope, skillsBlock);
  const messages = convertContentsToMessages(contents);
  const userText = contents.filter(c => c.role === 'user').flatMap(c => c.parts.map(p => p.text || '')).join(' ');
  let tools = selectTools(userText, env.IS_SPACES);
  // Mode umum: sembunyikan tool repo/file agar model tidak nyasar ke repo aktif
  if (scope === 'general') {
    tools = tools.filter(tool => !isRepoTool(tool.function.name));
  }

  const payload = {
    model,
    messages: [systemMessage, ...messages],
    tools: tools.length > 0 ? tools : undefined,
    temperature: 0.7,
  };

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/thirapi/kokoa-agent",
      "X-Title": "Cocoa Agent"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`OPENROUTER_API_ERROR: ${response.status} - ${errorData}`);
  }

  const data = await response.json();
  return convertGroqResponse(data);
}
