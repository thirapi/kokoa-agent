import { handleWebhook } from "./handlers/webhook.js";
import { handleCron } from "./handlers/cron.js";
import { handleAPI } from "./handlers/api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route to API handlers
    if (url.pathname.startsWith("/api/")) {
      return handleAPI(request, env, ctx);
    }

    // Route to webhook (Telegram)
    return handleWebhook(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    await handleCron(event, env, ctx);
  },
};
