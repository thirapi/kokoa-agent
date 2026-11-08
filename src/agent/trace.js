// Jejak per tugas: panggilan LLM, tool, approval, keputusan routing.
// Dikumpulkan di memori selama agent loop (di runtime mana pun), lalu disimpan
// Worker ke D1 (tabel task_traces) dan bisa dilihat lewat /trace.

const MAX_EVENTS = 200;
const SECRETISH = /(token|secret|key|password|authorization)/i;

export function summarizeArgs(args) {
  try {
    const clean = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (SECRETISH.test(k)) { clean[k] = "***"; continue; }
      clean[k] = typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v;
    }
    const s = JSON.stringify(clean);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch (_) {
    return "";
  }
}

export function createTracer() {
  const t0 = Date.now();
  const events = [];
  return {
    events,
    startedAt: t0,
    add(kind, name, data = {}) {
      if (events.length >= MAX_EVENTS) return;
      events.push({ t: Date.now() - t0, kind, name, ...data });
    },
  };
}

export function traceStatus({ error, approval, escalationTriggered } = {}) {
  if (approval) return "approval";
  if (error) return "error";
  if (escalationTriggered) return "escalated";
  return "ok";
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

// Render HTML Telegram untuk /trace.
export function formatTrace(row, maxLines = 40) {
  if (!row) return "belum ada jejak tugas yang tercatat.";
  let events = [];
  try { events = JSON.parse(row.events || "[]"); } catch (_) {}
  const head = [
    `<b>trace tugas terakhir</b>`,
    `runtime: <b>${esc(row.runtime)}</b> · status: <b>${esc(row.status)}</b> · durasi: ${fmtMs(row.duration_ms || 0)}`,
    row.prompt ? `prompt: <i>${esc(String(row.prompt).slice(0, 120))}</i>` : null,
    "",
  ].filter((x) => x !== null);
  const lines = events.slice(0, maxLines).map((e) => {
    const mark = e.ok === false ? "✗" : e.ok === true ? "✓" : "•";
    const extra = [e.ms != null ? fmtMs(e.ms) : null, e.args || null, e.error ? `⚠️ ${e.error}` : null, e.note || null]
      .filter(Boolean).map(esc).join(" · ");
    return `+${fmtMs(e.t)} ${mark} <code>${esc(e.kind)}</code> ${esc(e.name)}${extra ? " — " + extra : ""}`;
  });
  if (events.length > maxLines) lines.push(`… (${events.length - maxLines} event lagi)`);
  return [...head, ...lines].join("\n");
}
