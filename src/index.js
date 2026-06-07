import { createBot } from './telegram/bot.js';
import { resetDeviceTracker } from './instagram/registration.js';
import { attachBotToWebhook, createWebhookServer } from './telegram/webhook_server.js';
import { startKeepAlive, stopKeepAlive } from './keepalive.js';
import 'dotenv/config';

// Global crash guards – prevent WhatsApp/network errors from killing the bot
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
  // Don't exit – keep the Telegram bot alive
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
  // Don't exit – keep the Telegram bot alive
});

/**
 * Determine run mode:
 *   RENDER=true + RENDER_EXTERNAL_URL → webhook mode (Render auto-detection)
 *   WEBHOOK_BASE_URL set             → webhook mode (manual override)
 *   neither set                      → polling mode (local PC / PM2)
 */
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL
  || (process.env.RENDER === 'true' ? process.env.RENDER_EXTERNAL_URL : null);
const RUN_MODE = WEBHOOK_BASE_URL ? 'webhook' : 'polling';
const PORT = Number(process.env.PORT || 3000);

// Secret token for webhook verification (prevents unauthorized POSTs)
// Auto-generate a random one if not set, but prefer env var for persistence
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET_TOKEN
  || Buffer.from(Date.now().toString(36)).toString('base64url').slice(0, 32);

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  📸 Instagram Bot — ${RUN_MODE.toUpperCase()} MODE`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Reset device tracker on startup — all fingerprints become reusable
  resetDeviceTracker();

  console.log('  🤖 Starting Telegram bot...');
  const bot = await createBot();

  // Graceful shutdown handler (works for both modes)
  async function shutdown() {
    console.log('\n  ⏹️  Shutting down...');
    stopKeepAlive();
    if (RUN_MODE === 'webhook') {
      await bot.telegram.deleteWebhook();
    }
    bot.stop();
    process.exit(0);
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (RUN_MODE === 'webhook') {
    // ── Webhook mode (cloud deployment) ──
    const webhookUrl = WEBHOOK_BASE_URL.replace(/\/$/, '') + '/telegram';
    console.log(`  🌐 Webhook URL: ${webhookUrl}`);

    // Attach bot to Express webhook route
    attachBotToWebhook(bot);

    // Start Express server
    const server = await createWebhookServer(PORT);

    // 24/7 keep-alive: self-ping every 10 min to prevent Render idle spin-down
    startKeepAlive(PORT);

    // Register webhook with Telegram
    // drop_pending_updates: false — DON'T discard messages sent while bot was starting up
    // secret_token — verifies incoming webhook POSTs are genuinely from Telegram
    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: false,
      secret_token: WEBHOOK_SECRET,
    });
    console.log(`  ✅ Webhook registered — bot is LIVE`);
  } else {
    // ── Polling mode (local) ──
    // Aggressive retry with webhook verification.
    // Render can re-apply its webhook within 1–2 seconds, so we verify the delete worked.
    const MAX_RETRIES = 30;
    let launched = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Step 1: delete any existing webhook
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log(`  🧹 [attempt ${attempt + 1}/${MAX_RETRIES}] Webhook deleted`);
      } catch (_) {
        console.log(`  🧹 [attempt ${attempt + 1}/${MAX_RETRIES}] No webhook to delete`);
      }

      // Step 2: Verify webhook is ACTUALLY gone (Render may have re-applied it)
      try {
        const whInfo = await bot.telegram.getWebhookInfo();
        if (whInfo.url && whInfo.url.length > 0) {
          console.log(`  ⚠️  Render re-applied webhook: ${whInfo.url}`);
          const wait = 500 + attempt * 200;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      } catch (_) { /* proceed */ }

      // Step 3: launch polling
      try {
        await bot.launch({ dropPendingUpdates: false });
        console.log('  ✅ Bot is running (polling mode)');
        launched = true;
        break;
      } catch (err) {
        if (err?.response?.error_code === 409) {
          const wait = Math.min(200 + attempt * 100, 1000);
          console.log(`  ⚠️  [attempt ${attempt + 1}] 409 conflict — retrying in ${wait}ms...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    if (!launched) {
      console.error('  ❌ Could not launch polling — Render keeps re-applying webhook');
      console.error('     Stop the Render deployment first (render.com dashboard),');
      console.error('     or set WEBHOOK_BASE_URL in .env for local webhook mode.');
      process.exit(1);
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (RUN_MODE === 'polling') {
    console.log('  Send /register to start');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});