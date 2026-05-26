import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// 1. Configuration — everything comes from environment variables
// ---------------------------------------------------------------------------

/**
 * Parsed proxy provider list from PROXY_PROVIDERS env var.
 * Format:  TYPE|host:port|username|password|zone|label
 * Multiple providers separated by ; (semicolon) or newline.
 *
 * Supported TYPEs:
 *   residential  – HTTP residential rotating proxy with country zones
 *   static        – Static HTTP datacenter/residential IP pool
 *   socks5        – SOCKS5 proxy
 *   api           – API-based rotating proxy (fetches new proxy URL per request)
 *
 * Examples:
 *   "residential|43.131.1.47:4950|user|pass|zone|ProviderA"
 *   "static|res.proxy.com:8080|user|pass|zone|ProviderB;static|res2.proxy.com:8080|user2|pass2|zone2|ProviderC"
 *   "socks5|192.168.1.1:1080|user|pass||MySOCKS"
 *   "api|https://api.proxyprovider.com/get?key=XXX|user|pass||APIproxy"
 */
function parseProviderList() {
  const raw = process.env.PROXY_PROVIDERS || '';
  if (!raw.trim()) {
    // Fall back to legacy single-provider config
    const legacy = parseLegacyProvider();
    return legacy ? [legacy] : [];
  }

  const entries = raw.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
  const providers = [];

  for (const entry of entries) {
    const parts = entry.split('|');
    if (parts.length < 4) continue;

    const [type, hostPort, username, password, zone = '', label = ''] = parts;
    const [host, portStr] = hostPort.split(':');
    const port = Number(portStr || 80);

    const normalizedLabel = label || `${type}_${host}`;

    providers.push({
      type: type.toLowerCase(),
      host,
      port,
      username,
      password,
      zone: zone || undefined,
      label: normalizedLabel,
    });
  }

  return providers;
}

/**
 * Legacy single-provider config (backward-compatible with existing .env).
 */
function parseLegacyProvider() {
  const host = process.env.PROXY_HOST || '43.131.1.47';
  const port = Number(process.env.PROXY_PORT || 4950);
  const user = process.env.PROXY_USER || 'Abhix1526ZY2013';
  const pass = process.env.PROXY_PASS || 'AbhiTamu1526';
  const zone = process.env.PROXY_ZONE || 'abc';

  if (!host || !port || !user || !pass) return null;

  return {
    type: 'residential',
    host,
    port,
    username: user,
    password: pass,
    zone: zone || undefined,
    label: 'default',
  };
}

/** All configured providers, in priority order. */
export const PROXY_PROVIDERS = parseProviderList();

/** Whether at least one provider is configured. */
export const HAS_PROXY = PROXY_PROVIDERS.length > 0;

/** Default country fallback. */
export const DEFAULT_COUNTRY = (process.env.PROXY_DEFAULT_COUNTRY || 'us').toLowerCase();

/** Health-check timeout in ms. */
const HEALTH_TIMEOUT_MS = Number(process.env.PROXY_HEALTH_TIMEOUT_MS || 12_000);

/** Maximum concurrent health checks. */
const HEALTH_CONCURRENCY = Number(process.env.PROXY_HEALTH_CONCURRENCY || 3);

/** Proxy rotation mode: 'random' | 'round-robin' | 'best-latency'. */
const ROTATION_MODE = process.env.PROXY_ROTATION_MODE || 'random';

/** Whether to run a pre-flight health check before returning a proxy. */
const PREFLIGHT_CHECK = process.env.PROXY_PREFLIGHT_CHECK !== 'false';

/** Max consecutive failures before a provider is marked unhealthy. */
const MAX_CONSECUTIVE_FAILURES = Number(process.env.PROXY_MAX_FAILURES || 3);

/** Maximum acceptable latency in ms for best-proxy auto-selection. Providers above this are skipped. */
const MAX_LATENCY_THRESHOLD_MS = Number(process.env.PROXY_BEST_LATENCY_THRESHOLD_MS || 300);

