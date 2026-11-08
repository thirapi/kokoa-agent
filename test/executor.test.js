import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/github.js", () => ({ callGitHubAPI: vi.fn(async () => ({})) }));

import { callGitHubAPI } from "../src/services/github.js";
import { executeTool, dispatchRepo } from "../src/tools/executor.js";
import { validateToolArgs } from "../src/agent/registry.js";

beforeEach(() => vi.clearAllMocks());

describe("GitHub Actions tools", () => {
  it("triggerDeveloperWorkflow mengirim repository_dispatch ke repo runner", async () => {
    await executeTool("triggerDeveloperWorkflow", { target_repo: "a/b", instruction: "fix", mode: "code" }, { WORKER_URL: "https://w" }, "9");
    const [, endpoint, method, body] = callGitHubAPI.mock.calls[0];
    expect(endpoint).toBe("repos/thirapi/kokoa-agent/dispatches");
    expect(method).toBe("POST");
    expect(body).toMatchObject({ event_type: "kokoa-dev-task", client_payload: { target_repo: "a/b", chat_id: "9", mode: "code", worker_url: "https://w" } });
  });

  it("checkWorkflowStatus mengecek repo runner, bukan repo target", async () => {
    callGitHubAPI.mockResolvedValueOnce({ workflow_runs: [{ status: "completed", conclusion: "failure", id: 1, html_url: "u" }] });
    const res = await executeTool("checkWorkflowStatus", { owner: "someone", repo: "target" }, {}, "9");
    expect(callGitHubAPI.mock.calls[0][1]).toBe("repos/thirapi/kokoa-agent/actions/runs?event=repository_dispatch&per_page=3");
    expect(res.workflow_status).toBe("completed (failure)");
  });

  it("checkWorkflowStatus boleh tanpa argumen", () => {
    expect(validateToolArgs("checkWorkflowStatus", {}).valid).toBe(true);
  });

  it("repo runner bisa dioverride lewat GHA_DISPATCH_REPO", () => {
    expect(dispatchRepo({})).toBe("thirapi/kokoa-agent");
    expect(dispatchRepo({ GHA_DISPATCH_REPO: "x/y" })).toBe("x/y");
  });
});
