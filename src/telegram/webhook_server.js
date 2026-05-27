import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Webhook secret-token verification middleware ──
// Telegram sends `X-Telegram-Bot-Api-Secret-Token` header on every webhook POST.
// We validate it to reject unauthorized requests from anyone other than Telegram.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET_TOKEN;
if (WEBHOOK_SECRET) {
  app.use('/telegram', (req, res, next) => {
    // Only validate on POST (the actual webhook deliveries)
    if (req.method === 'POST') {
      const token = req.headers['x-telegram-bot-api-secret-token'];
      if (!token || token !== WEBHOOK_SECRET) {
        console.warn('[webhook] ⛔ Rejected unauthorized POST — invalid or missing secret token');
        return res.status(403).send('Forbidden');
      }
    }
    next();
  });
}

// Health-check endpoint for cloud platforms (Render, Koyeb, etc.)
// Also used by the built-in keep-alive self-pinger.
app.get('/health', (_req, res) => res.status(200).send('OK'));

// Uptime-monitor-friendly ping endpoint — returns JSON for external services
// like UptimeRobot, Cron-job.org, or Freshping.
// Usage: GET /ping → { "status": "ok", "uptime": process.uptime(), "timestamp": ISO }
app.get('/ping', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    mode: process.env.WEBHOOK_BASE_URL || process.env.RENDER_EXTERNAL_URL ? 'webhook' : 'polling',
  });
});

/**
 * Attach Telegraf's webhookCallback to the Express app.
 * This lets the same Express server serve the Telegram webhook.
 * @param {import('telegraf').Telegraf} bot
 */
export function attachBotToWebhook(bot) {
  // Telegraf 4.x webhookCallback returns (req, res) => void
  app.post('/telegram', bot.webhookCallback?.('/telegram') ?? bot.webhookCallback?.() ?? (() => {}));
}

/**
 * Start the Express server on the given port.
 * @param {number} port
 * @returns {Promise<import('http').Server>}
 */
export function createWebhookServer(port = Number(process.env.PORT || 3000)) {
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`✅ Webhook server listening on http://0.0.0.0:${port}`);
      resolve(server);
    });
  });
}

export { app };

