const MAX_ROWS_PER_CHAT = 60;

export async function getHistory(env, chatId, limit = 40) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT role, parts FROM (
         SELECT id, role, parts FROM conversations
         WHERE chat_id = ?
         ORDER BY id DESC
         LIMIT ?
       )
       ORDER BY id ASC`
    ).bind(chatId, limit).all();

    return results.map(row => ({
      role: row.role,
      parts: JSON.parse(row.parts)
    }));
  } catch (e) {
    console.error("DB getHistory error:", e);
    return [];
  }
}

export async function addHistory(env, chatId, messages) {
  if (!messages || messages.length === 0) return;

  try {
    const stmt = env.DB.prepare(
      `INSERT INTO conversations (chat_id, role, parts) VALUES (?, ?, ?)`
    );
    const batch = messages.map(msg =>
      stmt.bind(chatId, msg.role, JSON.stringify(msg.parts))
    );
    await env.DB.batch(batch);
  } catch (e) {
    console.error("DB addHistory error:", e);
  }
}

export async function clearHistory(env, chatId) {
  try {
    await env.DB.prepare(
      `DELETE FROM conversations WHERE chat_id = ?`
    ).bind(chatId).run();
  } catch (e) {
    console.error("DB clearHistory error:", e);
  }
}

export async function trimHistory(env, chatId, maxPairs) {
  try {
    const maxRows = maxPairs * 6;
    // Step 1: Delete oldest rows beyond the limit
    await env.DB.prepare(
      `DELETE FROM conversations
       WHERE chat_id = ? AND id NOT IN (
         SELECT id FROM conversations
         WHERE chat_id = ?
         ORDER BY id DESC
         LIMIT ?
       )`
    ).bind(chatId, chatId, Math.min(maxRows, MAX_ROWS_PER_CHAT)).run();

    // Step 2: Ensure conversation starts with a 'user' role row.
    // If trim cut in the middle of a turn, leading model/function rows are now orphans
    // and will cause Gemini/Groq API errors. Delete them until we hit a user row.
    let keepDeleting = true;
    while (keepDeleting) {
      const { results } = await env.DB.prepare(
        `SELECT id, role FROM conversations WHERE chat_id = ? ORDER BY id ASC LIMIT 1`
      ).bind(chatId).all();
      if (results.length === 0 || results[0].role === 'user') {
        keepDeleting = false;
      } else {
        await env.DB.prepare(
          `DELETE FROM conversations WHERE id = ?`
        ).bind(results[0].id).run();
      }
    }
  } catch (e) {
    console.error("DB trimHistory error:", e);
  }
}

export async function setMemory(env, chatId, key, value) {
  try {
    await env.DB.prepare(
      `INSERT INTO memories (chat_id, key, value, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(chat_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).bind(chatId, key, String(value)).run();
  } catch (e) {
    console.error("DB setMemory error:", e);
  }
}

export async function getMemory(env, chatId, key) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT value FROM memories WHERE chat_id = ? AND key = ?`
    ).bind(chatId, key).all();
    return results.length > 0 ? results[0].value : null;
  } catch (e) {
    console.error("DB getMemory error:", e);
    return null;
  }
}

export async function getAllMemories(env, chatId) {
  if (env.__INJECTED_MEMORIES) return env.__INJECTED_MEMORIES;
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM memories WHERE chat_id = ? ORDER BY updated_at DESC`
    ).bind(chatId).all();
    return results || [];
  } catch (e) {
    console.error("DB getAllMemories error:", e);
    return [];
  }
}

