export function compactWithEvicted(messages, maxTokens = 9000) {
  let est = Math.ceil(JSON.stringify(messages).length / 4);
  if (est <= maxTokens) return { kept: messages, evicted: [] };

  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  let result = [...nonSystem];
  const evicted = [];

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

    evicted.push(...result.splice(0, removeCount));
    est = Math.ceil(JSON.stringify([...systemMsgs, ...result]).length / 4);
  }

  return { kept: [...systemMsgs, ...result], evicted };
}

export function compactMessages(messages, maxTokens = 9000) {
  return compactWithEvicted(messages, maxTokens).kept;
}

function messageToText(m) {
  if (typeof m.content === 'string' && m.content.trim()) {
    return `${m.role}: ${m.content.slice(0, 500)}`;
  }
  if (Array.isArray(m.content)) {
    const t = m.content
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text.slice(0, 500))
      .join(' ');
    if (t) return `${m.role}: ${t}`;
  }
  if (m.tool_calls?.length > 0) {
    const names = m.tool_calls.map(tc => tc.function?.name || 'unknown').join(', ');
    return `${m.role}: [tool_call: ${names}]`;
  }
  if (m.role === 'tool') {
    const c = typeof m.content === 'string' ? m.content.slice(0, 300) : '';
    return `tool_result: ${c}`;
  }
  return `${m.role}: [non-teks]`;
}

export function evictedToText(evicted, maxChars = 6000) {
  const text = evicted.map(messageToText).join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n...[dipotong]...' : text;
}

export function buildSummaryMessage(summary) {
  return {
    role: 'system',
    content: `[Ringkasan konteks lama yang dipadatkan]: ${summary}`,
  };
}

export function buildEvictedNoteMessage(count) {
  return {
    role: 'system',
    content: `[Catatan: ${count} pesan lama dihapus dari konteks untuk hemat token. Lanjutkan berdasarkan pesan yang tersisa.]`,
  };
}
