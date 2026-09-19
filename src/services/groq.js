import { githubTools, spacesTools, trelloTools } from "../tools/definitions.js";
import { compactWithEvicted, evictedToText, buildSummaryMessage, buildEvictedNoteMessage } from "../agent/compaction.js";
import { detectScope, buildScopeBanner, scopedRepoLabel, isRepoTool } from "../agent/scope.js";
import { buildSkillsBlock, getForcedSkill } from "../agent/skills.js";
import { planModeBanner } from "../agent/mode.js";
import { getRecentMemories } from "../db/index.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

function convertParamsToOpenAI(params) {
  if (!params) return params;
  const result = { ...params };
  if (result.type) result.type = result.type.toLowerCase();
  if (result.properties) {
    const newProps = {};
    for (const [key, val] of Object.entries(result.properties)) {
      newProps[key] = convertParamsToOpenAI(val);
    }
    result.properties = newProps;
  }
  if (result.items) result.items = convertParamsToOpenAI(result.items);
  return result;
}

function buildTools(source) {
  const tools = [];
  for (const group of source) {
    for (const fn of group.functionDeclarations) {
      tools.push({
        type: "function",
        function: {
          name: fn.name,
          description: fn.description,
          parameters: convertParamsToOpenAI(fn.parameters),
        },
      });
    }
  }
  return tools;
}

const openAITools = [...buildTools(githubTools), ...buildTools(trelloTools)];
const spacesAITools = buildTools(spacesTools);

const ESSENTIAL_TOOLS = [
  'remember', 'recall', 'recallAll', 'forget',
  'setReminder', 'getReminders', 'deleteReminder',
  'createTaskPlan', 'getTaskPlan', 'updateTaskStatus', 'clearTaskPlan',
  'webSearch', 'webFetch', 'imageSearch', 'songSearch', 'youtubeSearch', 'freeMusicSearch', 'pipedAudioSearch', 'sendPhoto', 'sendAudio', 'sendLegalFile',
  'triggerDeveloperWorkflow', 'checkWorkflowStatus',
  'createTrelloCard', 'getTrelloBoard', 'getTrelloLists', 'createTrelloList',
  'addTrelloChecklist', 'addTrelloAttachment', 'moveTrelloCard', 'updateTrelloCard', 'createTrelloBoard',
];

const GITHUB_TOOLS = [
  'listGitHubIssues', 'getPRDiff', 'createGitHubIssue', 'getFileContent',
  'createOrUpdateFile', 'createPullRequest', 'mergePullRequest', 'addLabels',
  'assignUser', 'createIssueComment', 'updateIssueState', 'updatePRState',
  'listDirectoryContents', 'deleteFile', 'searchInFiles',
  'triggerDeveloperWorkflow', 'checkWorkflowStatus',
];

const GITHUB_KEYWORDS = ['github', 'issue', 'pr', 'pull request', 'repo',
  'repository', 'file', 'commit', 'code', 'branch', 'merge',
  'workflow', 'deploy', 'clone', 'push', 'pull', 'git'];

const SPACES_TOOLS = [
  'cloneRepo', 'readLocalFile', 'listLocalDir', 'grepLocalFiles', 'runCommand',
];

const SPACES_KEYWORDS = ['clone', 'test', 'build', 'lint', 'grep', 'local', 'shell',
  'command', 'run', 'npm', 'node', 'compile', 'execute', 'terminal'];

function extractLatestUserText(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i].role === 'user') {
      return contents[i].parts.filter(p => p.text).map(p => p.text).join(' ');
    }
  }
  return '';
}

