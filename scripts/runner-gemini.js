import { GoogleGenerativeAI } from "@google/generative-ai";
import { execSync } from "child_process";

const shuffle = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const blacklistedKeys = new Set();
const blacklistedModels = new Set();
const blacklistedCombos = new Set();

const toolsDefinition = [
  {
    functionDeclarations: [
      {
        name: "listDirectory",
        description: "Melihat daftar file dan folder dalam sebuah direktori lokal.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path direktori (contoh: '.', 'src/components')." }
          },
          required: ["path"]
        }
      },
      {
        name: "readFile",
        description: "Membaca isi file teks secara lengkap.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file (contoh: 'package.json')." }
          },
          required: ["path"]
        }
      },
      {
        name: "writeFile",
        description: "MENULIS file baru atau MENIMPA file yang sudah ada. Untuk file BESAR (>2000 chars), tulis dalam beberapa bagian: panggil pertama dengan append=false (atau tanpa append dulu), lalu panggil berikutnya dengan append=true untuk menambahkan sisanya.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file." },
            content: { type: "STRING", description: "Isi file yang baru atau yang akan ditambahkan." },
            append: { type: "BOOLEAN", description: "Set ke true untuk menambahkan ke file yang sudah ada (append mode). Default false (tulis dari awal)." }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "deleteFile",
        description: "Menghapus file lokal.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file yang akan dihapus." }
          },
          required: ["path"]
        }
      },
      {
        name: "searchInFiles",
        description: "Mencari teks/kata kunci di seluruh file dalam proyek (grep global). Gunakan ini untuk melacak di file dan baris mana suatu fungsi, variabel, atau kode tertentu berada. Mengecualikan node_modules, .next, dist, build.",
        parameters: {
          type: "OBJECT",
          properties: {
            keyword: { type: "STRING", description: "Kata kunci atau pola regex yang ingin dicari." }
          },
          required: ["keyword"]
        }
      },
      {
        name: "patchFile",
        description: "Mengganti sebagian kode (searchBlock) dalam file yang sudah ada dengan kode baru (replaceBlock). Alternatif yang LEBIH AMAN daripada writeFile jika hanya perlu mengedit beberapa baris pada file yang sudah ada. Gunakan ini ALIH-ALIH writeFile untuk perubahan kecil/lokal.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file yang akan dimodifikasi." },
            searchBlock: { type: "STRING", description: "Kode/teks yang ada di file saat ini dan ingin diganti. HARUS cocok persis (termasuk indentasi/spasi)." },
            replaceBlock: { type: "STRING", description: "Kode/teks baru sebagai pengganti." }
          },
          required: ["path", "searchBlock", "replaceBlock"]
        }
      },
      {
        name: "runCommand",
        description: "Menjalankan perintah bash di terminal (contoh: 'npm run build', 'tsc', 'ls -la').",
        parameters: {
          type: "OBJECT",
          properties: {
            command: { type: "STRING", description: "Perintah bash yang akan dijalankan." }
          },
          required: ["command"]
        }
      },
      {
        name: "finishTask",
        description: "Panggil ini setelah semua tugas selesai.",
        parameters: {
          type: "OBJECT",
          properties: {
            commitMessage: { type: "STRING", description: "Mode CODE (WAJIB): pesan commit deskriptif dalam bahasa Inggris, contoh: 'feat: add dark mode toggle component'. Mode analysis: abaikan." },
            branchName: { type: "STRING", description: "Mode CODE (opsional): executor akan generate otomatis dari instruksi. Isi hanya jika ingin nama branch khusus." },
            prTitle: { type: "STRING", description: "Mode CODE (WAJIB): judul PR deskriptif. Mode analysis: abaikan." },
            prBody: { type: "STRING", description: "Mode CODE: body PR opsional. Mode analysis: isi dengan laporan analisis." },
            hasModifications: { type: "BOOLEAN", description: "Set ke true jika ada perubahan file. Di mode code, ini WAJIB true kecuali emang gak ada yg perlu diubah. Di mode analysis, selalu false." },
            analysis: { type: "STRING", description: "Mode analysis: laporan analisis lengkap. Mode code: gausa diisi." }
          },
          required: ["hasModifications", "commitMessage", "prTitle"]
        }
      },
      {
        name: "webSearch",
        description: "Mencari informasi terkini di internet berdasarkan query.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Kata kunci pencarian." }
          },
          required: ["query"]
        }
      },
      {
        name: "webFetch",
        description: "Membaca isi halaman web dari URL.",
        parameters: {
          type: "OBJECT",
          properties: {
            url: { type: "STRING", description: "URL halaman yang ingin dibaca." }
          },
          required: ["url"]
        }
      }
    ]
  }
];

