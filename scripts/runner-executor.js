import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AgentSession } from './runner-gemini.js';
import { webSearch, webFetch } from '../src/services/search.js';

const {
  TARGET_REPO,
  INSTRUCTION,
  CHAT_ID,
  GLOBAL_WORKER_PAT,
  TELEGRAM_BOT_TOKEN,
  WORKER_URL,
  CONTEXT_ID,
  MODE,
} = process.env;

const isAnalysisMode = MODE === "analysis";

async function workerCallback(type, data) {
  if (!WORKER_URL) return;
  try {
    await fetch(`${WORKER_URL}/api/runner-callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer kokoa-runner-secret",
      },
      body: JSON.stringify({ chat_id: CHAT_ID, type, data }),
    });
  } catch (e) {
    console.error("Worker callback error:", e.message);
  }
}

process.on('unhandledRejection', async (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  await workerCallback("workflow_result", {
    status: "failed",
    repo: TARGET_REPO,
    error: `Unhandled Rejection: ${reason?.message || reason}`,
    instruction: INSTRUCTION || "",
  });
  process.exit(1);
});

process.on('uncaughtException', async (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  await workerCallback("workflow_result", {
    status: "failed",
    repo: TARGET_REPO,
    error: `Uncaught Exception: ${err.message}`,
    instruction: INSTRUCTION || "",
  });
  process.exit(1);
});

async function sendTelegramUpdate(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
  } catch (error) {
    console.error('Telegram Error:', error);
  }
}

function normalizePath(p) {
  return path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, '');
}

async function fetchContext() {
  if (!WORKER_URL || !CONTEXT_ID) return null;
  try {
    const res = await fetch(`${WORKER_URL}/api/context/${CONTEXT_ID}`, {
      headers: { Authorization: 'Bearer kokoa-runner-secret' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('Fetch context error:', e.message);
    return null;
  }
}

function stubBranchName(instruction) {
  const hash = crypto.createHash('sha256').update(instruction).digest('hex').slice(0, 7);
  const words = instruction
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 3)
    .join('-');
  return `kokoa/${words || 'task'}-${hash}`;
}

function buildAuthUrl(originUrl, pat) {
  const encoded = encodeURIComponent(pat || '');
  if (originUrl.includes('@github.com/')) {
    return originUrl.replace(/https:\/\/[^@]+@github\.com\//, `https://x-access-token:${encoded}@github.com/`);
  }
  return originUrl.replace('https://github.com/', `https://x-access-token:${encoded}@github.com/`);
}

function remoteBranchExists(authUrl, branch) {
  try {
    const output = execSync(`git ls-remote --heads ${authUrl} ${branch}`, { encoding: 'utf8', stdio: 'pipe' });
    return output.trim().length > 0;
  } catch { return false; }
}

function assertWriteAccess(authUrl, repo) {
  try {
    execSync(`git ls-remote --heads ${authUrl} HEAD`, { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    const stderr = ((e.stderr || '') + (e.stdout || '')).toString();
    if (/invalid username|authentication failed|403|permission/i.test(stderr)) {
      throw new Error(
        `Push access ditolak untuk repo ${repo}. GLOBAL_WORKER_PAT tidak valid / tidak punya akses write ke repo target. ` +
        `Clone repo publik tetap bisa jalan anonim, tapi push butuh PAT dengan scope contents:write + pull-requests:write (classic: repo + workflow) dan akses ke ${repo}. ` +
        `Cek Secrets GLOBAL_WORKER_PAT, expiry, dan akses repo-nya. Detail: ${stderr.trim().slice(0, 300)}`
      );
    }
    throw e;
  }
}

async function main() {
  const safeInstruction = String(INSTRUCTION || '');
  const contextData = await fetchContext();

  if (GLOBAL_WORKER_PAT) {
    process.env.GITHUB_TOKEN = GLOBAL_WORKER_PAT;
    process.env.GH_TOKEN = GLOBAL_WORKER_PAT;
  }

  if (isAnalysisMode) {
    await sendTelegramUpdate(`aku lagi baca repo \`${TARGET_REPO}\` nih, bentar ya...`);
  } else {
    await sendTelegramUpdate(`aku udah mulai ngerjain ya!\n\nrepo: \`${TARGET_REPO}\`\n\n${safeInstruction}`);
  }

  try {
    const workDir = path.join(process.cwd(), 'target_workspace');
    const repoUrl = `https://x-access-token:${GLOBAL_WORKER_PAT}@github.com/${TARGET_REPO}.git`;

    console.log('Cloning...');
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });

    try {
      execSync(`git clone ${repoUrl} ${workDir}`, { stdio: 'pipe' });
      process.chdir(workDir);
    } catch (error) {
      const stderr = (error.stderr || '').toString();
      if (stderr.includes('not found')) {
        console.log(`Repo ${TARGET_REPO} tidak ditemukan. Membuat repo baru...`);
        await sendTelegramUpdate(`repo \`${TARGET_REPO}\` belum ada nih. aku buatkan yang baru dulu ya...`);

        fs.mkdirSync(workDir, { recursive: true });
        process.chdir(workDir);
        execSync('git init');
        try { execSync('git checkout -b main'); } catch (e) { }

        execSync('git config user.name "ccocoa"');
        execSync('git config user.email "270871570+ccocoa@users.noreply.github.com"');

        fs.writeFileSync('README.md', `# ${TARGET_REPO}\n\nRepository automatically created by Kokoa Dev Agent.`);
        execSync('git add README.md');
        execSync('git commit -m "chore: initial commit"');

        execSync(`gh repo create ${TARGET_REPO} --public --source=. --remote=origin --push`);
        await sendTelegramUpdate(`repo \`${TARGET_REPO}\` udah berhasil dibuat! lanjut ngerjain instruksinya ya...`);
      } else {
        throw error;
      }
    }

    execSync('git config user.name "ccocoa"');
    execSync('git config user.email "270871570+ccocoa@users.noreply.github.com"');

    if (!isAnalysisMode) {
      const originCheck = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
      assertWriteAccess(buildAuthUrl(originCheck, GLOBAL_WORKER_PAT), TARGET_REPO);
    }

    function ensureDefaultGitignore() {
      const gitignorePath = '.gitignore';
      const defaults = [
        'node_modules/',
        'dist/',
        'build/',
        '.next/',
        '.astro/',
        '.nuxt/',
        'out/',
        '*.log',
        '.DS_Store',
        '.env',
        '.env.local',
        '.env.production',
        '.env.development',
        'server',
        '*.exe',
        '*.out',
        '*.test'
      ];

      let currentContent = '';
      if (fs.existsSync(gitignorePath)) {
        currentContent = fs.readFileSync(gitignorePath, 'utf8');
      }

      const lines = currentContent.split('\n').map(l => l.trim());
      const toAdd = defaults.filter(item => !lines.includes(item));

      if (toAdd.length > 0) {
        console.log('Menambahkan aturan default ke .gitignore...');
        const appendText = (currentContent && !currentContent.endsWith('\n') ? '\n' : '') +
          '\n# Default ignores added by Kokoa Executor\n' +
          toAdd.join('\n') + '\n';
        fs.appendFileSync(gitignorePath, appendText, 'utf8');
      }
    }
    ensureDefaultGitignore();

    const toolHandlers = {
      listDirectory: async ({ path: dirPath }) => {
        const safePath = normalizePath(dirPath || '.');
        const fullPath = path.join(process.cwd(), safePath);
        if (!fs.existsSync(fullPath)) return `Error: Direktori ${safePath} tidak ditemukan.`;
        const list = fs.readdirSync(fullPath, { withFileTypes: true });
        return list.map(item => `${item.isDirectory() ? '[DIR] ' : '[FILE]'} ${item.name}`).join('\n');
      },
      readFile: async ({ path: filePath }) => {
        const safePath = normalizePath(filePath);
        const fullPath = path.join(process.cwd(), safePath);
        if (!fs.existsSync(fullPath)) return `Error: File ${safePath} tidak ditemukan.`;
        return fs.readFileSync(fullPath, 'utf8');
      },
      writeFile: async ({ path: filePath, content, append }) => {
        const safePath = normalizePath(filePath);
        const fullPath = path.join(process.cwd(), safePath);
        if (append) {
          fs.appendFileSync(fullPath, content, 'utf8');
          const stats = fs.statSync(fullPath);
          return `Sukses: ${content.length} char ditambahkan ke ${safePath} (total ${stats.size} bytes).`;
        } else {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf8');
          const written = content.length;
          return `Sukses: File ${safePath} berhasil ditulis (${written} chars).`;
        }
      },
      deleteFile: async ({ path: filePath }) => {
        const safePath = normalizePath(filePath);
        const fullPath = path.join(process.cwd(), safePath);
        if (fs.existsSync(fullPath)) {
          fs.rmSync(fullPath, { force: true, recursive: true });
          return `Sukses: File ${safePath} berhasil dihapus.`;
        }
        return `Catatan: File ${safePath} memang tidak ada.`;
      },
      searchInFiles: async ({ keyword }) => {
        if (!keyword || !keyword.trim()) {
          return "Error: Keyword tidak boleh kosong.";
        }
        try {
          const output = execSync(
            `grep -rn --exclude-dir={node_modules,.next,dist,build} "${keyword}" .`,
            { encoding: 'utf8', stdio: 'pipe', timeout: 30000 }
          );
          return output || "Tidak ditemukan hasil untuk keyword tersebut.";
        } catch (error) {
          if (error.status === 1) {
            return "Tidak ditemukan hasil untuk keyword tersebut.";
          }
          return `[ERROR]\nstdout: ${error.stdout || ''}\nstderr: ${error.stderr || ''}`;
        }
      },
      patchFile: async ({ path: filePath, searchBlock, replaceBlock }) => {
        const safePath = normalizePath(filePath);
        const fullPath = path.join(process.cwd(), safePath);
        if (!fs.existsSync(fullPath)) {
          return `Error: File ${safePath} tidak ditemukan.`;
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        if (!content.includes(searchBlock)) {
          return `Error: searchBlock tidak ditemukan di file ${safePath}. Pastikan teks yang dicari cocok persis (termasuk indentasi/spasi).`;
        }
        const newContent = content.replace(searchBlock, replaceBlock);
        fs.writeFileSync(fullPath, newContent, 'utf8');
        return `Sukses: ${safePath} berhasil diubah (${searchBlock.length} chars diganti).`;
      },
      webSearch: async ({ query }) => {
        return await webSearch(query);
      },
      webFetch: async ({ url }) => {
        return await webFetch(url);
      },
      runCommand: async ({ command }) => {
        const trimmedCommand = command.trim();
        if (trimmedCommand.startsWith('cd ') && !trimmedCommand.includes('&&') && !trimmedCommand.includes(';') && !trimmedCommand.includes('|')) {
          return `[ERROR]\nPeringatan: Perintah 'cd' tidak bersifat persisten di antara pemanggilan tool. Jika kamu ingin menjalankan perintah di direktori tertentu, gabungkan perintah tersebut menggunakan operator '&&', contoh: 'cd ${trimmedCommand.substring(3).trim()} && perintah_kamu'.`;
        }

        const cleanedCommand = command.replace(/2>&1/g, '').replace(/>\s*\/dev\/null/g, '');
        if (cleanedCommand.includes('>') || cleanedCommand.includes('>>') || cleanedCommand.includes('<<')) {
          return `[ERROR]\nKamu terdeteksi mencoba menulis/memodifikasi file menggunakan redirection shell (>, >>, <<) di runCommand. Hal ini dilarang karena rentan terhadap kesalahan interpretasi tanda kutip, ekspansi variabel shell (seperti \${{ secrets.GITHUB_TOKEN }}), dan pemotongan teks. Silakan gunakan tool 'writeFile' untuk membuat atau memperbarui file secara aman.`;
        }

        try {
          const output = execSync(command, { encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
          return `[SUCCESS]\n${output}`;
        } catch (error) {
          return `[ERROR]\nstdout: ${error.stdout || ''}\nstderr: ${error.stderr || ''}`;
        }
      }
    };

    const agent = new AgentSession(safeInstruction, toolHandlers, async (statusMsg) => {
      await sendTelegramUpdate(statusMsg);
      await workerCallback("memory", { key: "workflow_progress", value: statusMsg });
    }, isAnalysisMode, contextData);

    console.log(`Memulai Agent Loop (mode: ${isAnalysisMode ? 'analysis' : 'code'})...`);
    const result = await agent.start();

    if (!result) {
      throw new Error("Agent selesai tapi tidak memberikan result final.");
    }

    if (isAnalysisMode) {
      const analysisText = result.analysis || result.prBody || "gak ada hasil analisis yang dikasih.";
      await workerCallback("analysis_result", {
        repo: TARGET_REPO,
        instruction: safeInstruction,
        analysis: analysisText,
      });
      await sendTelegramUpdate(`analisis untuk \`${TARGET_REPO}\` udah selesai!`);
      return;
    }

    console.log("Agent selesai. Mengecek perubahan git...");
    execSync('git add .');
    const status = execSync('git status --porcelain', { encoding: 'utf8' });

    if (status.trim()) {
      const { commitMessage, prTitle, prBody } = result;
      const commitMsg = commitMessage
        ? `${commitMessage}\n\nCo-authored-by: thirapi <132630759+thirapi@users.noreply.github.com>`
        : `feat: update\n\nCo-authored-by: thirapi <132630759+thirapi@users.noreply.github.com>`;

      const originUrl = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
      const authUrl = buildAuthUrl(originUrl, GLOBAL_WORKER_PAT);
      const branchName = stubBranchName(safeInstruction);

      await workerCallback("memory", {
        key: "last_workflow_repo",
        value: TARGET_REPO,
      });
      await workerCallback("memory", {
        key: "last_workflow_instruction",
        value: safeInstruction,
      });

      const alreadyExists = remoteBranchExists(authUrl, branchName);

      if (alreadyExists) {
        execSync(`git fetch origin ${branchName}`, { stdio: 'pipe' });
        execSync(`git checkout ${branchName}`, { stdio: 'pipe' });
        execSync(`git rebase main`, { stdio: 'pipe' });
        execFileSync('git', ['commit', '--allow-empty', '-m', commitMsg]);
        execSync(`git push ${authUrl} ${branchName} --force-with-lease`, { stdio: 'pipe' });
        await sendTelegramUpdate(`branch \`${branchName}\` udah aku update! PR yang ada bakal ke-update otomatis.`);
        await workerCallback("workflow_result", {
          status: "success", repo: TARGET_REPO,
          branch: branchName, instruction: safeInstruction,
        });
      } else {
        execSync(`git checkout -b ${branchName}`);
        execFileSync('git', ['commit', '-m', commitMsg]);
        execSync(`git push ${authUrl} ${branchName}`, { stdio: 'pipe' });

        const finalPrBody = prBody || `**Kokoa Dev Agent Report**\n\n**Original Instruction:**\n${safeInstruction}`;
        const prUrl = execFileSync('gh', [
          'pr', 'create',
          '--title', prTitle || branchName.replace(/^kokoa\//, ''),
          '--body', finalPrBody,
          '--head', branchName,
          '--base', 'main'
        ], { encoding: 'utf8' }).trim();

        await sendTelegramUpdate(`branch \`${branchName}\` + PR baru udah dibuat!`);
        await workerCallback("workflow_result", {
          status: "success", repo: TARGET_REPO,
          pr_url: prUrl, branch: branchName, instruction: safeInstruction,
        });
      }
    } else {
      await sendTelegramUpdate(`selesai! kayaknya ga ada kode yang perlu diubah deh.`);
      await workerCallback("workflow_result", {
        status: "no_changes",
        repo: TARGET_REPO,
        instruction: safeInstruction,
      });
    }

  } catch (error) {
    console.error('Fatal Error:', error);
    await workerCallback("workflow_result", {
      status: "failed",
      repo: TARGET_REPO,
      error: error.message,
      instruction: safeInstruction,
    });
    await sendTelegramUpdate(`waduh, ada kendala nih... coba liat log action github buat detailnya ya`);
    process.exit(1);
  }
}

main();