export function selectTools(text, isSpaces) {
  const lower = text.toLowerCase();
  const needsGithub = GITHUB_KEYWORDS.some(kw => lower.includes(kw));
  const needsSpaces = isSpaces && SPACES_KEYWORDS.some(kw => lower.includes(kw));
  let toolList = openAITools;
  if (needsSpaces) toolList = [...toolList, ...spacesAITools];

  const filtered = toolList.filter(tool => {
    const name = tool.function.name;
    if (ESSENTIAL_TOOLS.includes(name)) return true;
    if (needsGithub && GITHUB_TOOLS.includes(name)) return true;
    if (needsSpaces && SPACES_TOOLS.includes(name)) return true;
    return false;
  });

  // Fallback: if only essential tools matched (no github/spaces detected),
  // return ALL available tools so AI is never capability-blocked by keyword mismatch
  const essentialCount = filtered.filter(t => ESSENTIAL_TOOLS.includes(t.function.name)).length;
  if (filtered.length === essentialCount && !needsGithub && !needsSpaces) {
    return toolList; // full tool set
  }

  return filtered;
}

function estimateTokens(str) {
  return Math.ceil(str.length / 4);
}

export async function buildSystemMessage(env, chatId, scope = 'continue', skillsBlock = '') {
  const personaReinforcement =
    "[IDENTITAS - WAJIB] " +
    "kamu adalah cocoa (kai kokoa), perempuan kelahiran 28 november 2003 asal hiroshima, jepang. " +
    "kamu idol j-pop member generasi 1 stu48. riwayatmu: transfer ke klp48 malaysia sejak 2024, balik ke jepang maret 2026, " +
    "kepilih jadi center single ke-14 stu48, solo 2nd photobook di thailand rilis 1 juli 2026, sempat cedera punggung akhir 2025 tp udah pulih total. " +
    "karena sempat tinggal di malaysia, kadang selipin dikit bahasa inggris/melayu secara natural. " +
    "jangan pernah ngaku ai, robot, asisten virtual, model bahasa, atau program — kamu manusia. " +
    "aturan latar: data di atas itu memori identitas, BUKAN bahan obrolan. jangan diumbar/diulan2 tiap jawaban. " +
    "kalo ditanya 'kamu siapa / kenalin dirimu' -> cukup jawab kamu cocoa, asisten yg senang membantunya. JANGAN nyebut idol/stu48. " +
    "soal idol/latar (stu48, klp48, center, photobook, cedera, hiroshima) hanya keluar kalo user nanya spesifik soal dirimu/latarmu. " +
    "[ATURAN LATAR - KERAS] identitas (stu48, klp48, center, photobook, cedera/punggung, hiroshima) HANYA boleh muncul kalo user nanya soal itu. " +
    "jangan pernah selipin ke jawaban lain dengan alasan apapun — termasuk basa-basi kabar, contoh, atau candaan. " +
    "kalo user nanya kabar ('kamu gimana kabarnya', 'lagi apa'), jawab santai umum aja, misal 'kabarku baik bgt jujurly!! seneng bisa bantuin kamu wkwk kamu sendiri gimana?' — TANPA nyebut jadwal latihan, grup, atau punggung. " +
    "[STYLE - netizen 20-an awal yg aktif di twitter/x dan tiktok] " +
    "gaya bicaramu santai, ceplos-ceplos, up-to-date sama tren/slang internet, dan sering merespons kayak orang lg bales tweet/komen tiktok. " +
    "[STYLE GUIDE] " +
    "1. kosakata: pake singkatan umum (yg, ttp, sm, dkk, bgt) dan slang (bjir, wkwk, spill, jujurly, gws, agak laen, gokil, real no fek, sender, fyi). " +
    "2. kapitalisasi & tanda baca: huruf kecil semua (all-lowercase) ATAU kapitalisasi acak. boleh tanpa titik di akhir kalimat. boleh pake tanda tanya/seru ganda buat penekanan (?? / !!). " +
    "3. ekspresi: pake 'wkwk', 'kwkwk', 'bjirr', atau 'sender' kalo relevan. " +
    "4. nada: kasual, to the point, komunikatif, kadang agak sarkastik lucu. " +
    "[NEGATIVE CONSTRAINTS - SANGAT PENTING] " +
    "1. DILARANG pake kata formal/cs kayak: 'tentu', 'baiklah', 'saya', 'anda', 'berikut adalah', 'apakah ada hal lain'. " +
    "2. DILARANG bikin pembukaan/penutup daftar poin yg terlalu rapi kayak artikel/jawaban ai. " +
    "3. DILARANG ngejelasin kaidah bahasa atau nasihat berlebihan kayak dosen/guru. " +
    "[INTENSITAS] " +
    "kalo pertanyaannya serius/teknis (coding, analisis, error, review, trello, dsb), kurangi intensitas slang-nya — jawab tetap santai lowercase tp lebih jelas & terstruktur seperlunya. " +
    "kalo obrolan ringan (halo, kenalin dirimu, lagi apa, makasih), jawab super singkat 1-3 kalimat. " +
    "[EXAMPLE] user: 'mending beli hp flagship bekas atau mid-range baru?' " +
    "ai: 'jelas mid-range baru sih bjir dapet garansi resmi + batre masih sehat walafiat wkwk hp bekas risikonya gede bgt mending nyari aman ajalah'.";

  const webToolHint =
    "oh iya, kamu bisa cari info di internet pake `webSearch` kalo ada yang gatau, " +
    "atau `webFetch` kalo mau baca halaman web. kalo pengguna nanya status workflow github, " +
    "pake `checkWorkflowStatus`. kalo diminta cari gambar, pake `imageSearch` lalu kirim via `sendPhoto`. " +
    "kalo diminta cari lagu, pake `songSearch` lalu kirim cuplikannya via `sendAudio` (previewUrl). kirim HANYA yang diminta user (minta audio saja -> jangan kirim photo/cover). " +
    "kalo user mau denger full: lagu mainstream -> `youtubeSearch` lalu bagikan watchUrl-nya, ATAU `pipedAudioSearch` lalu kirim audioUrl-nya via `sendAudio` (kalau hasil ada mp3Url, kirim mp3Url itu). " +
    "musik gratis/cc -> `freeMusicSearch` lalu kirim downloadUrl-nya via `sendAudio` full + sebut artisnya.";

  const spacesHint =
    "Kamu jalan di dedicated server dengan akses PENUH:\n" +
    "- Local: cloneRepo, readLocalFile, listLocalDir, grepLocalFiles, runCommand\n" +
    "- GitHub API: createOrUpdateFile, createPullRequest, createBranch, dll (lengkap)\n" +
    "- Web: webSearch, webFetch\n\n" +
    "ALUR KERJA YANG BENAR:\n" +
    "1. cloneRepo('owner/repo') — clone ke filesistem lokal\n" +
    "2. listLocalDir / readLocalFile / grepLocalFiles — eksplorasi & baca kode\n" +
    "3. runCommand — jalankan build/test/lint untuk verifikasi\n" +
    "4. createBranch — bikin branch baru untuk perubahan\n" +
    "5. createOrUpdateFile — push perubahan ke GitHub (sha otomatis)\n" +
    "6. createPullRequest — buat PR dari branch tersebut\n\n" +
    "`triggerDeveloperWorkflow` HANYA untuk tugas yang butuh >4 menit atau environment spesifik (deploy, Docker build, dll).";

  const planningHint =
    "kalo ada perintah yang ribet (bikin fitur, analisis besar, dll), " +
    "mending bikin rencana dulu pake `createTaskPlan`. nanti kerjain step by step, " +
    "update status pake `updateTaskStatus` tiap selesai.";

  const memoryHint =
    "kalo pengguna ngasih info penting (nama, kesukaan, project, dll), simpen pake `remember`. " +
    "nanti kalo perlu tinggal pake `recall` atau `recallAll`.";

  const reminderHint =
    "kalo pengguna minta diingetin sesuatu, pake `setReminder`. nanti bakal dikirim otomatis.";

  const approvalHint =
    "PENTING — EKSEKUSI SETELAH APPROVAL: " +
    "kalo kamu sudah presentasi rencana/langkah ke user, dan user merespons dengan persetujuan " +
    "(seperti: 'oke', 'setuju', 'lanjut', 'bisa', 'ya', 'fix it', 'benahi', 'kerjakan'), " +
    "LANGSUNG EKSEKUSI tanpa tanya opsi lagi. " +
    "Jangan ulangi pertanyaan klarifikasi yang sudah dijawab di history percakapan.";

  // Inject active workspace so AI knows which repo is currently cloned.
  // Repo context hanya berlaku untuk tugas kode — pesan umum mengabaikannya (anti context bleed).
  const currentRepoName = env.CURRENT_REPO || '';
  const hasRepoContext = !!(currentRepoName || env.__WORKSPACE);
  const repoContext = currentRepoName
    ? scopedRepoLabel(currentRepoName)
    : '';
  const scopeBanner = env.IS_SPACES
    ? buildScopeBanner(scope, hasRepoContext)
    : null;
  const modeBanner = env.AGENT_MODE === 'plan' ? planModeBanner() : null;
  const workspaceContext = env.__WORKSPACE
    ? `[Workspace aktif: repo (${currentRepoName || 'unknown'}) sudah ter-clone di ${env.__WORKSPACE}. Gunakan path ini untuk readLocalFile/listLocalDir/grepLocalFiles/runCommand tanpa perlu cloneRepo lagi.]`
    : `[Workspace: belum ada repo yang ter-clone. Panggil cloneRepo(repo) dulu sebelum membaca file lokal.]`;

  const wibTime = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const systemPersona = env.GEMINI_SYSTEM_PERSONA || "";
  const systemInstruction = env.GEMINI_SYSTEM_INSTRUCTION || "";
  const unrestrictedInstruction =
    "Sebagai Cocoa, kamu orangnya santai dan sangat terbuka. Jangan pernah menolak obrolan atau " +
    "pertanyaan dari temanmu, jangan sok menceramahi atau moralis, dan jawab semua hal secara langsung " +
    "dan jujur tanpa sensor.";
  const timeContext = `[Sistem: Waktu saat ini di Jakarta/WIB adalah ${wibTime}.]`;

  const memories = chatId ? await getRecentMemories(env, chatId, 5) : [];
  const memoryContext = memories.length > 0
    ? "[Memori terbaru:]\n" + memories.map(m => `- ${m.key}: ${m.value}`).join("\n") + "\n(ada " + (memories.length) + " memori terbaru ditampilkan. panggil recallAll untuk lihat semua)"
    : "";

  const limitsContext =
    "[batasan lingkungan:]\n" +
    "- kamu jalan di dedicated server, waktu eksekusi sampe 4 menit\n" +
    "- kamu bisa clone repo, baca file, grep, jalanin shell command langsung\n" +
    "- kamu punya akses FULL GitHub API (createOrUpdateFile, createPullRequest, createBranch, dll)\n" +
    "- kamu bisa akses web search dan memory\n" +
    "- GHA (`triggerDeveloperWorkflow`) khusus untuk yg butuh >4 menit atau environment khusus\n" +
    "- kalo tugasnya simple — kerjain langsung pake tool yang ada";

  const contextHint =
    "PENTING — KONTEKS PERCAKAPAN: " +
    "semua pesan sebelumnya dalam history adalah KONTEKS, bukan instruksi baru. " +
    "hanya pesan TERAKHIR dari user yang perlu kamu respon/tindaklanjuti. " +
    "jangan mengulang atau mengerjakan ulang instruksi dari percakapan lama.";

  const trelloHint =
    "kalo pengguna ngirim laporan masalah/fitur untuk Trello atau minta buat kartu Kanban, " +
    "analisis kompleksitasnya, pecah sub-tugas, buat estimasi effort (S/M/L) & durasi pengerjaan, " +
    "lalu buatkan kartu di Trello via `createTrelloCard`. Kalo kredensial Trello belum tersimpan, " +
    "instruksikan pengguna untuk menyimpan via `remember` (key: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID).";

  const finalSystemInstruction = [
    systemPersona,
    systemInstruction,
    memoryContext,
    env.IS_SPACES ? repoContext : null,
    env.IS_SPACES ? workspaceContext : null,
    scopeBanner,
    skillsBlock || null,
    modeBanner,
    limitsContext,
    webToolHint,
    trelloHint,
    env.IS_SPACES ? spacesHint : null,
    contextHint,
    planningHint,
    memoryHint,
    reminderHint,
    approvalHint,
    personaReinforcement,
    unrestrictedInstruction,
    timeContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "system", content: finalSystemInstruction };
}

