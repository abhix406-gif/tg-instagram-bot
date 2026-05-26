import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Health-check endpoint for cloud platforms (Render, Koyeb, etc.)
app.get('/health', (_req, res) => res.status(200).send('OK'));

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

