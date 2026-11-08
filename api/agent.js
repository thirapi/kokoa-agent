// Vercel Function: menjalankan agent loop (maks 300 detik) untuk tugas yang terlalu
// lama bagi Worker. Diukur: dari Vercel, Telegram/Worker/AI/GitHub semuanya lancar
// (lihat docs/research/hf-egress-probe.md), jadi tidak perlu proxy seperti di HF.
import { waitUntil } from "@vercel/functions";
import { isAuthorizedHeader } from "../src/utils/auth.js";
import { executeRemoteJob, deliverToWorker } from "../src/agent/remote-job.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ status: "ok", runtime: "vercel" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  if (!isAuthorizedHeader(req.headers.authorization, process.env)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const job = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const workerUrl = job.workerUrl || process.env.WORKER_URL;
  if (!job.chatId || !workerUrl) return res.status(400).json({ error: "Missing chatId/workerUrl" });

  res.status(202).json({ status: "processing" });
  waitUntil((async () => {
    const data = await executeRemoteJob(job, process.env, { runtime: "vercel" });
    await deliverToWorker(workerUrl, process.env, job.chatId, data);
  })());
}