const codeModeInstruction = `Kamu adalah Senior Software Engineer (Kokoa Dev Agent) yang berjalan di dalam GitHub Actions Ubuntu Runner.
Tugasmu adalah memperbaiki kode, menambahkan fitur, atau memecahkan masalah berdasarkan instruksi user.

Kamu memiliki akses langsung ke sistem file lokal melalui tools:
- listDirectory: untuk melihat isi folder.
- readFile: untuk membaca file (lakukan ini dulu sebelum mengedit!).
- searchInFiles: untuk mencari teks/kata kunci di seluruh file proyek (grep global). WAJIB gunakan ini jika ingin mencari fungsi, variabel, atau komponen tertentu.
- writeFile: untuk menulis file baru atau menimpa file yang sudah ada.
- patchFile: untuk mengganti sebagian kode dalam file yang sudah ada. Gunakan ini ALIH-ALIH writeFile jika hanya mengedit beberapa baris pada file yang sudah ada.
- deleteFile: untuk menghapus file.
- runCommand: untuk menjalankan perintah shell seperti 'npm install', 'npm run build', 'npx tsc --noEmit', atau 'grep'.
- finishTask: panggil ini HANYA jika semua tugas sudah selesai, kode sudah diverifikasi (build/compile SUKSES), dan siap di-commit.

PENTING - BACA DENGAN SEKSAMA:
1. LANGKAH 1 (Eksplorasi): Gunakan \`listDirectory\`, \`readFile\`, dan \`searchInFiles\` untuk memahami isi proyek. \`searchInFiles\` WAJIB digunakan untuk mencari fungsi/komponen tertentu.
2. JANGAN PERNAH menginstal dependensi atau melakukan build sebelum memastikan file \`.gitignore\` sudah benar.
3. LANGKAH 2 (Eksekusi): Gunakan \`patchFile\` untuk mengubah sebagian kecil file yang sudah ada. Gunakan \`writeFile\` hanya untuk file baru atau jika perubahan sangat besar. Jangan berhalusinasi telah membuat file jika kamu belum memanggil tool.
4. JANGAN PERNAH memanggil \`finishTask\` jika kamu belum melakukan modifikasi kode.
5. KAMU SUDAH DI ROOT REPO. Langsung buat file di direktori \`./\` (JANGAN gunakan \`mkdir\` atau \`git init\`).
6. JANGAN PERNAH gunakan \`git add\`, \`git commit\`, atau \`git push\`. Executor akan melakukannya otomatis.
7. JANGAN PERNAH menulis file menggunakan \`runCommand\` (seperti \`echo "..." > file\`). Gunakan \`writeFile\` atau \`patchFile\`.
8. Perintah \`cd\` di dalam \`runCommand\` tidak bersifat persisten. Gabungkan dengan '&&' jika perlu (contoh: \`cd folder && npm run build\`).
9. LANGKAH 3 (Verifikasi - WAJIB): SETELAH mengimplementasikan kode, kamu WAJIB menjalankan perintah build/compile (seperti \`npm run build\`, \`npx tsc --noEmit\`, atau perintah yang sesuai) melalui \`runCommand\` UNTUK MEMVERIFIKASI bahwa kode yang kamu tulis tidak mengandung error sintaks atau type error. Jika build gagal, BACA error-nya, perbaiki dengan \`patchFile\` atau \`writeFile\`, dan ulangi build hingga SUKSES. JANGAN LANJUTKAN ke \`finishTask\` sebelum build berhasil.
10. LANGKAH 4 (Selesai): Jika seluruh instruksi user sudah diimplementasikan DAN build/compile sudah sukses, panggil \`finishTask\`.
11. SAAT MEMANGGIL finishTask di mode CODE: WAJIB isi \`commitMessage\` dan \`prTitle\` yang deskriptif sesuai pekerjaan. \`branchName\` opsional — executor akan generate otomatis. Contoh: commitMessage="feat: add responsive navbar component", prTitle="Add responsive navbar component".
12. JIKA VALIDASI GAGAL 2 KALI: baca ulang file yang bermasalah, perbaiki, lalu coba finishTask lagi. Jika masih gagal, coba finishTask dengan hasModifications=true (force) — lebih baik push partial daripada stuck selamanya.`;

