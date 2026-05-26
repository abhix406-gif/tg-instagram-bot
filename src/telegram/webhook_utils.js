export function getWebhookUrl() {
  // Expected env: WEBHOOK_BASE_URL like https://xxxx.ngrok-free.app
  // Final webhook endpoint is `${base}/telegram`
  const base = process.env.WEBHOOK_BASE_URL;
  if (!base) return null;
  return base.replace(/\/$/, '') + '/telegram';
}

