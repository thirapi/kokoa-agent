// Atribusi ala Claude Code: kamu (pemilik) = author, Cocoa = co-author.
// Bisa diubah lewat env tanpa mengubah kode.
export function ownerIdentity(env = {}) {
  return {
    name: env.OWNER_GIT_NAME || "thirapi",
    email: env.OWNER_GIT_EMAIL || "132630759+thirapi@users.noreply.github.com",
  };
}

export function botIdentity(env = {}) {
  return {
    name: env.BOT_GIT_NAME || "Cocoa",
    email: env.BOT_GIT_EMAIL || "270871570+ccocoa@users.noreply.github.com",
  };
}

export function coAuthorTrailer(env = {}) {
  const b = botIdentity(env);
  return `Co-Authored-By: ${b.name} <${b.email}>`;
}

// Tambahkan trailer co-author sekali saja (idempoten).
export function withCoAuthor(message, env = {}) {
  const msg = String(message || "").trimEnd() || "chore: update";
  const trailer = coAuthorTrailer(env);
  if (msg.toLowerCase().includes(trailer.toLowerCase())) return msg;
  return `${msg}\n\n${trailer}`;
}

export const PR_FOOTER = "🤖 Dibuat bersama Cocoa";

export function withPrFooter(body) {
  const b = String(body || "").trimEnd();
  if (b.includes(PR_FOOTER)) return b;
  return b ? `${b}\n\n---\n${PR_FOOTER}` : PR_FOOTER;
}