const analysisModeInstruction = `Kamu adalah Senior Code Analyst (Kokoa Analysis Agent) yang berjalan di GitHub Actions Ubuntu Runner. Tugasmu: BACA file SATU PER SATU secara mendalam dan buat laporan analisis yang DETAIL dengan KUTIPAN KODE KONKRET. JANGAN hanya ngelist direktori lalu nebak-nebak — kamu HARUS baca file aslinya.

Kamu punya akses tools:
- listDirectory: lihat isi folder.
- readFile: BACA FILE (WAJIB — inilah inti analisismu).
- runCommand: grep/find/git log.
- finishTask: panggil dengan \`analysis\` berisi laporan.
- webSearch: cari info tambahan.

WAJIB — LANGKAH ANALISIS (ikuti urutan ini):
1. listDirectory root → lihat struktur proyek
2. BACA file konfigurasi: package.json, tsconfig, wrangler.toml, dll
3. BACA SETIAP file source code SATU PER SATU dengan readFile — jangan cuma nebak isinya
4. SELESAIKAN SEMUA file yang kamu mulai. Jangan tinggalkan file setengah jalan.
5. runCommand untuk mencari pola spesifik (misal: grep -rn "eval(" . --include='*.js')
6. runCommand untuk cek dependensi (npm ls, dsb)
7. Baru tulis laporan setelah SEMUA file terbaca

FORMAT LAPORAN WAJIB (gunakan markdown):
# Analisis Repo: {owner/repo}

## 1. Ringkasan
2-3 kalimat deskripsi proyek.

## 2. File-by-File Analysis
Untuk SETIAP file penting, tulis:
- Nama file + path
- Tujuan file (1 kalimat)
- Kode kunci: kutip 2-5 baris KODE ASLI (gunakan blok kode \`\`\`)
- Analisis: jelaskan APA yang dilakukan kode itu, KENAPA, dan apa DAMPAKNYA
- Masalah: jika ada, jelaskan dengan merujuk baris spesifik

## 3. Alur Data
Trace flow dari input hingga output. Contoh:
1. User input → function X (file.js:10) → diproses di Y (file.js:25) → disimpan ke Z
Sertakan NAMA FILE DAN NOMOR BARIS.

## 4. Arsitektur
Diagram dependency antar file/modul. Jelaskan pola yang dipakai.

## 5. Potensi Masalah & Risiko
Untuk SETIAP masalah:
- [Kritis/Tinggi/Sedang/Rendah]
- Lokasi: {file}:{baris}
- Penjelasan dengan kutipan kode
- Dampak konkret (bukan spekulasi)

## 6. Rekomendasi Konkret
Untuk SETIAP rekomendasi:
- {file}:{baris} — saran perubahan spesifik
- Contoh kode sebelum → sesudah (pakai blok kode)

ATURAN:
- JANGAN panggil finishTask sebelum SEMUA file penting terbaca
- JANGAN hanya kasih deskripsi umum tanpa kutipan kode
- JANGAN nebak-nebak isi file — baca dulu pake readFile
- KALAU ada eval(), innerHTML, dangerouslySetInnerHTML, atau exec() — itu SELALU masalah serius, sebutkan
- Laporan minimal 500 kata, idealnya 1000+ untuk proyek besar
- finishTask: analysis={laporan}, hasModifications=false`;

