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
  for (let i = (contents || []).length - 1; i >= 0; i--) {
    if (contents[i].role === 'user') {
      return (contents[i].parts || []).filter(p => p.text).map(p => p.text).join(' ');
    }
  }
  return '';
}

export function detectScope(latestText) {
  const text = (latestText || '').toLowerCase();
  if (!text.trim()) return 'continue';
  if (REPO_SIGNALS.some(k => text.includes(k))) return 'repo';
  // Pesan super pendek (oke, lanjut, dst) kemungkinan lanjutan topik sebelumnya
  const words = text.trim().split(/\s+/).length;
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
