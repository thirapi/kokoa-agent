export function compactMessages(messages, maxTokens = 9000) {
  let est = Math.ceil(JSON.stringify(messages).length / 4);
  if (est <= maxTokens) return messages;

  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');
  
  let result = [...nonSystem];

  while (est > maxTokens && result.length > 2) {
    let removeCount = 1;
    const candidate = result[0];

    if (candidate?.role === 'assistant' && candidate.tool_calls?.length > 0) {
      let j = 1;
      while (j < result.length && result[j].role === 'tool') {
        j++;
        removeCount++;
      }
    } else if (candidate?.role === 'user' && result[1]?.role === 'assistant' && result[1]?.tool_calls?.length > 0) {
      removeCount = 2;
      let j = 2;
      while (j < result.length && result[j].role === 'tool') {
        j++;
        removeCount++;
      }
    }

    result.splice(0, removeCount);
    est = Math.ceil(JSON.stringify([...systemMsgs, ...result]).length / 4);
  }

  return [...systemMsgs, ...result];
}