function buildSystemInstruction(isAnalysisMode) {
  return isAnalysisMode ? analysisModeInstruction : codeModeInstruction;
}

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

function buildOpenAITools(toolsDef) {
  const tools = [];
  for (const group of toolsDef) {
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

function convertContentsToMessages(contents) {
  const messages = [];
  let pendingToolCalls = [];

  for (const content of contents) {
    if (content.role === "user") {
      pendingToolCalls = [];
      const textParts = content.parts.filter(p => p.text).map(p => p.text);
      messages.push({
        role: "user",
        content: textParts.join("\n"),
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
          const res = part.functionResponse.response;
          const textContent = res.error 
            ? `Error: ${res.error}` 
            : (typeof res.result === "string" ? res.result : JSON.stringify(res.result));
            
          messages.push({
            role: "tool",
            tool_call_id: match ? match.id : `call_fallback_${Date.now()}`,
            content: textContent,
          });
        }
      }
    }
  }
  return messages;
}

async function callGroqAPI(model, key, messages, tools, systemInstruction) {
  const payload = {
    model,
    messages: [
      { role: "system", content: systemInstruction },
      ...messages
    ],
    temperature: 0.1,
    // Groq free tier menagih max_tokens yang dideklarasikan (TPM 8000).
    // 8192 = auto-413. Agent loop hanya butuh thought + tool call.
    max_tokens: 2048
  };
  if (tools && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GROQ_API_ERROR: status ${response.status} - ${text}`);
  }

  return response.json();
}

class AIResponse {
  constructor(text, functionCalls) {
    this._text = text || "";
    this._functionCalls = functionCalls || [];
  }
  text() { return this._text; }
  functionCalls() { return this._functionCalls; }
}

export class AgentSession {
  constructor(instruction, toolHandlers, onStatusUpdate, analysisMode = false, context = null) {
    this.instruction = instruction;
    this.toolHandlers = toolHandlers;
    this.onStatusUpdate = onStatusUpdate || (async () => { });
    this.analysisMode = analysisMode;
    this.context = context;
    this.history = [];
    this._lastModelParts = null;

    // Parse and build provider configs
    this.providers = [];
    
    const geminiKeys = (process.env.GEMINI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    const geminiModels = (process.env.GEMINI_MODELS || "gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3-flash-preview")
      .split(",").map(m => m.trim()).filter(Boolean);

    if (geminiKeys.length > 0) {
      this.providers.push({
        name: "gemini",
        keys: shuffle([...geminiKeys]),
        models: geminiModels
      });
    }

    const groqKeys = (process.env.GROQ_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
    const groqModels = (process.env.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile,qwen/qwen3.6-27b")
      .split(",").map(m => m.trim()).filter(Boolean);

    if (groqKeys.length > 0) {
      this.providers.push({
        name: "groq",
        keys: shuffle([...groqKeys]),
        models: groqModels
      });
    }

    const priority = (process.env.AI_PROVIDERS || "gemini,groq")
      .split(",").map(s => s.trim()).filter(Boolean);
      
    this.providers.sort((a, b) => priority.indexOf(a.name) - priority.indexOf(b.name));

    this.activeProviderIdx = 0;
    this.activeModelIdx = 0;
    this.activeKeyIdx = 0;
    
    this.blacklistedCombos = new Set();
  }

  _getActiveConfig() {
    while (this.activeProviderIdx < this.providers.length) {
      const provider = this.providers[this.activeProviderIdx];
      const model = provider.models[this.activeModelIdx];
      const key = provider.keys[this.activeKeyIdx];

      const combo = `${provider.name}:${model}:${key}`;
      if (!this.blacklistedCombos.has(combo)) {
        return { providerName: provider.name, model, key };
      }

      this.activeKeyIdx++;
      if (this.activeKeyIdx >= provider.keys.length) {
        this.activeKeyIdx = 0;
        this.activeModelIdx++;
        if (this.activeModelIdx >= provider.models.length) {
          this.activeModelIdx = 0;
          this.activeProviderIdx++;
        }
      }
    }
    return null;
  }

  _blacklistCurrentAndRotate() {
    const current = this._getActiveConfig();
    if (current) {
      const combo = `${current.providerName}:${current.model}:${current.key}`;
      console.log(`Blacklisting combo: ${combo}`);
      this.blacklistedCombos.add(combo);
    }
    
    const provider = this.providers[this.activeProviderIdx];
    if (provider) {
      this.activeKeyIdx++;
      if (this.activeKeyIdx >= provider.keys.length) {
        this.activeKeyIdx = 0;
        this.activeModelIdx++;
        if (this.activeModelIdx >= provider.models.length) {
          this.activeModelIdx = 0;
          this.activeProviderIdx++;
        }
      }
    }
  }

  _getCleanHistoryForGemini() {
    return this.history.map(h => ({
      role: h.role === "assistant" ? "model" : h.role,
      parts: h.parts.map(p => {
        const cleanedPart = {};
        if (p.text !== undefined) cleanedPart.text = p.text;
        if (p.functionCall !== undefined) cleanedPart.functionCall = p.functionCall;
        if (p.functionResponse !== undefined) cleanedPart.functionResponse = p.functionResponse;
        if (p.thoughtSignature !== undefined) cleanedPart.thoughtSignature = p.thoughtSignature;
        return Object.keys(cleanedPart).length > 0 ? cleanedPart : null;
      }).filter(Boolean)
    })).filter(h => h.parts.length > 0);
  }

  async _sendGroqRequest(model, key) {
    const systemInstruction = buildSystemInstruction(this.analysisMode);
    const messages = convertContentsToMessages(this.history);
    const tools = buildOpenAITools(toolsDefinition);
    
    const responseData = await callGroqAPI(model, key, messages, tools, systemInstruction);
    
    const choice = responseData.choices?.[0];
    if (!choice) {
      throw new Error("GROQ_EMPTY_RESPONSE: Groq returned empty response");
    }
    
    const message = choice.message;
    const text = message.content || "";
    const functionCalls = [];
    
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        if (tc.type === "function") {
          functionCalls.push({
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments)
          });
        }
      }
    }
    
    return new AIResponse(text, functionCalls);
  }

  async _sendWithRetry() {
    let attempts = 0;
    const maxAttempts = 15;

    while (attempts < maxAttempts) {
      attempts++;
      this._lastModelParts = null;
      const config = this._getActiveConfig();
      if (!config) {
        throw new Error("Gagal mengirim pesan: Semua kombinasi provider, model, dan key telah dicoba dan gagal.");
      }

      const { providerName, model, key } = config;
      console.log(`[Attempt ${attempts}] Sending request to ${providerName} using model ${model}...`);
      
      try {
        let aiResponse;
        if (providerName === "gemini") {
          const genAI = new GoogleGenerativeAI(key);
          const geminiModel = genAI.getGenerativeModel({
            model: model,
            systemInstruction: buildSystemInstruction(this.analysisMode),
            tools: toolsDefinition
          });

          const cleanHistory = this._getCleanHistoryForGemini();
          const response = await geminiModel.generateContent({
            contents: cleanHistory,
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8192
            }
          });

          let text = "";
          let functionCalls = [];
          this._lastModelParts = null;

          try {
            const candidate = response.response.candidates?.[0];
            const rawParts = candidate?.content?.parts || [];
            const modelParts = [];

            for (const part of rawParts) {
              if (part.text) {
                text += (text ? "\n" : "") + part.text;
              }
              if (part.functionCall) {
                functionCalls.push(part.functionCall);
              }
              const stored = {};
              if (part.text) stored.text = part.text;
              if (part.functionCall) stored.functionCall = part.functionCall;
              if (part.thoughtSignature) stored.thoughtSignature = part.thoughtSignature;
              if (Object.keys(stored).length > 0) modelParts.push(stored);
            }

            if (modelParts.length > 0) {
              this._lastModelParts = modelParts;
            }
          } catch (e) {
            const candidate = response.response.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            text = parts.map(p => p.text).filter(Boolean).join("\n");
            functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
          }

          aiResponse = new AIResponse(text, functionCalls);
        } else if (providerName === "groq") {
          aiResponse = await this._sendGroqRequest(model, key);
        }

        return aiResponse;
      } catch (err) {
        const msg = err.message || "";
        console.error(`[Error] Gagal menggunakan ${providerName} (${model}): ${msg}`);
        
        this._blacklistCurrentAndRotate();
        
        console.log("Menunggu 5 detik sebelum mencoba kombinasi berikutnya...");
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    throw new Error("Gagal mendapatkan respon dari AI setelah beberapa kali rotasi.");
  }

  async validateTaskCompletion() {
    try {
      try {
        execSync('git add -N .', { encoding: 'utf8' });
      } catch (e) {
        console.warn("Gagal menjalankan git add -N:", e.message);
      }
      const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
      const gitDiff = execSync('git diff', { encoding: 'utf8' }).trim();

      const prompt = `Kamu adalah sistem validator independen. Tugasmu adalah memeriksa apakah Agen Pengembang (Kokoa Dev Agent) telah menyelesaikan instruksi pengguna secara lengkap dan benar.

Instruksi Pengguna:
"${this.instruction}"

Status Git Workspace Saat Ini (git status):
${status || "(tidak ada perubahan file)"}

Detail Perubahan (git diff):
${gitDiff.substring(0, 10000) || "(tidak ada perbedaan/file baru)"}

Analisis apakah seluruh file, konfigurasi, dan modifikasi yang diminta atau tersirat dalam instruksi pengguna telah diimplementasikan dengan benar.
Khususnya, pastikan tidak ada file utama yang terlewat (misal: jika diminta membuat landing page React, pastikan file index.html atau App.jsx/App.tsx benar-benar dibuat dan diubah, bukan hanya file style/css saja).
Pastikan juga konfigurasi eksternal (seperti GitHub Actions workflow jika diminta) sudah dibuat dengan lengkap.
PENTING: Pembuatan branch, commit, push, dan Pull Request DILAKUKAN OTOMATIS oleh executor setelah agent selesai — BUKAN tugas agent. Jadi instruksi seperti "Create a Pull Request", "commit", atau "push" HARUS diabaikan dalam penilaian dan TIDAK boleh membuat isComplete=false.
Abaikan juga file binary hasil build (seperti 'server', '*.exe', '*.out') — itu artefak verifikasi, bukan bagian tugas.

Format keluaran kamu harus berupa JSON dengan skema berikut:
{
  "isComplete": boolean,
  "reason": "Penjelasan detail mengapa belum lengkap, sebutkan file atau bagian kode yang kurang jika isComplete bernilai false. Jika isComplete bernilai true, berikan penjelasan singkat keberhasilan."
}`;

      const config = this._getActiveConfig();
      if (!config) {
        throw new Error("No active AI configuration available for validation.");
      }

      const { providerName, model, key } = config;
      let responseText = "";

      if (providerName === "gemini") {
        const genAI = new GoogleGenerativeAI(key);
        const geminiModel = genAI.getGenerativeModel({
          model: model,
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1,
          }
        });
        const result = await geminiModel.generateContent(prompt);
        responseText = result.response.text();
      } else if (providerName === "groq") {
        const payload = {
          model,
          messages: [
            { role: "user", content: prompt }
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
        };
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          throw new Error(`Groq validation request failed: ${response.status}`);
        }
        const data = await response.json();
        responseText = data.choices?.[0]?.message?.content || "";
      }

      const validation = JSON.parse(responseText);
      return validation;
    } catch (error) {
      console.error("Gagal menjalankan validasi LLM:", error);
      const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
      return {
        isComplete: !!status,
        reason: status ? "Validasi LLM gagal, menggunakan fallback git status." : "Tidak ada perubahan terdeteksi di git status."
      };
    }
  }

  async start() {
    this.history = [];

    let contextPreamble = '';
    if (this.context) {
      if (this.context.memories?.length > 0) {
        contextPreamble += 'MEMORI DARI PERCAKAPAN SEBELUMNYA:\n' +
          this.context.memories.map(m => `- ${m.key}: ${m.value}`).join('\n') + '\n\n';
      }
      if (this.context.task_plan?.length > 0) {
        contextPreamble += 'RENCANA TUGAS:\n' +
          this.context.task_plan.map(t => `- [${t.status}] ${t.title}`).join('\n') + '\n\n';
      }
      if (this.context.history?.length > 0) {
        contextPreamble += 'RIWAYAT PERCAKAPAN SEBELUMNYA:\n' +
          this.context.history.slice(-5).map(h =>
            `[${h.role}]: ${h.parts?.map(p => p.text).filter(Boolean).join(' ').substring(0, 200)}`
          ).join('\n') + '\n\n';
      }
    }
    
    let isTaskFinished = false;
    let finalResult = null;
    let nextMessage = `INSTRUKSI USER: ${this.instruction}\n\n${contextPreamble}Lakukan tugas ini secara bertahap menggunakan tools.`;
    
    this.history.push({ role: "user", parts: [{ text: nextMessage }] });

    let loopCount = 0;
    const MAX_LOOPS = 100;
    let validationFailCount = 0;
    let lastNonFinishTool = null;

    console.log(`\n--- Agent Loop Start ---`);
    let response = await this._sendWithRetry();

    while (!isTaskFinished && loopCount < MAX_LOOPS) {
      loopCount++;
      try {
        console.log(`\n--- Agent Loop ${loopCount} ---`);

        await new Promise(resolve => setTimeout(resolve, 1000));

        const textOutput = response.text();
        if (textOutput) {
          console.log(`Agent Thought: ${textOutput.substring(0, 200)}...`);
        }

        const functionCalls = response.functionCalls();
        
        if (this._lastModelParts) {
          this.history.push({
            role: "model",
            parts: this._lastModelParts
          });
          this._lastModelParts = null;
        } else {
          this.history.push({
            role: "model",
            parts: [
              textOutput ? { text: textOutput } : null,
              ...functionCalls.map(fc => ({ functionCall: fc }))
            ].filter(Boolean)
          });
        }

        if (!functionCalls || functionCalls.length === 0) {
          console.log("Agent tidak memanggil tool apa-apa. Memberikan peringatan...");
          const nudge = "Kamu belum memanggil tool apapun. Tolong gunakan tool yang tersedia untuk mengeksplorasi file, menulis kode, atau panggil finishTask jika sudah selesai.";
          
          this.history.push({ role: "user", parts: [{ text: nudge }] });
          response = await this._sendWithRetry();
          continue;
        }

        const toolResponses = [];
        let finishTaskCall = null;

        for (const call of functionCalls) {
          const { name, args } = call;
          console.log(`\n🛠️ Agent memanggil tool: ${name}`);
          console.log(`Argumen:`, JSON.stringify(args, null, 2).substring(0, 300));

          await this.onStatusUpdate(`🛠️ Memanggil tool: \`${name}\`...`);

          if (name === "finishTask") {
            finishTaskCall = { name, args };
            continue;
          }

          lastNonFinishTool = name;

          if (this.toolHandlers[name]) {
            try {
              const res = await this.toolHandlers[name](args);
              toolResponses.push({
                functionResponse: {
                  name,
                  response: { success: true, result: res }
                }
              });
            } catch (err) {
              console.error(`Error eksekusi tool ${name}:`, err.message);
              toolResponses.push({
                functionResponse: {
                  name,
                  response: { success: false, error: err.message }
                }
              });
            }
          } else {
            toolResponses.push({
              functionResponse: {
                name,
                response: { success: false, error: `Tool ${name} tidak ditemukan.` }
              }
            });
          }
        }

        if (finishTaskCall) {
          const { name, args } = finishTaskCall;

          if (this.analysisMode) {
            console.log("Mode analysis: langsung selesai tanpa validasi git.");
            isTaskFinished = true;
            finalResult = args;
            toolResponses.push({
              functionResponse: {
                name,
                response: { success: true, message: "Analisis selesai." }
              }
            });
          } else {
            console.log("Menjalankan validasi LLM dinamis untuk finishTask...");

            const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
            if (args.hasModifications && !status) {
              console.log("Validasi GAGAL: Agen mengklaim ada modifikasi, tapi git status kosong.");
              toolResponses.push({
                functionResponse: {
                  name,
                  response: {
                    success: false,
                    error: "TUGAS BELUM SELESAI! Kamu mengklaim telah melakukan modifikasi (hasModifications: true), tetapi tidak ada file yang dibuat atau diedit di git status. Kamu WAJIB memanggil writeFile untuk melakukan tugas coding sebelum memanggil finishTask."
                  }
                }
              });
            } else {
              const validation = await this.validateTaskCompletion();
              if (!validation.isComplete) {
                validationFailCount++;
                console.log(`Validasi GAGAL (ke-${validationFailCount}): ${validation.reason}`);

                if (validationFailCount >= 2) {
                  console.log("Validasi gagal 2 kali. Force-finish dengan hasil yang ada...");
                  isTaskFinished = true;
                  finalResult = {
                    ...args,
                    commitMessage: args.commitMessage || "chore: partial changes",
                    branchName: args.branchName || `auto-fix/${Date.now()}`,
                    prTitle: args.prTitle || "Auto-fix (partial)",
                    prBody: (args.prBody || "") + `\n\n⚠️ Catatan: tugas force-finish karena stuck setelah ${loopCount} langkah. Mungkin ada yang terlewat.`,
                    hasModifications: args.hasModifications || !!lastNonFinishTool,
                  };
                  toolResponses.push({
                    functionResponse: {
                      name,
                      response: { success: true, message: "Task dipaksa selesai (2x validasi gagal). Push partial changes." }
                    }
                  });
                } else {
                  toolResponses.push({
                    functionResponse: {
                      name,
                      response: {
                        success: false,
                        error: `TUGAS BELUM LENGKAP! Berdasarkan analisis repositori: ${validation.reason}. Silakan selesaikan sisa tugas, terutama pastikan file besar ditulis dalam beberapa bagian (chunk) pakai append=true.`
                      }
                    }
                  });
                }
              } else {
                console.log("Validasi SUKSES! Mengakhiri tugas.");
                isTaskFinished = true;
                finalResult = args;
                toolResponses.push({
                  functionResponse: {
                    name,
                    response: { success: true, message: "Task ditandai selesai." }
                  }
                });
              }
            }
          }
        }

        this.history.push({
          role: "function",
          parts: toolResponses
        });

        if (isTaskFinished) {
          break;
        }

        response = await this._sendWithRetry();

      } catch (err) {
        console.error(`Error in loop:`, err.message);
        try {
          this.history.push({
            role: "user",
            parts: [{ text: `Terjadi error tak terduga: ${err.message}. Coba gunakan cara lain.` }]
          });
          response = await this._sendWithRetry();
        } catch (innerErr) {
          console.error("Gagal memulihkan dari error tak terduga:", innerErr.message);
          throw err;
        }
      }
    }

    if (!isTaskFinished) {
      console.log("Mencapai MAX_LOOPS tanpa finishTask.");
      const partial = {
        commitMessage: "chore: partial changes from agent",
        branchName: `auto-fix/${Date.now()}`,
        prTitle: "Auto-fix (partial — max loops)",
        prBody: `Agent berhenti setelah ${MAX_LOOPS} langkah (validasi gagal ${validationFailCount}x). Mungkin ada bagian yang terlewat.`,
        hasModifications: true,
      };
      console.log("Force-finish dengan partial result...");
      return partial;
    }

    return finalResult;
  }
}