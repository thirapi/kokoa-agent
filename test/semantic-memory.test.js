import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/index.js", async () => {
  const fn = () => vi.fn(async () => {});
  return {
    setMemory: fn(), getMemory: fn(), deleteMemory: fn(), getAllMemories: vi.fn(async () => []), getRecentMemories: vi.fn(async () => []),
    addTask: fn(), getTasks: vi.fn(async () => []), updateTaskStatus: fn(), createTasks: fn(), clearTasks: fn(),
    addReminder: fn(), getReminders: vi.fn(async () => []), deleteReminder: fn(),
  };
});
vi.mock("../src/services/github.js", () => ({ callGitHubAPI: vi.fn() }));
vi.mock("../src/services/telegram.js", () => ({ sendTelegramMessage: vi.fn(), sendTelegramPhoto: vi.fn(), sendTelegramAudio: vi.fn(), getTelegramUserInfo: vi.fn() }));

import { indexMemory, searchMemories, forgetMemoryVector, memoryVectorId, relevantMemoriesBlock, EMBEDDING_MODEL } from "../src/agent/semantic-memory.js";
import { executeTool } from "../src/tools/executor.js";
import { buildDetachedEnv } from "../src/agent/detached-env.js";

function fakeBindings() {
  const store = new Map();
  return {
    store,
    AI: { run: vi.fn(async (model, { text }) => ({ data: text.map((t) => [t.length, 1]) })) },
    VECTORIZE: {
      upsert: vi.fn(async (vs) => vs.forEach((v) => store.set(v.id, v))),
      deleteByIds: vi.fn(async (ids) => ids.forEach((id) => store.delete(id))),
      query: vi.fn(async (_v, { namespace }) => ({
        matches: [...store.values()].filter((v) => v.namespace === namespace).map((v, i) => ({ id: v.id, score: i === 0 ? 0.82 : 0.3, metadata: v.metadata })),
      })),
    },
  };
}

let env;
beforeEach(() => { env = fakeBindings(); });

describe("memori semantik", () => {
  it("index: embed bge-m3, namespace per chat, id stabil per (chat,key)", async () => {
    expect(await indexMemory(env, 7, "stack", "go + htmx")).toBe(true);
    expect(env.AI.run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: ["stack: go + htmx"] });
    const [v] = env.VECTORIZE.upsert.mock.calls[0][0];
    expect(v).toMatchObject({ id: await memoryVectorId(7, "stack"), namespace: "7", metadata: { key: "stack", value: "go + htmx" } });
    await indexMemory(env, 7, "stack", "go + templ");
    expect(env.store.size).toBe(1); // upsert menimpa, bukan duplikat
  });

  it("cari: hanya namespace chat itu & skor di atas ambang", async () => {
    await indexMemory(env, 7, "stack", "go + htmx");
    await indexMemory(env, 7, "hobi", "main gitar");
    await indexMemory(env, 8, "rahasia", "chat lain");
    const res = await searchMemories(env, 7, "bahasa pemrograman favoritku apa?");
    expect(env.VECTORIZE.query.mock.calls[0][1]).toMatchObject({ namespace: "7", returnMetadata: "all" });
    expect(res).toEqual([{ key: "stack", value: "go + htmx", score: 0.82 }]);
  });

  it("forget menghapus vektor yang sama", async () => {
    await indexMemory(env, 7, "stack", "go");
    await forgetMemoryVector(env, 7, "stack");
    expect(env.store.size).toBe(0);
  });

  it("tanpa binding (Vercel/Spaces): diam-diam no-op, tidak crash", async () => {
    expect(await indexMemory({}, 1, "a", "b")).toBe(false);
    expect(await searchMemories({}, 1, "a")).toEqual([]);
    env.AI.run.mockRejectedValueOnce(new Error("neuron limit"));
    expect(await searchMemories(env, 1, "a")).toEqual([]);
  });

  it("tool remember/forget/searchMemory memakai index", async () => {
    await executeTool("remember", { key: "editor", value: "neovim" }, env, "9");
    expect(env.store.size).toBe(1);
    const found = await executeTool("searchMemory", { query: "editor apa yang aku pakai" }, env, "9");
    expect(found.matches[0]).toMatchObject({ key: "editor", value: "neovim" });
    await executeTool("forget", { key: "editor" }, env, "9");
    expect(env.store.size).toBe(0);
    expect((await executeTool("searchMemory", { query: "x" }, {}, "9")).error).toMatch(/tidak tersedia/);
  });

  it("memori relevan diteruskan ke runtime jarak jauh & dirender di prompt", () => {
    const list = [{ key: "stack", value: "go + htmx", score: 0.8 }];
    expect(buildDetachedEnv({}, { relevantMemories: list }).__RELEVANT_MEMORIES).toEqual(list);
    expect(relevantMemoriesBlock(list)).toBe("[memori yang relevan dengan pesan ini:]\n- stack: go + htmx");
    expect(relevantMemoriesBlock([])).toBe("");
  });
});