export async function getRecentMemories(env, chatId, limit = 5) {
  if (env.__INJECTED_MEMORIES) return env.__INJECTED_MEMORIES.slice(0, limit);
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM memories WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?`
    ).bind(chatId, limit).all();
    return results || [];
  } catch (e) {
    console.error("DB getRecentMemories error:", e);
    return [];
  }
}

export async function deleteMemory(env, chatId, key) {
  try {
    await env.DB.prepare(
      `DELETE FROM memories WHERE chat_id = ? AND key = ?`
    ).bind(chatId, key).run();
  } catch (e) {
    console.error("DB deleteMemory error:", e);
  }
}

export async function deleteMemoriesByPrefix(env, chatId, prefix) {
  try {
    await env.DB.prepare(
      `DELETE FROM memories WHERE chat_id = ? AND key LIKE ?`
    ).bind(chatId, prefix + '%').run();
  } catch (e) {
    console.error("DB deleteMemoriesByPrefix error:", e);
  }
}

// Penyimpanan task in-session (Spaces tidak punya D1). Diisi via env.__TASKS_MEM
// oleh agent-server: { [chatId]: { seq, items: [{id,title,description,priority,status}] } }.
// Hilang saat container restart — cukup untuk task plan per percakapan.
function memTaskBucket(env, chatId) {
  if (!env.__TASKS_MEM) return null;
  const key = String(chatId);
  if (!env.__TASKS_MEM[key]) env.__TASKS_MEM[key] = { seq: 1, items: [] };
  return env.__TASKS_MEM[key];
}

export async function addTask(env, chatId, title, description, priority = "medium") {
  const mem = memTaskBucket(env, chatId);
  if (mem) {
    const id = mem.seq++;
    mem.items.push({ id, title, description: description || null, priority: priority || "medium", status: "pending" });
    return id;
  }
  try {
    const { results } = await env.DB.prepare(
      `INSERT INTO tasks (chat_id, title, description, priority)
       VALUES (?, ?, ?, ?) RETURNING id`
    ).bind(chatId, title, description || null, priority).all();
    return results?.[0]?.id ?? null;
  } catch (e) {
    console.error("DB addTask error:", e);
    return null;
  }
}

export async function getTasks(env, chatId, status) {
  if (env.__INJECTED_TASKS) return env.__INJECTED_TASKS;
  const mem = memTaskBucket(env, chatId);
  if (mem) {
    return status ? mem.items.filter(t => t.status === status) : [...mem.items];
  }
  if (!env.DB) return [];
  try {
    let query = `SELECT * FROM tasks WHERE chat_id = ?`;
    const params = [chatId];
    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }
    query += ` ORDER BY created_at DESC`;
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return results || [];
  } catch (e) {
    console.error("DB getTasks error:", e);
    return [];
  }
}

export async function updateTaskStatus(env, chatId, taskId, status) {
  const mem = memTaskBucket(env, chatId);
  if (mem) {
    const t = mem.items.find(t => String(t.id) === String(taskId));
    if (t) t.status = status;
    return;
  }
  try {
    await env.DB.prepare(
      `UPDATE tasks SET status = ?, updated_at = unixepoch() WHERE id = ? AND chat_id = ?`
    ).bind(status, taskId, chatId).run();
  } catch (e) {
    console.error("DB updateTaskStatus error:", e);
  }
}

export async function createTasks(env, chatId, tasks) {
  const mem = memTaskBucket(env, chatId);
  if (mem) {
    return (tasks || []).map(t => {
      const id = mem.seq++;
      mem.items.push({ id, title: t.title, description: t.description || null, priority: t.priority || "medium", status: "pending" });
      return id;
    });
  }
  try {
    const stmt = env.DB.prepare(
      `INSERT INTO tasks (chat_id, title, description, priority) VALUES (?, ?, ?, ?) RETURNING id`
    );
    const batch = tasks.map(t =>
      stmt.bind(chatId, t.title, t.description || null, t.priority || "medium")
    );
    const results = await env.DB.batch(batch);
    return results.map(r => r.results?.[0]?.id ?? null).filter(id => id !== null);
  } catch (e) {
    console.error("DB createTasks error:", e);
    return [];
  }
}

export async function addReminder(env, chatId, title, triggerAt, recurring = 0, intervalSeconds = 0) {
  try {
    const { results } = await env.DB.prepare(
      `INSERT INTO reminders (chat_id, title, trigger_at, recurring, interval_seconds) VALUES (?, ?, ?, ?, ?) RETURNING id`
    ).bind(chatId, title, triggerAt, recurring, intervalSeconds).all();
    return results?.[0]?.id ?? null;
  } catch (e) {
    console.error("DB addReminder error:", e);
    return null;
  }
}

export async function getDueReminders(env, now) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM reminders WHERE trigger_at <= ? AND (last_triggered IS NULL OR last_triggered < trigger_at) ORDER BY trigger_at ASC`
    ).bind(now).all();
    return results || [];
  } catch (e) {
    console.error("DB getDueReminders error:", e);
    return [];
  }
}

export async function markReminderTriggered(env, id, now, nextTriggerAt) {
  try {
    if (nextTriggerAt) {
      await env.DB.prepare(
        `UPDATE reminders SET last_triggered = ?, trigger_at = ? WHERE id = ?`
      ).bind(now, nextTriggerAt, id).run();
    } else {
      await env.DB.prepare(
        `UPDATE reminders SET last_triggered = ? WHERE id = ?`
      ).bind(now, id).run();
    }
  } catch (e) {
    console.error("DB markReminderTriggered error:", e);
  }
}