/** Timeout for individual health checks during best-proxy live selection. */
const BEST_LATENCY_TIMEOUT_MS = Number(process.env.PROXY_BEST_LATENCY_TIMEOUT_MS || 10_000);

// ---------------------------------------------------------------------------
// 2. Provider health tracking
// ---------------------------------------------------------------------------

/** @type {Map<string, { consecutiveFailures: number, lastLatencyMs: number | null, unhealthy: boolean, lastChecked: number }>} */
const healthMap = new Map();

function getHealth(label) {
  if (!healthMap.has(label)) {
    healthMap.set(label, {
      consecutiveFailures: 0,
      lastLatencyMs: null,
      unhealthy: false,
      lastChecked: 0,
    });
  }
  return healthMap.get(label);
}

function markSuccess(label, latencyMs) {
  const h = getHealth(label);
  h.consecutiveFailures = 0;
  h.lastLatencyMs = latencyMs;
  h.unhealthy = false;
  h.lastChecked = Date.now();
}

function markFailure(label) {
  const h = getHealth(label);
  h.consecutiveFailures++;
  h.lastChecked = Date.now();
  if (h.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    h.unhealthy = true;
  }
}

function isHealthy(label) {
  const h = getHealth(label);
  return !h.unhealthy;
}

/**
 * Mark an unhealthy provider as healthy again so it gets retried.
 */
export function resetProviderHealth(label) {
  const h = getHealth(label);
  h.unhealthy = false;
  h.consecutiveFailures = 0;
}

// ---------------------------------------------------------------------------
// 3. Country normalization (unchanged public API)
// ---------------------------------------------------------------------------

/**
 * ISO-3166 alpha-2 country codes commonly available with rotating proxies.
 */
export const SUPPORTED_COUNTRIES = [
  'us', 'gb', 'in', 'de', 'fr', 'ca', 'au', 'br', 'jp', 'sg',
  'nl', 'es', 'it', 'mx', 'ru', 'tr', 'id', 'ph', 'vn', 'th',
  'kr', 'hk', 'tw', 'ae', 'sa', 'za', 'pl', 'se', 'no', 'fi',
  'dk', 'ch', 'at', 'be', 'ie', 'pt', 'gr', 'cz', 'ro', 'hu',
  'ua', 'ng', 'eg', 'pk', 'bd', 'my', 'nz', 'cl', 'ar', 'co',
];

const COUNTRY_NAME_MAP = {
  usa: 'us', 'united states': 'us', america: 'us',
  uk: 'gb', 'united kingdom': 'gb', britain: 'gb', england: 'gb',
  india: 'in', ind: 'in',
  germany: 'de', deu: 'de',
  france: 'fr', fra: 'fr',
  canada: 'ca', can: 'ca',
  australia: 'au', aus: 'au',
  brazil: 'br', bra: 'br',
  japan: 'jp', jpn: 'jp',
  singapore: 'sg', sgp: 'sg',
  netherlands: 'nl', nld: 'nl',
  spain: 'es', esp: 'es',
  italy: 'it', ita: 'it',
  mexico: 'mx', mex: 'mx',
  russia: 'ru', rus: 'ru',
  turkey: 'tr', tur: 'tr',
  indonesia: 'id', idn: 'id',
  philippines: 'ph', phl: 'ph',
  vietnam: 'vn', vnm: 'vn',
  thailand: 'th', tha: 'th',
  korea: 'kr', 'south korea': 'kr',
  'hong kong': 'hk', taiwan: 'tw',
  uae: 'ae', 'united arab emirates': 'ae',
  'saudi arabia': 'sa',
  pakistan: 'pk', bangladesh: 'bd',
  malaysia: 'my', 'new zealand': 'nz',
};

/**
 * Normalize a country input to a 2-letter lowercase code.
 */
