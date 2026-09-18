import { executeTool } from "./executor.js";

// Tools that mutate state and must execute fresh
const WRITE_TOOLS = new Set([
  'createOrUpdateFile', 'deleteFile', 'createGitHubIssue', 'createIssueComment',
  'createPullRequest', 'mergePullRequest', 'updateIssueState', 'updatePRState',
  'addLabels', 'assignUser', 'remember', 'forget', 'createTaskPlan',
  'updateTaskStatus', 'clearTaskPlan', 'setReminder', 'deleteReminder',
  'triggerDeveloperWorkflow', 'runCommand', 'executeCommand'
]);

export function isWriteTool(toolName) {
  return WRITE_TOOLS.has(toolName);
}

export function safeTruncate(output, maxChars = 15000) {
  if (output === null || output === undefined) return output;
  if (typeof output === 'string') {
    return output.length > maxChars
      ? output.slice(0, maxChars) + "\n\n... [Hasil dipotong karena terlalu panjang] ..."
      : output;
  }
  if (typeof output === 'object') {
    const cloned = { ...output };
    let truncated = false;
    for (const key of ['content', 'stdout', 'stderr']) {
      if (typeof cloned[key] === 'string' && cloned[key].length > maxChars) {
        cloned[key] = cloned[key].slice(0, maxChars) + `\n\n... [${key} dipotong karena terlalu panjang] ...`;
        truncated = true;
      }
    }
    if (truncated) {
      cloned.is_truncated = true;
      return cloned;
    }
    try {
      const raw = JSON.stringify(cloned);
      if (raw.length > maxChars * 1.5) {
        return {
          warning: "Hasil output terlalu panjang.",
          content: raw.slice(0, maxChars) + "\n\n... [Output JSON dipotong] ...",
          is_truncated: true,
        };
      }
    } catch (_) {}
    return cloned;
  }
  return output;
}

export async function runHarnessToolCall(name, args, env, chatId, toolCache, options = {}) {
  const exec = options.toolExecutor || executeTool;
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const canCache = !isWriteTool(name);

  if (canCache && toolCache?.has(cacheKey)) {
    return toolCache.get(cacheKey);
  }

  try {
    const rawResult = await exec(name, args, env, chatId);
    const sanitized = safeTruncate(rawResult, options.maxOutputChars || 15000);
    if (canCache && toolCache) {
      toolCache.set(cacheKey, sanitized);
    }
    return { ok: true, result: sanitized };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
