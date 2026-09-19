import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, isAbsolute } from "path";

const SPACES_TOOL_NAMES = new Set([
  "cloneRepo", "readLocalFile", "listLocalDir", "grepLocalFiles", "runCommand",
]);

function isSpacesTool(name) {
  return SPACES_TOOL_NAMES.has(name);
}

function resolvePath(inputPath, workspace) {
  if (!inputPath) return workspace;
  if (isAbsolute(inputPath)) return inputPath;
  if (workspace && !inputPath.startsWith("/")) return join(workspace, inputPath);
  return inputPath;
}

async function executeSpacesTool(name, args, env, chatId) {
  switch (name) {
    case "cloneRepo": {
      // Repo private butuh token (set GITHUB_PAT_TOKEN di secrets HF Space).
      // Tanpa token, clone repo private gagal dengan "could not read Username".
      const gitToken = env.GITHUB_PAT_TOKEN || "";
      const repoUrl = gitToken
        ? `https://x-access-token:${gitToken}@github.com/${args.repo}.git`
        : `https://github.com/${args.repo}.git`;
      const dirName = args.repo.replace(/[^a-zA-Z0-9_-]/g, "-");
      const targetDir = `/tmp/tg-bot/repos/${dirName}`;
      try {
        execSync(
          `rm -rf "${targetDir}" && mkdir -p /tmp/tg-bot/repos && git clone ${args.ref ? "-b " + args.ref + " " : ""}"${repoUrl}" "${targetDir}"`,
          { stdio: "pipe", timeout: 60000 }
        );
      } catch (e) {
        // JANGAN bocorkan token ke chat/history: ganti dengan placeholder sebelum dilempar.
        let safe = String(e.message || e);
        if (gitToken) safe = safe.split(gitToken).join("***");
        throw new Error(safe || `gagal clone ${args.repo}`);
      }
      env.__WORKSPACE = targetDir;
      const repoParts = args.repo.split("/");
      if (repoParts.length === 2) {
        env.CURRENT_REPO = args.repo;
      }
      return { workspace: targetDir, message: `Repo ${args.repo} berhasil di-clone ke ${targetDir}` };
    }
    case "readLocalFile": {
      const filePath = resolvePath(args.path, env.__WORKSPACE);
      if (!filePath) throw new Error("Path tidak ditentukan dan tidak ada workspace aktif.");
      const content = readFileSync(filePath, "utf-8");
      return { path: filePath, size: content.length, content };
    }
    case "listLocalDir": {
      const dirPath = resolvePath(args.path, env.__WORKSPACE);
      if (!dirPath) throw new Error("Path tidak ditentukan dan tidak ada workspace aktif.");
      const entries = readdirSync(dirPath);
      const details = entries.map(e => {
        const full = join(dirPath, e);
        try {
          const s = statSync(full);
          return { name: e, type: s.isDirectory() ? "dir" : "file", size: s.size };
        } catch { return { name: e, type: "unknown" }; }
      });
      return { path: dirPath, entries: details };
    }
    case "grepLocalFiles": {
      const searchPath = resolvePath(args.path, env.__WORKSPACE);
      if (!searchPath) throw new Error("Path tidak ditentukan dan tidak ada workspace aktif.");
      let cmd = `grep -rn '${args.pattern.replace(/'/g, "'\\''")}' "${searchPath}"`;
      if (args.include) cmd += ` --include="${args.include}"`;
      try {
        const output = execSync(cmd, { stdio: "pipe", timeout: 15000, maxBuffer: 1024 * 1024 });
        const lines = output.toString().split("\n").filter(Boolean).slice(0, 100);
        return { matches: lines.length, results: lines };
      } catch (err) {
        const stderr = err.stderr?.toString() || "";
        if (err.status === 1 && !stderr) return { matches: 0, results: [] };
        throw new Error(`grep gagal: ${stderr.slice(0, 200)}`);
      }
    }
    case "runCommand": {
      const cwd = resolvePath(args.cwd, env.__WORKSPACE);
      if (!cwd) throw new Error("cwd tidak ditentukan dan tidak ada workspace aktif.");
      const timeoutSec = Math.min(args.timeout || 30, 120);
      try {
        const output = execSync(args.command, {
          cwd, stdio: "pipe",
          timeout: timeoutSec * 1000,
          maxBuffer: 5 * 1024 * 1024, shell: true,
        });
        return { exitCode: 0, stdout: output.toString().slice(0, 5000), stderr: "" };
      } catch (err) {
        return {
          exitCode: err.status || 1,
          stdout: (err.stdout?.toString() || "").slice(0, 5000),
          stderr: (err.stderr?.toString() || "").slice(0, 2000),
        };
      }
    }
    default:
      throw new Error(`Spaces tool "${name}" tidak dikenal.`);
  }
}

export { executeSpacesTool, SPACES_TOOL_NAMES, isSpacesTool };