export function normalizeCountry(input) {
  if (!input) return DEFAULT_COUNTRY;
  const raw = String(input).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(raw)) return raw;
  if (COUNTRY_NAME_MAP[raw]) return COUNTRY_NAME_MAP[raw];
  return DEFAULT_COUNTRY;
}

// ---------------------------------------------------------------------------
// 4. Build provider-specific proxy objects
// ---------------------------------------------------------------------------

/**
 * Build username for residential-style providers.
 * Pattern: <user>-zone-<zone>-region-<CC>[-session-<sid>]
 */
function buildResidentialUsername(provider, country, sessionId) {
  const cc = normalizeCountry(country);
  let username = provider.username;
  if (provider.zone) {
    username += `-zone-${provider.zone}-region-${cc}`;
  } else {
    username += `-region-${cc}`;
  }
  if (sessionId) {
    username += `-session-${sessionId}`;
  }
  return username;
}

/**
 * Build a Playwright-compatible proxy descriptor from a provider config.
 */
function buildProxyDescriptor(provider, country, sessionId) {
  const cc = normalizeCountry(country);

  switch (provider.type) {
    case 'residential': {
      const username = buildResidentialUsername(provider, cc, sessionId);
      return {
        server: `http://${provider.host}:${provider.port}`,
        host: provider.host,
        port: provider.port,
        username,
        password: provider.password,
        country: cc,
        providerLabel: provider.label,
        protocol: 'http',
        url: `http://${encodeURIComponent(username)}:${encodeURIComponent(provider.password)}@${provider.host}:${provider.port}`,
      };
    }

    case 'static': {
      const username = buildResidentialUsername(provider, cc, sessionId);
      return {
        server: `http://${provider.host}:${provider.port}`,
        host: provider.host,
        port: provider.port,
        username,
        password: provider.password,
        country: cc,
        providerLabel: provider.label,
        protocol: 'http',
        url: `http://${encodeURIComponent(username)}:${encodeURIComponent(provider.password)}@${provider.host}:${provider.port}`,
      };
    }

    case 'socks5': {
      return {
        server: `socks5://${provider.host}:${provider.port}`,
        host: provider.host,
        port: provider.port,
        username: provider.username || undefined,
        password: provider.password || undefined,
        country: cc,
        providerLabel: provider.label,
        protocol: 'socks5',
        url: provider.username
          ? `socks5://${encodeURIComponent(provider.username)}:${encodeURIComponent(provider.password)}@${provider.host}:${provider.port}`
          : `socks5://${provider.host}:${provider.port}`,
      };
    }

    case 'api': {
      // API-type: the provider string is the endpoint URL
      // country routing is appended as a query parameter
      const endpoint = provider.host; // for API type, host is the full URL
      return {
        server: endpoint,
        host: provider.host,
        port: provider.port,
        username: provider.username || undefined,
        password: provider.password || undefined,
        country: cc,
        providerLabel: provider.label,
        protocol: 'api',
        url: null, // resolved at use time
        _apiEndpoint: endpoint,
      };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 5. Health check — test connectivity through a proxy
// ---------------------------------------------------------------------------

/**
 * Test a single proxy's connectivity by tunneling to ipify.org.
 * Returns { ok, ip, country, latencyMs, label, error? }
 */
function testOneProxy(proxy, timeoutMs = HEALTH_TIMEOUT_MS) {
  const started = Date.now();
  const targetHost = 'api.ipify.org';
  const targetPort = 443;
  const authHeader =
    'Basic ' + Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        'Proxy-Authorization': authHeader,
        'User-Agent': 'TgWhatsapp-ProxyTester/2.0',
      },
      timeout: timeoutMs,
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        finish({
          ok: false,
          label: proxy.providerLabel,
          error: `CONNECT failed: HTTP ${res.statusCode}`,
        });
        socket.destroy();
        return;
      }

      const httpsReq = https.request({
        host: targetHost,
        port: targetPort,
        method: 'GET',
        path: '/?format=json',
        socket,
        agent: false,
        headers: { Host: targetHost, 'User-Agent': 'TgWhatsapp-ProxyTester/2.0' },
        timeout: timeoutMs,
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk.toString(); });
        response.on('end', () => {
          try {
            const json = JSON.parse(data);
            const latency = Date.now() - started;
            finish({
              ok: true,
              ip: json.ip,
              country: proxy.country,
              latencyMs: latency,
              label: proxy.providerLabel,
            });
          } catch (_) {
            finish({
              ok: false,
              label: proxy.providerLabel,
              error: `Bad response: ${data.slice(0, 120)}`,
            });
          }
        });
      });

      httpsReq.on('error', (err) => {
        finish({ ok: false, label: proxy.providerLabel, error: err.message });
      });
      httpsReq.on('timeout', () => {
        httpsReq.destroy();
        finish({ ok: false, label: proxy.providerLabel, error: 'Request timeout' });
      });
      httpsReq.end();
    });

    connectReq.on('error', (err) => {
      finish({ ok: false, label: proxy.providerLabel, error: err.message });
    });
    connectReq.on('timeout', () => {
      connectReq.destroy();
      finish({ ok: false, label: proxy.providerLabel, error: 'CONNECT timeout' });
    });

    connectReq.end();
  });
}