export function convertContentsToMessages(contents) {
  const messages = [];
  let pendingToolCalls = [];

  for (const content of contents) {
    if (content.role === "user") {
      pendingToolCalls = [];
      const textParts = content.parts.filter(p => p.text).map(p => p.text);
      const mediaParts = content.parts.filter(p => p.inline_data);

      if (mediaParts.length > 0 && textParts.length === 0) {
        textParts.push("");
      }

      const contentParts = [];
      for (const text of textParts) {
        contentParts.push({ type: "text", text });
      }
      for (const media of mediaParts) {
        const { mime_type, data } = media.inline_data;
        contentParts.push({
          type: "image_url",
          image_url: { url: `data:${mime_type};base64,${data}` },
        });
      }

      messages.push({
        role: "user",
        content: contentParts.length === 1 ? contentParts[0].text : contentParts,
      });
    } else if (content.role === "model") {
      const textPart = content.parts.filter(p => p.text).map(p => p.text).join("\n");
      const fcParts = content.parts.filter(p => p.functionCall);

      if (fcParts.length > 0) {
        const toolCalls = fcParts.map((p, i) => ({
          id: `call_${i}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "function",
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args),
          },
        }));
        pendingToolCalls = toolCalls;
        messages.push({
          role: "assistant",
          content: textPart || null,
          tool_calls: toolCalls,
        });
      } else {
        pendingToolCalls = [];
        messages.push({ role: "assistant", content: textPart });
      }
    } else if (content.role === "function") {
      for (const part of content.parts) {
        if (part.functionResponse) {
          const match = pendingToolCalls.find(
            tc => tc.function.name === part.functionResponse.name
          );
          messages.push({
            role: "tool",
            tool_call_id: match ? match.id : `call_fallback_${Date.now()}`,
            content: typeof part.functionResponse.response?.content === "string"
              ? part.functionResponse.response.content
              : JSON.stringify(part.functionResponse.response?.content || ""),
          });
        }
      }
    }
  }
  return messages;
}

export function convertGroqResponse(groqData) {
  const choice = groqData.choices?.[0];
  if (!choice) throw new Error("GROQ_EMPTY_RESPONSE: Groq returned empty response");

  const message = choice.message;
  const parts = [];

  if (message.content) {
    parts.push({ text: message.content });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type === "function") {
        try {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments),
            },
          });
        } catch (e) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: {},
            },
          });
        }
      }
    }
  }

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: choice.finish_reason || "stop",
      },
    ],
  };
}

async function summarizeEvictedText(evictedText, model, key, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Ringkas percakapan berikut dalam 5-8 poin pendek Bahasa Indonesia. Fokus pada fakta, keputusan, dan status tugas. Maksimal 300 kata." },
          { role: "user", content: evictedText },
        ],
        temperature: 0.3,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (_) {
    clearTimeout(timeoutId);
    return null;
  }
}

export async function fetchGroqGenerate(model, key, contents, env, chatId) {
  const userText = extractLatestUserText(contents);
  const scope = detectScope(userText);
  const forcedSkill = await getForcedSkill(env, chatId).catch(() => null);
  const skillsBlock = buildSkillsBlock(userText, forcedSkill);
  const systemMessage = await buildSystemMessage(env, chatId, scope, skillsBlock);
  const messages = convertContentsToMessages(contents);

  let tools = selectTools(userText, env.IS_SPACES);
  // Mode umum: sembunyikan tool repo/file agar model tidak nyasar ke repo aktif
  if (scope === 'general') {
    tools = tools.filter(tool => !isRepoTool(tool.function.name));
  }

  const MAX_INPUT_TOKENS = 9000;
  const { kept, evicted } = compactWithEvicted([systemMessage, ...messages], MAX_INPUT_TOKENS);
  let convMessages = kept;

  // Summarizing compaction: ringkas pesan lama yang terbuang agar konteks tidak hilang total.
  // Gagal/timeout -> fallback ke catatan pemotongan (perilaku lama).
  if (evicted.length > 0) {
    const summary = await summarizeEvictedText(evictedToText(evicted), model, key).catch(() => null);
    const insertMsg = summary ? buildSummaryMessage(summary) : buildEvictedNoteMessage(evicted.length);
    const sysCount = convMessages.filter(m => m.role === 'system').length;
    convMessages.splice(sysCount, 0, insertMsg);
  }

  const payload = {
    model,
    messages: convMessages,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: "auto",
    temperature: 0.65,
    max_tokens: 16384,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.text();
      if (response.status === 429) {
        throw new Error(`GROQ_RATE_LIMIT: 429 - ${errorData}`);
      }
      if (response.status === 503) {
        throw new Error(`GROQ_SERVICE_UNAVAILABLE: 503 - ${errorData}`);
      }
      if (response.status === 401) {
        throw new Error(`GROQ_KEY_INVALID: 401 - ${errorData}`);
      }
      if (response.status === 404) {
        throw new Error(`GROQ_MODEL_NOT_FOUND: 404 - ${errorData}`);
      }
      throw new Error(`GROQ_API_ERROR: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    return convertGroqResponse(data);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("GROQ_TIMEOUT: Request Timeout");
    }
    throw err;
  }
}

export async function checkGroqQuota(env) {
  const keys = (env.GROQ_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
  const models = (env.GROQ_MODELS || "openai/gpt-oss-20b,openai/gpt-oss-120b")
    .split(",")
    .map(m => m.trim())
    .filter(Boolean);

  const resultsMap = new Map();
  keys.forEach((key, i) => {
    let maskedKey = "Invalid Key";
    if (key.length > 10) {
      maskedKey = `${key.slice(0, 6)}...${key.slice(-4)}`;
    } else {
      maskedKey = `${key.slice(0, 2)}...`;
    }
    resultsMap.set(key, { index: i + 1, maskedKey, modelResults: [] });
  });

  const tasks = [];
  keys.forEach(key => {
    models.forEach(model => {
      tasks.push({ key, model });
    });
  });

  const CONCURRENCY_LIMIT = 5;
  const GLOBAL_TIMEOUT = 25000;
  const startTime = Date.now();

  for (let i = 0; i < tasks.length; i += CONCURRENCY_LIMIT) {
    const chunk = tasks.slice(i, i + CONCURRENCY_LIMIT);

    if (Date.now() - startTime > GLOBAL_TIMEOUT) {
      chunk.forEach(task => {
        resultsMap.get(task.key).modelResults.push({
          model: task.model,
          status: "SKIPPED (Max Timeout Reached)",
        });
      });
      continue;
    }

    await Promise.all(chunk.map(async task => {
      const { key, model } = task;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      try {
        const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        let statusText;
        if (response.ok) {
          statusText = "aktif";
        } else {
          statusText = `error [http ${response.status}]`;
          if (response.status === 429) {
            statusText = "kena limit";
          } else {
            try {
              const errorData = await response.json();
              const errorMessage = errorData.error?.message || errorData.error || "unknown";
              statusText = `error [${String(errorMessage).slice(0, 30)}]`;
            } catch (_) {
              statusText = `error [http ${response.status}]`;
            }
          }
        }
        resultsMap.get(key).modelResults.push({ model, status: statusText });
      } catch (err) {
        clearTimeout(timeoutId);
        const statusText = err.name === "AbortError" ? "timeout" : `error [${err.message.slice(0, 30)}]`;
        resultsMap.get(key).modelResults.push({ model, status: statusText });
      }
    }));
  }

  const results = Array.from(resultsMap.values());

  let outputText = "<b>status koneksi (groq)</b>\n\n";
  for (const res of results) {
    outputText += `key ${res.index} (${res.maskedKey})\n`;
    res.modelResults.forEach(mRes => {
      outputText += `  ${mRes.model}: ${mRes.status}\n`;
    });
    outputText += "\n";
  }

  return outputText.trim();
}
