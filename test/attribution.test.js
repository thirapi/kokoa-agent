import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/github.js", () => ({ callGitHubAPI: vi.fn(async () => ({})) }));
vi.mock("../src/db/index.js", () => ({
  getDueReminders: vi.fn(async () => []), markReminderTriggered: vi.fn(),
  getPendingSpaces: vi.fn(async () => []), cleanupExpiredPending: vi.fn(),
  setMemory: vi.fn(), getMemory: vi.fn(), deleteMemory: vi.fn(), getAllMemories: vi.fn(async () => []),
  addTask: vi.fn(), getTasks: vi.fn(async () => []), updateTaskStatus: vi.fn(), createTasks: vi.fn(), clearTasks: vi.fn(),
  addReminder: vi.fn(), getReminders: vi.fn(async () => []), deleteReminder: vi.fn(),
}));
vi.mock("../src/services/telegram.js", () => ({ sendTelegramMessage: vi.fn(), sendTelegramPhoto: vi.fn(), sendTelegramAudio: vi.fn(), getTelegramUserInfo: vi.fn() }));

import { callGitHubAPI } from "../src/services/github.js";
import { executeTool } from "../src/tools/executor.js";
import { withCoAuthor, withPrFooter, coAuthorTrailer } from "../src/utils/attribution.js";
import { acceptOwnerInvitations, handleCron } from "../src/handlers/cron.js";

beforeEach(() => vi.clearAllMocks());
const TRAILER = "Co-Authored-By: Cocoa <270871570+ccocoa@users.noreply.github.com>";
const OWNER = { name: "thirapi", email: "132630759+thirapi@users.noreply.github.com" };

describe("atribusi ala Claude: kamu author, Cocoa co-author", () => {
  it("trailer ditambahkan sekali (idempoten)", () => {
    expect(withCoAuthor("feat: x")).toBe(`feat: x\n\n${TRAILER}`);
    expect(withCoAuthor(withCoAuthor("feat: x"))).toBe(`feat: x\n\n${TRAILER}`);
    expect(withCoAuthor("")).toBe(`chore: update\n\n${TRAILER}`);
    expect(coAuthorTrailer({ BOT_GIT_NAME: "Kai", BOT_GIT_EMAIL: "k@x" })).toBe("Co-Authored-By: Kai <k@x>");
  });

  it("createOrUpdateFile: author = pemilik, pesan commit berisi co-author", async () => {
    callGitHubAPI.mockResolvedValueOnce({}).mockResolvedValueOnce({ content: {} });
    await executeTool("createOrUpdateFile", { owner: "thirapi", repo: "htmx", path: "a.go", content: "x", message: "fix: race" }, {}, "1");
    const [, , method, body] = callGitHubAPI.mock.calls.at(-1);
    expect(method).toBe("PUT");
    expect(body.author).toEqual(OWNER);
    expect(body.message).toBe(`fix: race\n\n${TRAILER}`);
  });

  it("deleteFile & mergePullRequest juga membawa co-author", async () => {
    await executeTool("deleteFile", { owner: "o", repo: "r", path: "x", sha: "s", message: "chore: rm" }, {}, "1");
    expect(callGitHubAPI.mock.calls.at(-1)[3]).toMatchObject({ author: OWNER, message: `chore: rm\n\n${TRAILER}` });
    await executeTool("mergePullRequest", { owner: "o", repo: "r", pull_number: 4 }, {}, "1");
    expect(callGitHubAPI.mock.calls.at(-1)[3].commit_message).toBe(TRAILER);
  });

  it("PR dari bot diberi footer", async () => {
    await executeTool("createPullRequest", { owner: "o", repo: "r", title: "t", head: "h", base: "main", body: "isi" }, {}, "1");
    expect(callGitHubAPI.mock.calls.at(-1)[3].body).toBe("isi\n\n---\n🤖 Dibuat bersama Cocoa");
    expect(withPrFooter(withPrFooter("a"))).toBe("a\n\n---\n🤖 Dibuat bersama Cocoa");
  });
});

describe("undangan collaborator", () => {
  const env = { GITHUB_PAT_TOKEN: "t" };

  it("hanya undangan dari pemilik yang diterima", async () => {
    callGitHubAPI.mockResolvedValueOnce([
      { id: 1, inviter: { login: "thirapi" }, repository: { full_name: "thirapi/htmx" } },
      { id: 2, inviter: { login: "orang-asing" }, repository: { full_name: "evil/repo" } },
    ]);
    expect(await acceptOwnerInvitations(env)).toEqual(["thirapi/htmx"]);
    expect(callGitHubAPI).toHaveBeenCalledWith(env, "user/repository_invitations/1", "PATCH");
    expect(callGitHubAPI).not.toHaveBeenCalledWith(env, "user/repository_invitations/2", "PATCH");
  });

  it("cron hanya mengecek tiap 15 menit", async () => {
    callGitHubAPI.mockResolvedValue([]);
    await handleCron({ scheduledTime: Date.UTC(2026, 10, 9, 1, 7) }, env, {});
    expect(callGitHubAPI).not.toHaveBeenCalled();
    await handleCron({ scheduledTime: Date.UTC(2026, 10, 9, 1, 15) }, env, {});
    expect(callGitHubAPI).toHaveBeenCalledWith(env, "user/repository_invitations");
  });
});