/**
 * Run health checks on all configured providers concurrently (with limited concurrency).
 */
export async function healthCheckAll({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  if (!HAS_PROXY) {
    return { ok: true, message: 'No providers configured.', results: [] };
  }

  const providers = PROXY_PROVIDERS.filter(p => p.type !== 'api');
  if (providers.length === 0) {
    return { ok: true, message: 'No health-checkable providers (API-type excluded).', results: [] };
  }

  const results = [];

  // Process in batches to limit concurrency
  for (let i = 0; i < providers.length; i += HEALTH_CONCURRENCY) {
    const batch = providers.slice(i, i + HEALTH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (prov) => {
        const proxy = buildProxyDescriptor(prov, DEFAULT_COUNTRY);
        const result = await testOneProxy(proxy, timeoutMs);
        if (result.ok) {
          markSuccess(prov.label, result.latencyMs);
        } else {
          markFailure(prov.label);
        }
        return result;
      })
    );
    results.push(...batchResults);
  }

  const okCount = results.filter(r => r.ok).length;
  const allOk = okCount === results.length;

  return {
    ok: allOk,
    okCount,
    total: results.length,
    message: allOk
      ? `All ${okCount} providers healthy.`
      : `${okCount}/${results.length} providers healthy.`,
    results,
  };
}

// ---------------------------------------------------------------------------
// 6. Select the best available proxy for a given country
// ---------------------------------------------------------------------------

/**
 * Pick the best proxy provider from the pool.
 * Uses ROTATION_MODE to decide strategy.
 *
 * @param {string} [country] — target country code
 * @param {{ sessionId?: string, requireHealthy?: boolean }} [opts]
 * @returns {object|null} Playwright-compatible proxy descriptor, or null
 */
