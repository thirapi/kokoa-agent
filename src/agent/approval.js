// Approval gate ala Opencode/Cline: tool berisiko tinggi wajib dikonfirmasi
// user via tombol inline sebelum dieksekusi. Loop di-pause (snapshot),
// dilanjutkan lagi saat user klik ✅ / ❌ (suspend → resume).

// Prinsip: minta izin HANYA untuk aksi yang mengubah sesuatu di luar sandbox dan
// sulit dibatalkan. Pekerjaan di workspace Spaces (/tmp, hilang saat restart) atau di
// runner GitHub Actions (VM sekali pakai, hasilnya berupa PR yang bisa direview)
// tidak perlu izin — menunggu tombol hanya membuang waktu.
//
// - createOrUpdateFile / deleteFile: commit LANGSUNG ke repo GitHub.
// - mergePullRequest: mengubah branch target.
export const HIGH_RISK_TOOLS = new Set([
  'createOrUpdateFile',
  'deleteFile',
  'mergePullRequest',
]);

// runCommand di workspace Spaces: bebas, KECUALI perintah yang menyentuh dunia luar.
// (Remote git hasil cloneRepo berisi token, jadi `git push` benar-benar mendorong ke GitHub.)
const RISKY_COMMAND = new RegExp([
  String.raw`\bgit\s+push\b`,
  String.raw`\bgit\s+remote\s+(set-url|add)\b`,
  String.raw`\bgh\s+(pr|repo|release|issue|api|workflow|secret)\b`,
  String.raw`\bnpm\s+(publish|unpublish|deprecate)\b`,
  String.raw`\b(curl|wget)\b[^|;&]*(-X\s*(POST|PUT|PATCH|DELETE)|--data\b|--data-\w+|-d\s|--upload-file|-T\s|--method[= ](POST|PUT|PATCH|DELETE))`,
  String.raw`\brm\s+(-\w*\s+)*(\/(?!tmp\b)|~|\$HOME)`,
  String.raw`\b(shutdown|reboot|kill\s+-9\s+1|mkfs)\b`,
].join("|"), "i");

export function isRiskyCommand(command) {
  return RISKY_COMMAND.test(String(command || ""));
}

export function isHighRiskTool(name) {
  return HIGH_RISK_TOOLS.has(name);
}

// Keputusan akhir: butuh tombol izin atau tidak.
export function needsApproval(name, args = {}) {
  if (HIGH_RISK_TOOLS.has(name)) return true;
  if (name === 'runCommand' || name === 'executeCommand') return isRiskyCommand(args?.command);
  return false;
}

export function toolCallKey(name, args) {
  const raw = `${name}:${JSON.stringify(args || {})}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `${name}:${(hash >>> 0).toString(36)}`;
}

export class ApprovalPending extends Error {
  constructor(approvalId) {
    super("__APPROVAL_PENDING__");
    this.approvalId = approvalId;
  }
}

export function approvalKVKey(id) {
  return `approval:${id}`;
}

export async function saveApproval(env, id, record, ttlSeconds = 3600) {
  await env.CHAT_HISTORY.put(approvalKVKey(id), JSON.stringify(record), { expirationTtl: ttlSeconds });
}

export async function loadApproval(env, id) {
  try {
    const raw = await env.CHAT_HISTORY.get(approvalKVKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export async function deleteApproval(env, id) {
  try {
    await env.CHAT_HISTORY.delete(approvalKVKey(id)).catch(() => {});
  } catch (_) {}
}

// Strip media base64 agar snapshot muat di KV dan tidak bocor biner besar
export function stripMediaForSnapshot(contents) {
  return (contents || []).map(c => ({
    role: c.role,
    parts: (c.parts || []).map(p => {
      if (p.inline_data) return { text: `[Media: ${p.inline_data.mime_type}]` };
      if (p.functionCall) return { functionCall: p.functionCall };
      if (p.functionResponse) {
        return {
          functionResponse: {
            name: p.functionResponse.name,
            response: p.functionResponse.response,
          },
        };
      }
      if (p.text !== undefined) return { text: p.text };
      return { text: "" };
    }),
  }));
}

export function approvalButtons(approvalId) {
  return {
    inline_keyboard: [[
      { text: "✅ gas lanjut", callback_data: `approve:${approvalId}` },
      { text: "❌ batalin", callback_data: `deny:${approvalId}` },
    ]],
  };
}

export function approvalPromptText(toolName, args) {
  const argPreview = JSON.stringify(args || {}, null, 1).slice(0, 800);
  return `cocoa mau jalanin tool berisiko nih wkwk\n\ntool: <b>${toolName}</b>\nargumen:\n<pre>${argPreview.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>\n\nlanjut atau batalin?`;
}