export async function getReminders(env, chatId) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, trigger_at, recurring, interval_seconds, last_triggered FROM reminders WHERE chat_id = ? ORDER BY trigger_at ASC`
    ).bind(chatId).all();
    return results || [];
  } catch (e) {
    console.error("DB getReminders error:", e);
    return [];
  }
}

export async function deleteReminder(env, chatId, id) {
  try {
    await env.DB.prepare(
      `DELETE FROM reminders WHERE id = ? AND chat_id = ?`
    ).bind(id, chatId).run();
  } catch (e) {
    console.error("DB deleteReminder error:", e);
  }
}

export async function clearTasks(env, chatId) {
  const mem = memTaskBucket(env, chatId);
  if (mem) {
    mem.items = [];
    return;
  }
  try {
    await env.DB.prepare(
      `DELETE FROM tasks WHERE chat_id = ?`
    ).bind(chatId).run();
  } catch (e) {
    console.error("DB clearTasks error:", e);
  }
}

export async function saveGHAContext(env, context) {
  try {
    await env.DB.prepare(
      `INSERT INTO gha_context (id, chat_id, instruction, mode, repo, history, memories, task_plan, previous_result, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         instruction = excluded.instruction,
         mode = excluded.mode,
         repo = excluded.repo,
         history = excluded.history,
         memories = excluded.memories,
         task_plan = excluded.task_plan,
         previous_result = excluded.previous_result,
         status = excluded.status`
    ).bind(
      context.id,
      context.chat_id,
      context.instruction || '',
      context.mode || 'code',
      context.repo || '',
      JSON.stringify(context.history || []),
      JSON.stringify(context.memories || []),
      JSON.stringify(context.task_plan || null),
      JSON.stringify(context.previous_result || null),
      context.status || 'pending'
    ).run();
    return context.id;
  } catch (e) {
    console.error("DB saveGHAContext error:", e);
    return null;
  }
}

export async function getGHAContext(env, id) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM gha_context WHERE id = ?`
    ).bind(id).all();
    if (results.length === 0) return null;
    const row = results[0];
    return {
      id: row.id,
      chat_id: row.chat_id,
      instruction: row.instruction,
      mode: row.mode,
      repo: row.repo,
      history: JSON.parse(row.history || '[]'),
      memories: JSON.parse(row.memories || '[]'),
      task_plan: JSON.parse(row.task_plan || 'null'),
      previous_result: JSON.parse(row.previous_result || 'null'),
      status: row.status,
      created_at: row.created_at,
      consumed_at: row.consumed_at,
    };
  } catch (e) {
    console.error("DB getGHAContext error:", e);
    return null;
  }
}

export async function consumeGHAContext(env, id) {
  try {
    await env.DB.prepare(
      `UPDATE gha_context SET status = 'consumed', consumed_at = unixepoch() WHERE id = ?`
    ).bind(id).run();
  } catch (e) {
    console.error("DB consumeGHAContext error:", e);
  }
}

const LOCK_TTL_SECONDS = { spaces: 300, worker: 60 };

export async function acquireChatLock(env, chatId) {
  const ttlSeconds = env.HF_SPACES_URL ? LOCK_TTL_SECONDS.spaces : LOCK_TTL_SECONDS.worker;
  const now = Math.floor(Date.now() / 1000);
  try {
    const existing = await env.DB.prepare(
      "SELECT updated_at FROM chat_locks WHERE chat_id = ? AND status = 'locked'"
    ).bind(chatId).first();
    if (existing) {
      const age = now - existing.updated_at;
      if (age < ttlSeconds) return false;
      await env.DB.prepare("DELETE FROM chat_locks WHERE chat_id = ?").bind(chatId).run();
    }
    await env.DB.prepare(
      "INSERT INTO chat_locks (chat_id, status, updated_at) VALUES (?, 'locked', ?)"
    ).bind(chatId, now).run();
    return true;
  } catch (e) {
    console.error("acquireChatLock error:", e);
    return true;
  }
}

export async function releaseChatLock(env, chatId) {
  try {
    await env.DB.prepare(
      "DELETE FROM chat_locks WHERE chat_id = ? AND status = 'locked'"
    ).bind(chatId).run();
  } catch (e) {
    console.error("releaseChatLock error:", e);
  }
}

export async function addPendingSpace(env, chatId) {
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO spaces_pending (chat_id, created_at) VALUES (?, unixepoch())"
    ).bind(chatId).run();
  } catch (e) {
    console.error("addPendingSpace error:", e);
  }
}

export async function getPendingSpaces(env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT chat_id FROM spaces_pending ORDER BY created_at ASC"
    ).all();
    return results || [];
  } catch (e) {
    console.error("getPendingSpaces error:", e);
    return [];
  }
}

export async function removePendingSpace(env, chatId) {
  try {
    await env.DB.prepare(
      "DELETE FROM spaces_pending WHERE chat_id = ?"
    ).bind(chatId).run();
  } catch (e) {
    console.error("removePendingSpace error:", e);
  }
}

export async function cleanupExpiredPending(env, maxAgeSeconds = 3600) {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    await env.DB.prepare(
      "DELETE FROM spaces_pending WHERE created_at < ?"
    ).bind(cutoff).run();
  } catch (e) {
    console.error("cleanupExpiredPending error:", e);
  }
}