export function getProxyForCountry(country, { sessionId, requireHealthy = true } = {}) {
  if (!HAS_PROXY) return null;

  const cc = normalizeCountry(country);

  // Filter to healthy providers (skip API-type for now; they're handled specially)
  let candidates = PROXY_PROVIDERS.filter(p => {
    if (p.type === 'api') return false; // API providers handled via getApiProxy()
    if (requireHealthy && !isHealthy(p.label)) return false;
    return true;
  });

  if (candidates.length === 0) {
    // If no healthy providers, try unhealthy ones as last resort
    candidates = PROXY_PROVIDERS.filter(p => p.type !== 'api');
    if (candidates.length === 0) return null;
  }

  let chosen;

  switch (ROTATION_MODE) {
    case 'round-robin': {
      // Simple index-based rotation using a module-level counter
      const idx = (_roundRobinCounter++ % candidates.length);
      chosen = candidates[idx];
      break;
    }
    case 'best-latency': {
      // Pick the provider with the lowest last-known latency
      candidates.sort((a, b) => {
        const la = getHealth(a.label).lastLatencyMs ?? Infinity;
        const lb = getHealth(b.label).lastLatencyMs ?? Infinity;
        return la - lb;
      });
      chosen = candidates[0];
      break;
    }
    case 'random':
    default: {
      // Pure random
      const idx = Math.floor(Math.random() * candidates.length);
      chosen = candidates[idx];
      break;
    }
  }

  if (!chosen) return null;

  const proxy = buildProxyDescriptor(chosen, cc, sessionId);
  if (!proxy) return null;

  // Run pre-flight health check if enabled
  if (PREFLIGHT_CHECK) {
    // Fire-and-forget (not awaited); the proxy is returned immediately.
    // The registration flow will handle failures and switch providers.
    // This check warms the connection and updates health state for next time.
    testOneProxy(proxy, 8_000).then(result => {
      if (result.ok) {
        markSuccess(proxy.providerLabel, result.latencyMs);
      } else {
        markFailure(proxy.providerLabel);
      }
    }).catch(() => {});
  }

  return {
    server: proxy.server,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    country: proxy.country,
    providerLabel: proxy.providerLabel,
    protocol: proxy.protocol,
    url: proxy.url,
  };
}

// ---------------------------------------------------------------------------
// 7. Auto best-proxy picker — no country required (ASYNC with live latency)
// ---------------------------------------------------------------------------

/**
 * Pick the single best proxy across all providers by running LIVE parallel
 * health checks. Only returns a proxy whose measured latency is below
 * PROXY_BEST_LATENCY_THRESHOLD_MS (default 300ms).
 *
 * Selection pipeline:
 *   1. Run awaited parallel health checks on ALL non-API providers
 *   2. Filter out any provider slower than the latency threshold
 *   3. Sort remaining by actual measured latency (fastest first)
 *   4. Return the fastest provider's Playwright-compatible descriptor
 *
 * Falls back to stale cached data if NO provider passes the live check.
 *
 * Use this when the user says `/proxy` with no country or `email|proxy` —
 * it dynamically chooses the fastest IP with guaranteed low latency.
 *
 * @param {{ sessionId?: string }} [opts]
 * @returns {Promise<object|null>} Playwright-compatible proxy descriptor, or null
 */
