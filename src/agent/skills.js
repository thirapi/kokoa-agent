// Skills ala agentskills.io (Hermes / PI / OpenCode style).
// Tiap skill: nama, kapan dipakai (triggers), dan langkah kerja.
// Skill yang cocok otomatis disuntik ke system prompt; bisa dipaksa via /skill <nama>.

export const SKILLS = [
  {
    name: "review-pr",
    description: "review pull request github secara terstruktur",
    triggers: [
      "review pr", "review pull", "review code", "review kode",
      "cek pr", "cek pull", "pr review", "tolong review",
    ],
    instructions:
      "skill review-pr aktif. langkah:\n" +
      "1. ambil diff via `getPRDiff` (owner, repo, pull_number wajib — tanya kalo kurang).\n" +
      "2. analisis: bug/logic error, security issue, readability, missing tests.\n" +
      "3. output singkat terstruktur: ringkasan perubahan, temuan (kritis/saran), verdict (approve/request changes).\n" +
      "4. kalo butuh konteks file lain yg banyak, delegasikan via `triggerDeveloperWorkflow` mode analysis.\n" +
      "tetap lowercase, tanpa kata formal.",
  },
  {
    name: "trello-triage",
    description: "ubah laporan bug/fitur dari chat jadi kartu trello yg rapi",
    triggers: [
      "trello", "kanban", "kartu", "buatkan kartu", "bikinin kartu",
      "catat bug", "lapor bug", "laporan bug", "catat fitur",
    ],
    instructions:
      "skill trello-triage aktif. langkah:\n" +
      "1. gali inti laporan dari pesan user (kalo kurang jelas, tanya 1x singkat).\n" +
      "2. pecah jadi sub-tugas konkret + estimasi effort (S/M/L) & durasi.\n" +
      "3. buat kartu via `createTrelloCard` (isi name, desc berisi analisis + estimasi, subtasks untuk checklist).\n" +
      "4. kalo kredensial trello belum ada, instruksikan user simpan via `remember` (TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID).\n" +
      "tetap lowercase, tanpa kata formal.",
  },
  {
    name: "repo-tour",
    description: "jelaskan struktur & arsitektur repo secara ringkas",
    triggers: [
      "jelasin repo", "jelaskan repo", "tour repo", "struktur repo",
      "arsitektur repo", "overview repo", "repo ini tentang apa",
    ],
    instructions:
      "skill repo-tour aktif. langkah:\n" +
      "1. (spaces) `cloneRepo(owner/repo)` bila workspace belum ada, lalu `listLocalDir` + baca file kunci secukupnya (readme, package.json, entry point).\n" +
      "2. (worker) pakai `listDirectoryContents` + `getFileContent` untuk file kunci.\n" +
      "3. output: tujuan repo, struktur folder, alur utama, cara jalanin/test — singkat padat lowercase.\n" +
      "jangan baca seluruh repo; maksimal ~10 file.",
  },
];

export function getSkill(name) {
  return SKILLS.find(s => s.name === (name || '').toLowerCase().trim()) || null;
}

export function matchSkills(text, forcedName = null, maxSkills = 2) {
  const lower = (text || '').toLowerCase();
  const scored = SKILLS.map(skill => {
    let score = 0;
    for (const t of skill.triggers) {
      if (lower.includes(t)) score += t.length; // trigger lebih panjang = lebih spesifik
    }
    return { skill, score };
  })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const result = [];
  const forced = getSkill(forcedName);
  if (forced && !result.includes(forced)) result.push(forced);
  for (const { skill } of scored) {
    if (result.length >= maxSkills) break;
    if (!result.includes(skill)) result.push(skill);
  }
  return result;
}

export async function getForcedSkill(env, chatId) {
  try {
    if (!env?.CHAT_HISTORY?.get || !chatId) return null;
    return await env.CHAT_HISTORY.get(`forced_skill:${chatId}`);
  } catch (_) {
    return null;
  }
}

export async function setForcedSkill(env, chatId, name, ttlSeconds = 600) {
  try {
    if (!env?.CHAT_HISTORY?.put || !chatId) return;
    await env.CHAT_HISTORY.put(`forced_skill:${chatId}`, name, { expirationTtl: ttlSeconds });
  } catch (_) {}
}

export function buildSkillsBlock(text, forcedName = null) {
  const matched = matchSkills(text, forcedName);
  if (matched.length === 0) return '';
  return matched
    .map(s => `[skill aktif: ${s.name} — ${s.description}]\n${s.instructions}`)
    .join('\n\n');
}
