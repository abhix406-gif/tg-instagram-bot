/**
 * Keep-Alive Self-Pinger — Prevents Render Free-Tier Idle Spin-Down
 *
 * Render's free tier puts web services to sleep after 15 minutes of inactivity.
 * This module periodically hits the service's own /health endpoint (every 10 min)
 * to keep it "warm" 24/7 without exceeding the 750 hr/month free runtime quota.
 *
 * The ping is an internal localhost HTTP request — it does NOT consume Render's
 * outgoing bandwidth allowance since the traffic stays within their network.
 *
 * Usage (auto on Render/webhook mode):
 *   import { startKeepAlive } from './keepalive.js';
 *   startKeepAlive();
 *
 * Disable via env: KEEP_ALIVE=false
 */

import http from 'node:http';

// How often to self-ping (ms). 10 min = 600 s, well under the 15-min idle threshold.
const PING_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 600_000);

// Track consecutive healthy/failed pings for logging
let consecutiveSuccesses = 0;
let consecutiveFailures = 0;
let intervalId = null;

/**
 * Starts the keep-alive self-pinger. Safe to call multiple times; ignores if already running.
 * @param {number} [port] Port to ping (defaults to process.env.PORT || 3000)
 */
export function startKeepAlive(port) {
  // Bail if explicitly disabled
  if (process.env.KEEP_ALIVE === 'false') {
    console.log('[keepalive] Disabled via KEEP_ALIVE=false — service may sleep on idle.');
    return;
  }

  // Already running — don't double-start
  if (intervalId) {
    console.log('[keepalive] Already running — skipping.');
    return;
  }

  const targetPort = port || Number(process.env.PORT || 3000);
  const targetUrl = `http://localhost:${targetPort}/health`;

  console.log(`[keepalive] Starting self-ping to ${targetUrl} every ${(PING_INTERVAL_MS / 1000)}s`);
  console.log('[keepalive] This prevents Render free-tier idle spin-down (15-min threshold)');

  // Fire immediately on start
  ping(targetUrl);

  // Then fire on interval
  intervalId = setInterval(() => ping(targetUrl), PING_INTERVAL_MS);

  // Allow the event loop to exit during graceful shutdown
  intervalId.unref();
}

/**
 * Stops the keep-alive pinger. Safe to call when shutting down.
 */
export function stopKeepAlive() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[keepalive] Stopped.');
  }
}

/**
 * Performs a single self-ping to the /health endpoint.
 */
function ping(url) {
  const req = http.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200 && data.trim() === 'OK') {
        consecutiveSuccesses++;
        consecutiveFailures = 0;
        // Log only every 6th success (~hourly) to avoid log spam
        if (consecutiveSuccesses % 6 === 0) {
          console.log(`[keepalive] ✅ Health OK (${consecutiveSuccesses} consecutive pings)`);
        }
      } else {
        consecutiveFailures++;
        consecutiveSuccesses = 0;
        console.warn(`[keepalive] ⚠️ Unexpected response: HTTP ${res.statusCode}: "${data.trim()}"`);
      }
    });
  });

  req.on('error', (err) => {
    consecutiveFailures++;
    consecutiveSuccesses = 0;
    console.warn(`[keepalive] ❌ Ping failed (attempt #${consecutiveFailures}): ${err.message}`);
  });

  req.setTimeout(10_000, () => {
    req.destroy();
    console.warn('[keepalive] ⏰ Ping timed out after 10s');
  });
}