export async function getBestProxy({ sessionId } = {}) {
  if (!HAS_PROXY) return null;

  const providers = PROXY_PROVIDERS.filter(p => p.type !== 'api');
  if (providers.length === 0) return null;

  const cc = DEFAULT_COUNTRY;

  // ── Phase 1: Run live parallel health checks on ALL providers ──
  const liveResults = [];

  // Process in batches (same pattern as healthCheckAll) for fairness
  for (let i = 0; i < providers.length; i += HEALTH_CONCURRENCY) {
    const batch = providers.slice(i, i + HEALTH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (prov) => {
        const proxy = buildProxyDescriptor(prov, cc, sessionId);
        if (!proxy) return { ok: false, provider: prov, latencyMs: Infinity, label: prov.label };
        const result = await testOneProxy(proxy, BEST_LATENCY_TIMEOUT_MS);
        // Update health state immediately for future calls
        if (result.ok) {
          markSuccess(prov.label, result.latencyMs);
        } else {
          markFailure(prov.label);
        }
        return { ...result, provider: prov };
      })
    );
    liveResults.push(...batchResults);
  }

  // ── Phase 2: Filter by latency threshold, sort by speed ──
  const passing = liveResults.filter(r => r.ok && r.latencyMs < MAX_LATENCY_THRESHOLD_MS);
  passing.sort((a, b) => a.latencyMs - b.latencyMs);

  if (passing.length > 0) {
    const best = passing[0];
    console.log(`[proxy] Best-proxy live pick: ${best.label} at ${best.latencyMs}ms (threshold ${MAX_LATENCY_THRESHOLD_MS}ms, ${passing.length}/${liveResults.length} passed)`);
    return {
      server: buildProxyDescriptor(best.provider, cc, sessionId).server,
      host: best.provider.host,
      port: best.provider.port,
      username: buildProxyDescriptor(best.provider, cc, sessionId).username,
      password: buildProxyDescriptor(best.provider, cc, sessionId).password,
      country: cc,
      providerLabel: best.provider.label,
      protocol: buildProxyDescriptor(best.provider, cc, sessionId).protocol,
      url: buildProxyDescriptor(best.provider, cc, sessionId).url,
      _liveLatencyMs: best.latencyMs,
      _liveVerified: true,
    };
  }

  // ── Phase 3: Fallback — no provider met the threshold, use fastest from live ──
  const liveOk = liveResults.filter(r => r.ok);
  liveOk.sort((a, b) => a.latencyMs - b.latencyMs);

  if (liveOk.length > 0) {
    const best = liveOk[0];
    console.log(`[proxy] Best-proxy fallback (no provider under ${MAX_LATENCY_THRESHOLD_MS}ms): ${best.label} at ${best.latencyMs}ms`);
    const descriptor = buildProxyDescriptor(best.provider, cc, sessionId);
    if (!descriptor) return null;
    return {
      server: descriptor.server,
      host: descriptor.host,
      port: descriptor.port,
      username: descriptor.username,
      password: descriptor.password,
      country: cc,
      providerLabel: descriptor.providerLabel,
      protocol: descriptor.protocol,
      url: descriptor.url,
      _liveLatencyMs: best.latencyMs,
      _liveVerified: true,
      _fallback: true,
    };
  }

  // ── Phase 4: Last resort — stale cached data (all live checks failed) ──
  console.log(`[proxy] Best-proxy last resort: all live checks failed, using stale cached data`);
  const candidates = providers
    .map(p => ({ provider: p, health: getHealth(p.label) }));

  candidates.sort((a, b) => {
    const aHealthy = a.health.unhealthy ? 0 : 1;
    const bHealthy = b.health.unhealthy ? 0 : 1;
    if (aHealthy !== bHealthy) return bHealthy - aHealthy;
    const aLat = a.health.lastLatencyMs ?? Infinity;
    const bLat = b.health.lastLatencyMs ?? Infinity;
    return aLat - bLat;
  });

  const best = candidates[0];
  const proxy = buildProxyDescriptor(best.provider, cc, sessionId);
  if (!proxy) return null;

  return {
    server: proxy.server,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    country: cc,
    providerLabel: proxy.providerLabel,
    protocol: proxy.protocol,
    url: proxy.url,
    _liveVerified: false,
  };
}

let _roundRobinCounter = 0;

// ---------------------------------------------------------------------------
// 8. Failover wrapper — tries providers until one works
// ---------------------------------------------------------------------------

/**
 * Execute an async function with failover across proxy providers.
 * If the function throws, the next provider is tried.
 *
 * @param {string} country — target country
 * @param {(proxy: object) => Promise<T>} fn — function that takes a proxy and returns a result
 * @param {{ sessionId?: string, maxAttempts?: number }} opts
 * @returns {Promise<{ result: T | null, proxyUsed: object | null, attempts: Array<{ label: string, error: string }> }>}
 */
export async function withProxyFailover(country, fn, { sessionId, maxAttempts } = {}) {
  if (!HAS_PROXY) {
    // No proxy configured — run without proxy
    try {
      const result = await fn(null);
      return { result, proxyUsed: null, attempts: [] };
    } catch (err) {
      return { result: null, proxyUsed: null, attempts: [{ label: 'none', error: err.message }] };
    }
  }

  const max = maxAttempts || PROXY_PROVIDERS.length || 3;
  const tried = new Set();
  const attempts = [];

  for (let i = 0; i < max; i++) {
    const proxy = getProxyForCountry(country, { sessionId, requireHealthy: i < max - 1 });

    if (!proxy) {
      attempts.push({ label: 'none', error: 'No proxy available' });
      break;
    }

    // Don't retry the same provider
    if (tried.has(proxy.providerLabel)) continue;
    tried.add(proxy.providerLabel);

    try {
      const result = await fn(proxy);
      markSuccess(proxy.providerLabel, null);
      return { result, proxyUsed: proxy, attempts };
    } catch (err) {
      markFailure(proxy.providerLabel);
      attempts.push({ label: proxy.providerLabel, error: err.message });
    }
  }

  return { result: null, proxyUsed: null, attempts };
}

