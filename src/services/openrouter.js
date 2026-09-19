import { buildSystemMessage, convertContentsToMessages, convertGroqResponse, selectTools } from "./groq.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export async function fetchOpenRouterGenerate(model, key, contents, env, chatId) {
  const systemMessage = await buildSystemMessage(env, chatId);
  const messages = convertContentsToMessages(contents);
  const userText = contents.filter(c => c.role === 'user').flatMap(c => c.parts.map(p => p.text || '')).join(' ');
  const tools = selectTools(userText, env.IS_SPACES);

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
      "HTTP-Referer": "https://github.com/thirapi/tg-bot",
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
