import { callGitHubAPI } from "../services/github.js";

export async function loadRepoAgentsInstructions(env, repo) {
  if (!repo) return null;
  try {
    const parts = repo.split('/');
    if (parts.length !== 2) return null;
    const [owner, repoName] = parts;
    const endpoint = `repos/${owner}/${repoName}/contents/AGENTS.md`;
    const res = await callGitHubAPI(env, endpoint);
    if (res && res.content && res.encoding === 'base64') {
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(res.content.replace(/\s/g, "")), (c) => c.charCodeAt(0))
      );
      return `[Petunjuk Proyek AGENTS.md dari ${repo}]:\n${decoded}`;
    }
  } catch (_) {}
  return null;
}