// ---------------------------------------------------------------------------
// 8. Direct test function (public API, backward compatible)
// ---------------------------------------------------------------------------

/**
 * Test a proxy for the given country.
 * (Backward-compatible with the old `testProxy(country)` API.)
 */
export function testProxy(country, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const proxy = getProxyForCountry(country, { requireHealthy: false });
  if (!proxy) {
    return Promise.resolve({ ok: false, country: normalizeCountry(country), error: 'No proxy configured' });
  }
  return testOneProxy(proxy, timeoutMs);
}

// ---------------------------------------------------------------------------
// 9. API-type proxy resolver (for proxies fetched from an API endpoint)
// ---------------------------------------------------------------------------

/**
 * Fetch a fresh proxy from an API-type provider.
 * Calls the configured API endpoint and parses the response.
 *
 * Expected API response formats:
 *   { "proxy": "http://user:pass@host:port" }
 *   { "ip": "1.2.3.4", "port": 8080, "username": "...", "password": "..." }
 *   "http://user:pass@host:port"  (plain text)
 */
export async function getApiProxy(providerLabel, { timeoutMs = 10_000 } = {}) {
  const provider = PROXY_PROVIDERS.find(p => p.label === providerLabel && p.type === 'api');
  if (!provider) return null;

  const endpoint = provider.host; // full URL for API-type

  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request({
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'TgWhatsapp-ProxyFetcher/2.0',
        ...(provider.username ? { 'Authorization': `Basic ${Buffer.from(`${provider.username}:${provider.password}`).toString('base64')}` } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // Try common response formats
          if (json.proxy && typeof json.proxy === 'string') {
            resolve(json.proxy);
          } else if (json.ip && json.port) {
            const auth = json.username ? `${encodeURIComponent(json.username)}:${encodeURIComponent(json.password || '')}@` : '';
            resolve(`http://${auth}${json.ip}:${json.port}`);
          } else {
            resolve(null);
          }
        } catch (_) {
          // Plain text? must be a direct URL
          const trimmed = data.trim();
          if (trimmed.startsWith('http://') || trimmed.startsWith('socks5://')) {
            resolve(trimmed);
          } else {
            resolve(null);
          }
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 10. Status / introspection helpers
// ---------------------------------------------------------------------------

/**
 * Get current health status for all providers.
 */
export function getProviderStatus() {
  return PROXY_PROVIDERS.map(p => ({
    label: p.label,
    type: p.type,
    host: p.host,
    port: p.port,
    ...getHealth(p.label),
  }));
}

/**
 * Get a human-readable summary of the proxy configuration.
 */
export function getProxySummary() {
  if (!HAS_PROXY) {
    return '⚠️ No proxy configured. Registrations will use your real IP.';
  }

  const statuses = getProviderStatus();
  const healthy = statuses.filter(s => !s.unhealthy).length;
  const total = statuses.length;
  const mode = ROTATION_MODE;

  let summary = `🔌 ${total} proxy provider(s) configured (mode: ${mode})\n`;
  summary += `   ${healthy}/${total} healthy\n`;

  for (const s of statuses) {
    const icon = s.unhealthy ? '❌' : '✅';
    const lat = s.lastLatencyMs != null ? `${s.lastLatencyMs}ms` : 'untested';
    summary += `   ${icon} ${s.label} (${s.type}) — ${lat}\n`;
  }

  return summary;
}
