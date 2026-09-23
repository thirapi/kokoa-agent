// Deteksi scope pesan terakhir user: repo/code task vs permintaan umum.
// Mencegah context bleed — misal habis bahas repo lalu nanya lagu,
// model tidak boleh lagi memakai tool repo/file lokal.

const REPO_SIGNALS = [
  'repo', 'github', 'gitlab', 'issue', 'pull request', 'pullrequest',
  'commit', 'branch', 'merge', 'fork', 'clone', 'push',
  'file', 'folder', 'direktori', 'path',
  'kode', 'code', 'coding', 'program', 'script', 'fungsi', 'function',
  'class', 'import', 'error', 'bug', 'crash', 'exception', 'traceback',
  'test', 'testing', 'unittest', 'pytest', 'jest',
  'build', 'lint', 'deploy', 'workflow', 'actions',
  'grep', 'diff', 'patch', 'npm', 'node', 'pip', 'docker',
  'trello', 'kanban', 'reminder', 'pengingat',
];

// Sinyal bahwa pesan ini lanjutan dari tugas/percakapan sebelumnya
// (keluhan, permintaan ulang, tindak lanjut) — bukan topik baru.
const CONTINUE_SIGNALS = [
  'masih', 'tetap', 'tetep', 'kok', 'kenapa', 'coba', 'lagi',
  'tapi', 'gagal', 'error', 'eror', 'g bisa', 'gak bisa', 'nggak bisa',
  'belum', 'ulangi', 'ulang', 'lanjut', 'terus', 'teruskan', 'gimana',
  'bagaimana', 'solusi', 'fix', 'benerin', 'perbaiki', 'tolong',
];

// Tool yang hanya relevan untuk tugas repo/code. Disembunyikan saat mode umum.
const REPO_TOOLS = new Set([
  'cloneRepo', 'readLocalFile', 'listLocalDir', 'grepLocalFiles', 'runCommand',
  'listGitHubIssues', 'getPRDiff', 'createGitHubIssue', 'getFileContent',
  'createOrUpdateFile', 'createBranch', 'createPullRequest', 'mergePullRequest',
  'addLabels', 'assignUser', 'createIssueComment', 'updateIssueState', 'updatePRState',
  'listDirectoryContents', 'deleteFile', 'searchInFiles',
  'triggerDeveloperWorkflow', 'checkWorkflowStatus',
]);

export function isRepoTool(name) {
  return REPO_TOOLS.has(name);
}

export function extractLatestUserText(contents) {
  const all = recentUserTexts(contents, 1);
  return all.length > 0 ? all[all.length - 1] : '';
}

export function recentUserTexts(contents, n = 3) {
  const out = [];
  for (const c of (contents || [])) {
    if (c.role === 'user') {
      const t = (c.parts || []).filter(p => p.text).map(p => p.text).join(' ');
      if (t) out.push(t);
    }
  }
  return out.slice(-n);
}

export function detectScope(latestText, historyTexts = []) {
  const text = (latestText || '').toLowerCase();
  if (!text.trim()) return 'continue';
  if (REPO_SIGNALS.some(k => text.includes(k))) return 'repo';
  const words = text.trim().split(/\s+/).length;
  // Pesan lanjutan/keluhan ("kok masih gak bisa", "coba lagi", "tetap error")
  // merujuk ke tugas sebelumnya — JANGAN dikira topik umum.
  // Tanpa ini, follow-up seperti "kok masih gak bisa sih" masuk mode general:
  // tool repo disembunyikan + delegasi diblokir → model cuma bisa menolak + copas tutorial.
  if (CONTINUE_SIGNALS.some(k => text.includes(k))) {
    const prevRepo = (historyTexts || []).slice(-3)
      .some(t => REPO_SIGNALS.some(k => String(t || '').toLowerCase().includes(k)));
    if (prevRepo || words <= 6) return 'continue';
  }
  // Pesan super pendek (oke, lanjut, dst) kemungkinan lanjutan topik sebelumnya
  if (words <= 3) return 'continue';
  return 'general';
}

export function buildScopeBanner(scope, hasRepoContext) {
  if (scope === 'general') {
    // MINIMAL dan positif saja. Pelajaran: daftar larangan ("jangan...", "tugas lama",
    // "yang tidak kamu lakukan") justru dipikirkan model lalu dideklarasikan
    // ("kita ga ngoding...") — makin dilarang makin disebut. Penegakan lewat
    // harness (hard-block) + filter tools, bukan lewat teks instruksi.
    return "mode umum: kerjakan permintaan terakhir user, dan sertakan hanya yang diminta. " +
      "butuh info dari internet? pakai webSearch/webFetch. selebihnya jawab langsung.";
  }
  return null;
}

export function scopedRepoLabel(repoName) {
  return `[Repo aktif: ${repoName} — hanya relevan bila pesan terakhir membahas kode/repo. abaikan untuk topik umum.]`;
}
