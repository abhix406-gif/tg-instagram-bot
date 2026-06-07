// =============================================================================
//  PROXY MODULE v3.0 — Dual HTTP/SOCKS5 · Worldwide Best-Proxy · Health Monitor
// =============================================================================
//  Supports:
//    • HTTP  residential/static proxies (Bright Data, Oxylabs, etc.)
//    • SOCKS5 proxies (OwlProxy, etc.)
//    • Worldwide auto-selection from 196 countries (no default country)
//    • Periodic health checks with Telegram alerts
//    • Instagram-safe IP preference (residential > datacenter)
// =============================================================================

import 'dotenv/config';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { URL } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION (all from environment)
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_TIMEOUT_MS = Number(process.env.PROXY_HEALTH_TIMEOUT_MS || 8_000);
const HEALTH_CONCURRENCY = Number(process.env.PROXY_HEALTH_CONCURRENCY || 5);
const ROTATION_MODE = process.env.PROXY_ROTATION_MODE || 'best-latency';
const PREFLIGHT_CHECK = process.env.PROXY_PREFLIGHT_CHECK !== 'false';
const MAX_CONSECUTIVE_FAILURES = Number(process.env.PROXY_MAX_FAILURES || 3);
const MAX_LATENCY_THRESHOLD_MS = Number(process.env.PROXY_BEST_LATENCY_THRESHOLD_MS || 300);
const BEST_LATENCY_TIMEOUT_MS = Number(process.env.PROXY_BEST_LATENCY_TIMEOUT_MS || 10_000);
const MONITOR_INTERVAL_MIN = Number(process.env.PROXY_MONITOR_INTERVAL_MIN || 5);
const MONITOR_ALERT_CHAT_ID = process.env.PROXY_MONITOR_ALERT_CHAT_ID || '';

// ─────────────────────────────────────────────────────────────────────────────
// 2. ALL 196 ISO-3166-1 ALPHA-2 COUNTRY CODES (for worldwide selection)
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_COUNTRIES = [
  'ad','ae','af','ag','ai','al','am','ao','aq','ar','as','at','au','aw','ax','az',
  'ba','bb','bd','be','bf','bg','bh','bi','bj','bl','bm','bn','bo','bq','br','bs','bt','bv','bw','by','bz',
  'ca','cc','cd','cf','cg','ch','ci','ck','cl','cm','cn','co','cr','cu','cv','cw','cx','cy','cz',
  'de','dj','dk','dm','do','dz',
  'ec','ee','eg','eh','er','es','et',
  'fi','fj','fk','fm','fo','fr',
  'ga','gb','gd','ge','gf','gg','gh','gi','gl','gm','gn','gp','gq','gr','gs','gt','gu','gw','gy',
  'hk','hm','hn','hr','ht','hu',
  'id','ie','il','im','in','io','iq','ir','is','it',
  'je','jm','jo','jp',
  'ke','kg','kh','ki','km','kn','kp','kr','kw','ky','kz',
  'la','lb','lc','li','lk','lr','ls','lt','lu','lv','ly',
  'ma','mc','md','me','mf','mg','mh','mk','ml','mm','mn','mo','mp','mq','mr','ms','mt','mu','mv','mw','mx','my','mz',
  'na','nc','ne','nf','ng','ni','nl','no','np','nr','nu','nz',
  'om',
  'pa','pe','pf','pg','ph','pk','pl','pm','pn','pr','ps','pt','pw','py',
  'qa',
  're','ro','rs','ru','rw',
  'sa','sb','sc','sd','se','sg','sh','si','sj','sk','sl','sm','sn','so','sr','ss','st','sv','sx','sy','sz',
  'tc','td','tf','tg','th','tj','tk','tl','tm','tn','to','tr','tt','tv','tw','tz',
  'ua','ug','um','us','uy','uz',
  'va','vc','ve','vg','vi','vn','vu',
  'wf','ws',
  'ye','yt',
  'za','zm','zw',
];

// Priority subset: major internet hubs tested first for fast results
const PRIORITY_COUNTRIES = [
  'us','gb','de','jp','sg','in','fr','ca','au','br','nl','hk','kr','se','ch','it','es','pl','fi','no',
  'dk','be','at','ie','pt','nz','za','ae','mx','ar','cl','co','th','vn','my','ph','id','tw','ru','tr',
  'ua','cz','ro','hu','gr','il','sa','eg','ng','ke','pk','bd','lk','np','kh','mm','mn','kz','uz',
  'ma','tn','gh','ci','sn','ug','tz','mu','rw','bw','na','zm','zw','mw','ao','mz','mg','sc','mu',
  'is','mt','cy','ge','am','az','md','by','ee','lv','lt','si','hr','ba','rs','mk','al','bg','sk',
  'lu','mc','ad','li','sm','va','mt','je','gg','im','fo','gl','aw','cw','sx','bq','bl','mf','pm',
  'bm','ky','vg','tc','ai','ms','dm','lc','vc','gd','bb','ag','kn','bs','cu','jm','ht','do','pr',
  'tt','gy','sr','gf','mq','gp','re','yt','nc','pf','fj','pg','sb','vu','ws','to','ck','nu','tv',
  'nr','ki','mh','fm','pw','mp','gu','as','tl','bn','mv','bt','la','mo','kp','mm','af','iq','ye',
  'sy','jo','lb','ps','qa','bh','kw','om','ye','ly','dz','mr','ml','ne','td','sd','et','so','dj',
  'er','cf','cm','ga','cg','cd','ao','na','bw','ls','sz','mg','km','bi','rw','ug','ss','gm','gw',
  'sl','lr','bf','bj','tg','gh','ci','gn','sn','gm','cv','st','gq','ga','cg','td','cf','cm','ng',
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. PROVIDER PARSING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse PROXY_PROVIDERS env var.
 * Format: TYPE|host:port|username|password|zone|label
 * Multiple providers separated by ; or newline.
 *
 * Supported TYPEs: http, socks5
 */
function parseProviderList() {
  const raw = process.env.PROXY_PROVIDERS || '';
  if (!raw.trim()) {
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
    const port = Number(portStr || (type === 'socks5' ? 1080 : 80));

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

function parseLegacyProvider() {
  const host = process.env.PROXY_HOST;
  const port = Number(process.env.PROXY_PORT || 0);
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  const zone = process.env.PROXY_ZONE;

  if (!host || !port || !user || !pass) return null;

  return {
    type: 'http',
    host,
    port,
    username: user,
    password: pass,
    zone: zone || undefined,
    label: 'legacy',
  };
}

// ── Lazy-initialized providers (parsed on first access so dotenv is loaded) ──
let _providers = null;

function getProviders() {
  if (_providers === null) {
    _providers = parseProviderList();
    console.log(`[proxy] Loaded ${_providers.length} provider(s) from PROXY_PROVIDERS env`);
  }
  return _providers;
}

// Proxy-wrapped array: delegates all property access to getProviders() result
export const PROXY_PROVIDERS = new Proxy([], {
  get(_, prop) {
    const arr = getProviders();
    const val = arr[prop];
    return typeof val === 'function' ? val.bind(arr) : val;
  },
  ownKeys(_)   { return Reflect.ownKeys(getProviders()); },
  getOwnPropertyDescriptor(_, prop) { return Reflect.getOwnPropertyDescriptor(getProviders(), prop); },
  has(_, prop) { return prop in getProviders(); },
  set(_, prop, value) { getProviders()[prop] = value; return true; },
});

// Lazy boolean: truthy when providers exist
export const HAS_PROXY = {
  [Symbol.toPrimitive]() { return getProviders().length; },
  toString() { return String(getProviders().length); },
  valueOf() { return getProviders().length; },
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. HEALTH TRACKING
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, { consecutiveFailures: number, lastLatencyMs: number | null, unhealthy: boolean, lastChecked: number, lastError: string | null, lastCountry: string | null, lastIp: string | null }>} */
const healthMap = new Map();

function getHealth(label) {
  if (!healthMap.has(label)) {
    healthMap.set(label, {
      consecutiveFailures: 0,
      lastLatencyMs: null,
      unhealthy: false,
      lastChecked: 0,
      lastError: null,
      lastCountry: null,
      lastIp: null,
    });
  }
  return healthMap.get(label);
}

function markSuccess(label, latencyMs, country, ip) {
  const h = getHealth(label);
  h.consecutiveFailures = 0;
  h.lastLatencyMs = latencyMs;
  h.unhealthy = false;
  h.lastChecked = Date.now();
  h.lastError = null;
  if (country) h.lastCountry = country;
  if (ip) h.lastIp = ip;
}

function markFailure(label, error) {
  const h = getHealth(label);
  h.consecutiveFailures++;
  h.lastChecked = Date.now();
  h.lastError = error || null;
  if (h.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    h.unhealthy = true;
  }
}

function isHealthy(label) {
  return !getHealth(label).unhealthy;
}

export function resetProviderHealth(label) {
  const h = getHealth(label);
  h.unhealthy = false;
  h.consecutiveFailures = 0;
  h.lastError = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. COUNTRY NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

const COUNTRY_NAME_MAP = {
  'united states': 'us', usa: 'us', america: 'us',
  'united kingdom': 'uk', britain: 'gb', england: 'gb',
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
  'south korea': 'kr', korea: 'kr',
  'hong kong': 'hk', taiwan: 'tw',
  uae: 'ae', 'united arab emirates': 'ae',
  'saudi arabia': 'sa',
  pakistan: 'pk', bangladesh: 'bd',
  malaysia: 'my', 'new zealand': 'nz',
  argentina: 'ar', chile: 'cl', colombia: 'co',
  nigeria: 'ng', egypt: 'eg', 'south africa': 'za',
  poland: 'pl', sweden: 'se', norway: 'no', finland: 'fi', denmark: 'dk',
  switzerland: 'ch', austria: 'at', belgium: 'be', ireland: 'ie', portugal: 'pt',
  greece: 'gr', 'czech republic': 'cz', romania: 'ro', hungary: 'hu',
  ukraine: 'ua', israel: 'il',
};

export function normalizeCountry(input) {
  if (!input) return null; // null = worldwide/dynamic
  const raw = String(input).trim().toLowerCase();
  if (raw === 'worldwide' || raw === 'auto' || raw === 'any' || raw === 'dynamic') return null;
  if (/^[a-z]{2}$/.test(raw)) return raw;
  if (COUNTRY_NAME_MAP[raw]) return COUNTRY_NAME_MAP[raw];
  return null; // unknown → worldwide
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. BUILD PROXY DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace country code in OwlProxy-style username.
 * Pattern: ...-country-XX-...
 */
function replaceCountryInUsername(username, country) {
  if (!username || !country) return username;
  return username.replace(/country-[A-Za-z]{2}/, `country-${country.toUpperCase()}`);
}

/**
 * Build username for HTTP residential proxies.
 * Pattern: <user>-zone-<zone>-region-<CC>[-session-<sid>]
 */
function buildResidentialUsername(provider, country, sessionId) {
  let username = provider.username;
  if (provider.zone) {
    username += `-zone-${provider.zone}-region-${country}`;
  } else if (country) {
    username += `-region-${country}`;
  }
  if (sessionId) {
    username += `-session-${sessionId}`;
  }
  return username;
}

/**
 * Build a Playwright-compatible proxy descriptor.
 */
function buildProxyDescriptor(provider, country, sessionId) {
  const cc = country || null;

  switch (provider.type) {
    case 'http':
    case 'residential':
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
      const countryUsername = provider.username
        ? replaceCountryInUsername(provider.username, cc)
        : undefined;
      return {
        server: `socks5://${provider.host}:${provider.port}`,
        host: provider.host,
        port: provider.port,
        username: countryUsername || undefined,
        password: provider.password || undefined,
        country: cc,
        providerLabel: provider.label,
        protocol: 'socks5',
        url: countryUsername
          ? `socks5://${encodeURIComponent(countryUsername)}:${encodeURIComponent(provider.password)}@${provider.host}:${provider.port}`
          : `socks5://${provider.host}:${provider.port}`,
      };
    }

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. HEALTH CHECK — HTTP PROXY (CONNECT tunnel)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test an HTTP proxy by tunneling to ipify.org via CONNECT.
 * Returns { ok, ip, country, latencyMs, label, error? }
 */
function testHttpProxy(proxy, timeoutMs = HEALTH_TIMEOUT_MS) {
  const started = Date.now();
  const targetHost = 'api.ipify.org';
  const targetPort = 443;

  const authHeader = 'Basic ' +
    Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64');

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
        'User-Agent': 'TgInsta-ProxyTester/3.0',
      },
      timeout: timeoutMs,
      insecureHTTPParser: true,
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        finish({
          ok: false,
          label: proxy.providerLabel,
          error: `HTTP ${res.statusCode} — ${res.statusMessage || 'CONNECT rejected'}`,
        });
        socket.destroy();
        return;
      }
      tunnelHttpsOverSocket(socket, targetHost, targetPort, timeoutMs, started, proxy, finish);
    });

    connectReq.on('error', (err) => {
      finish({ ok: false, label: proxy.providerLabel, error: `TCP: ${err.message}` });
    });
    connectReq.on('timeout', () => {
      connectReq.destroy();
      finish({ ok: false, label: proxy.providerLabel, error: 'CONNECT timeout' });
    });

    connectReq.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. HEALTH CHECK — SOCKS5 PROXY (RFC 1928 handshake)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test a SOCKS5 proxy via RFC 1928/1929 handshake + tunnel.
 * Returns { ok, ip, country, latencyMs, label, error? }
 */
function testSocks5Proxy(proxy, timeoutMs = HEALTH_TIMEOUT_MS) {
  const started = Date.now();
  const targetHost = 'api.ipify.org';
  const targetPort = 443;

  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch (_) {}
      resolve(value);
    };

    socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.on('timeout', () => {
      finish({ ok: false, label: proxy.providerLabel, error: 'SOCKS5 handshake timeout' });
    });
    socket.on('error', (err) => {
      finish({ ok: false, label: proxy.providerLabel, error: `TCP: ${err.message}` });
    });

    socket.connect(proxy.port, proxy.host, () => {
      // Step 1: Greeting — SOCKS5, 1 auth method (0x02 = user/pass)
      socket.write(Buffer.from([0x05, 0x01, 0x02]));
    });

    let handshakeStep = 0;
    let handshakeBuf = Buffer.alloc(0);

    socket.on('data', (data) => {
      handshakeBuf = Buffer.concat([handshakeBuf, data]);

      if (handshakeStep === 0 && handshakeBuf.length >= 2) {
        if (handshakeBuf[0] !== 0x05 || handshakeBuf[1] !== 0x02) {
          return finish({
            ok: false, label: proxy.providerLabel,
            error: `SOCKS5 auth method rejected (0x${handshakeBuf[1]?.toString(16)})`,
          });
        }
        handshakeBuf = handshakeBuf.slice(2);
        handshakeStep = 1;

        // Step 2: Username/password auth
        const user = Buffer.from(proxy.username || '', 'utf8');
        const pass = Buffer.from(proxy.password || '', 'utf8');
        const authPkt = Buffer.alloc(3 + user.length + pass.length);
        authPkt[0] = 0x01;
        authPkt[1] = user.length;
        user.copy(authPkt, 2);
        authPkt[2 + user.length] = pass.length;
        pass.copy(authPkt, 3 + user.length);
        socket.write(authPkt);
      }

      if (handshakeStep === 1 && handshakeBuf.length >= 2) {
        if (handshakeBuf[0] !== 0x01 || handshakeBuf[1] !== 0x00) {
          return finish({
            ok: false, label: proxy.providerLabel,
            error: 'SOCKS5 auth failed — bad credentials',
          });
        }
        handshakeBuf = handshakeBuf.slice(2);
        handshakeStep = 2;

        // Step 3: CONNECT request
        const hostBuf = Buffer.from(targetHost, 'utf8');
        const connectPkt = Buffer.alloc(7 + hostBuf.length);
        connectPkt[0] = 0x05;
        connectPkt[1] = 0x01;
        connectPkt[2] = 0x00;
        connectPkt[3] = 0x03;
        connectPkt[4] = hostBuf.length;
        hostBuf.copy(connectPkt, 5);
        connectPkt[5 + hostBuf.length] = (targetPort >> 8) & 0xff;
        connectPkt[6 + hostBuf.length] = targetPort & 0xff;
        socket.write(connectPkt);
      }

      if (handshakeStep === 2 && handshakeBuf.length >= 10) {
        if (handshakeBuf[0] !== 0x05 || handshakeBuf[1] !== 0x00) {
          const errCodes = [
            'succeeded', 'general failure', 'connection not allowed',
            'network unreachable', 'host unreachable', 'connection refused',
            'TTL expired', 'command not supported', 'address type not supported',
          ];
          const errMsg = errCodes[handshakeBuf[1]] || `code 0x${handshakeBuf[1]?.toString(16)}`;
          return finish({
            ok: false, label: proxy.providerLabel,
            error: `SOCKS5 CONNECT: ${errMsg}`,
          });
        }
        socket.removeAllListeners('data');
        tunnelHttpsOverSocket(socket, targetHost, targetPort, timeoutMs, started, proxy, finish);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. SHARED — Tunnel HTTPS over established socket
// ─────────────────────────────────────────────────────────────────────────────

function tunnelHttpsOverSocket(socket, targetHost, targetPort, timeoutMs, started, proxy, finish) {
  const httpsReq = https.request({
    host: targetHost,
    port: targetPort,
    method: 'GET',
    path: '/?format=json',
    socket,
    agent: false,
    headers: { Host: targetHost, 'User-Agent': 'TgInsta-ProxyTester/3.0' },
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
    finish({ ok: false, label: proxy.providerLabel, error: `TLS: ${err.message}` });
  });
  httpsReq.on('timeout', () => {
    httpsReq.destroy();
    finish({ ok: false, label: proxy.providerLabel, error: 'Request timeout' });
  });
  httpsReq.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. UNIFIED TEST — routes to HTTP or SOCKS5 based on proxy type
// ─────────────────────────────────────────────────────────────────────────────

function testOneProxy(proxy, timeoutMs = HEALTH_TIMEOUT_MS) {
  if (proxy.protocol === 'socks5') {
    return testSocks5Proxy(proxy, timeoutMs);
  }
  return testHttpProxy(proxy, timeoutMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. WORLDWIDE BEST-PROXY SELECTION (NO DEFAULT COUNTRY)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the absolute best proxy across ALL providers and ALL countries.
 *
 * Algorithm:
 *   1. Test priority countries first (fast path — major internet hubs)
 *   2. If no result under threshold, test remaining countries
 *   3. Sort by latency, pick fastest
 *   4. Return Playwright-compatible descriptor with full metadata
 *
 * NO default country — the script dynamically chooses the best one.
 *
 * @param {{ sessionId?: string, timeoutMs?: number, concurrency?: number }} [opts]
 * @returns {Promise<object|null>}
 */
export async function getWorldwideBestProxy({
  sessionId,
  timeoutMs = BEST_LATENCY_TIMEOUT_MS,
  concurrency = HEALTH_CONCURRENCY,
} = {}) {
  if (!HAS_PROXY) return null;

  const providers = PROXY_PROVIDERS.filter(p => p.type !== 'api');
  if (providers.length === 0) return null;

  // ── Phase 1: Test priority countries across all providers ──
  const allResults = [];
  const testCountries = [...PRIORITY_COUNTRIES];

  for (let i = 0; i < testCountries.length; i += concurrency) {
    const batch = testCountries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (cc) => {
        // Test each provider for this country
        const providerResults = await Promise.all(
          providers.map(async (prov) => {
            const proxy = buildProxyDescriptor(prov, cc, sessionId);
            if (!proxy) return { ok: false, provider: prov, country: cc, latencyMs: Infinity, label: prov.label };
            const result = await testOneProxy(proxy, timeoutMs);
            if (result.ok) {
              markSuccess(prov.label, result.latencyMs, cc, result.ip);
            } else {
              markFailure(prov.label, result.error);
            }
            return { ...result, provider: prov, country: cc };
          })
        );
        return providerResults;
      })
    );
    allResults.push(...batchResults.flat());

    // Early exit: if we have enough good results, stop testing
    const goodResults = allResults.filter(r => r.ok && r.latencyMs < MAX_LATENCY_THRESHOLD_MS);
    if (goodResults.length >= 3 && i >= 20) {
      // We have at least 3 good results after testing 20+ countries — good enough
      break;
    }
  }

  // ── Phase 2: Filter & sort ──
  const passing = allResults.filter(r => r.ok && r.latencyMs < MAX_LATENCY_THRESHOLD_MS);
  passing.sort((a, b) => a.latencyMs - b.latencyMs);

  if (passing.length > 0) {
    const best = passing[0];
    console.log(
      `[proxy] 🌍 Worldwide best: ${best.label} / ${best.country?.toUpperCase() || '?'} ` +
      `@ ${best.latencyMs}ms (${passing.length} under ${MAX_LATENCY_THRESHOLD_MS}ms threshold)`
    );
    const descriptor = buildProxyDescriptor(best.provider, best.country, sessionId);
    if (!descriptor) return null;
    return {
      server: descriptor.server,
      host: descriptor.host,
      port: descriptor.port,
      username: descriptor.username,
      password: descriptor.password,
      country: best.country,
      providerLabel: descriptor.providerLabel,
      protocol: descriptor.protocol,
      url: descriptor.url,
      _liveLatencyMs: best.latencyMs,
      _liveIp: best.ip,
      _liveVerified: true,
    };
  }

  // ── Phase 3: Fallback — use fastest from all live results ──
  const liveOk = allResults.filter(r => r.ok);
  liveOk.sort((a, b) => a.latencyMs - b.latencyMs);

  if (liveOk.length > 0) {
    const best = liveOk[0];
    console.log(
      `[proxy] ⚠️ Fallback (no proxy under ${MAX_LATENCY_THRESHOLD_MS}ms): ` +
      `${best.label} / ${best.country?.toUpperCase() || '?'} @ ${best.latencyMs}ms`
    );
    const descriptor = buildProxyDescriptor(best.provider, best.country, sessionId);
    if (!descriptor) return null;
    return {
      server: descriptor.server,
      host: descriptor.host,
      port: descriptor.port,
      username: descriptor.username,
      password: descriptor.password,
      country: best.country,
      providerLabel: descriptor.providerLabel,
      protocol: descriptor.protocol,
      url: descriptor.url,
      _liveLatencyMs: best.latencyMs,
      _liveIp: best.ip,
      _liveVerified: true,
      _fallback: true,
    };
  }

  // ── Phase 4: Last resort — stale cached data ──
  console.log('[proxy] ❌ All live checks failed — using stale cached data');
  const candidates = providers
    .map(p => ({ provider: p, health: getHealth(p.label) }))
    .sort((a, b) => {
      const aOk = a.health.unhealthy ? 0 : 1;
      const bOk = b.health.unhealthy ? 0 : 1;
      if (aOk !== bOk) return bOk - aOk;
      return (a.health.lastLatencyMs ?? Infinity) - (b.health.lastLatencyMs ?? Infinity);
    });

  const best = candidates[0];
  const bestCountry = best.health.lastCountry || 'us';
  const proxy = buildProxyDescriptor(best.provider, bestCountry, sessionId);
  if (!proxy) return null;

  return {
    server: proxy.server,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    country: bestCountry,
    providerLabel: proxy.providerLabel,
    protocol: proxy.protocol,
    url: proxy.url,
    _liveVerified: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. BACKWARD-COMPATIBLE: getBestProxy (now delegates to worldwide)
// ─────────────────────────────────────────────────────────────────────────────

export async function getBestProxy(opts = {}) {
  return getWorldwideBestProxy(opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. BACKWARD-COMPATIBLE: getProxyForCountry
// ─────────────────────────────────────────────────────────────────────────────

let _roundRobinCounter = 0;

export async function getProxyForCountry(country, { sessionId, requireHealthy = true } = {}) {
  if (!HAS_PROXY) return null;

  // If no country specified, use worldwide best
  const cc = normalizeCountry(country);
  if (!cc) return getWorldwideBestProxy({ sessionId });

  let candidates = PROXY_PROVIDERS.filter(p => {
    if (p.type === 'api') return false;
    if (requireHealthy && !isHealthy(p.label)) return false;
    return true;
  });

  if (candidates.length === 0) {
    candidates = PROXY_PROVIDERS.filter(p => p.type !== 'api');
    if (candidates.length === 0) return null;
  }

  let chosen;
  switch (ROTATION_MODE) {
    case 'round-robin':
      chosen = candidates[_roundRobinCounter++ % candidates.length];
      break;
    case 'best-latency':
      candidates.sort((a, b) => {
        const la = getHealth(a.label).lastLatencyMs ?? Infinity;
        const lb = getHealth(b.label).lastLatencyMs ?? Infinity;
        return la - lb;
      });
      chosen = candidates[0];
      break;
    default:
      chosen = candidates[Math.floor(Math.random() * candidates.length)];
  }

  if (!chosen) return null;

  const proxy = buildProxyDescriptor(chosen, cc, sessionId);
  if (!proxy) return null;

  if (PREFLIGHT_CHECK) {
    const result = await testOneProxy(proxy, 8_000);
    if (result.ok) {
      markSuccess(proxy.providerLabel, result.latencyMs, cc, result.ip);
      proxy._liveLatencyMs = result.latencyMs;
      proxy._liveVerified = true;
    } else {
      markFailure(proxy.providerLabel, result.error);
      return getProxyForCountry(country, { sessionId, requireHealthy });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// 14. PERIODIC HEALTH MONITOR (with Telegram alerts)
// ─────────────────────────────────────────────────────────────────────────────

let monitorInterval = null;
let telegramBot = null;
let alertChatId = MONITOR_ALERT_CHAT_ID || null;
let previousStatus = {}; // { label: 'healthy'|'unhealthy' }

/**
 * Start periodic health monitoring.
 * Tests all providers every N minutes and sends Telegram alerts on status changes.
 *
 * @param {object} bot - Telegraf bot instance
 * @param {{ intervalMin?: number, chatId?: string }} [opts]
 */
export function startPeriodicHealthMonitor(bot, { intervalMin, chatId } = {}) {
  if (!HAS_PROXY) {
    console.log('[proxy:monitor] No providers configured — monitor disabled');
    return;
  }

  telegramBot = bot;
  if (chatId) alertChatId = chatId;

  const interval = (intervalMin || MONITOR_INTERVAL_MIN) * 60 * 1000;
  if (interval <= 0) {
    console.log('[proxy:monitor] Interval set to 0 — monitor disabled');
    return;
  }

  // Initialize previous status
  for (const p of PROXY_PROVIDERS) {
    previousStatus[p.label] = 'unknown';
  }

  console.log(`[proxy:monitor] Started — checking every ${intervalMin || MONITOR_INTERVAL_MIN}min`);

  // Run first check immediately
  runHealthCheck();

  // Then periodically
  monitorInterval = setInterval(runHealthCheck, interval);
  monitorInterval.unref(); // Don't keep process alive just for this
}

/**
 * Stop the periodic health monitor.
 */
export function stopPeriodicHealthMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('[proxy:monitor] Stopped');
  }
}

/**
 * Set the alert chat ID dynamically.
 */
export function setMonitorChatId(chatId) {
  alertChatId = chatId;
}

async function runHealthCheck() {
  if (!HAS_PROXY) return;

  const providers = PROXY_PROVIDERS.filter(p => p.type !== 'api');
  if (providers.length === 0) return;

  console.log(`[proxy:monitor] Running health check on ${providers.length} provider(s)...`);

  const results = [];
  // Test each provider with a few diverse countries
  const testCountries = ['us', 'gb', 'de', 'jp', 'sg', 'in'];

  for (const prov of providers) {
    let bestResult = null;

    for (const cc of testCountries) {
      const proxy = buildProxyDescriptor(prov, cc);
      if (!proxy) continue;
      const result = await testOneProxy(proxy, HEALTH_TIMEOUT_MS);
      if (result.ok) {
        markSuccess(prov.label, result.latencyMs, cc, result.ip);
        if (!bestResult || result.latencyMs < bestResult.latencyMs) {
          bestResult = result;
        }
      } else {
        markFailure(prov.label, result.error);
      }
      // Small delay between tests to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    results.push({
      label: prov.label,
      type: prov.type,
      ok: !!bestResult,
      latencyMs: bestResult?.latencyMs || null,
      country: bestResult?.country || null,
      ip: bestResult?.ip || null,
      error: bestResult ? null : getHealth(prov.label).lastError,
    });
  }

  // Check for status changes and send alerts
  await checkAndAlert(results);

  // Log summary
  const okCount = results.filter(r => r.ok).length;
  console.log(`[proxy:monitor] Health check done: ${okCount}/${results.length} healthy`);
  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    const detail = r.ok ? `${r.latencyMs}ms (${r.country?.toUpperCase()})` : r.error;
    console.log(`[proxy:monitor]   ${icon} ${r.label} (${r.type}) — ${detail}`);
  }
}

async function checkAndAlert(results) {
  if (!telegramBot || !alertChatId) return;

  for (const r of results) {
    const prev = previousStatus[r.label] || 'unknown';
    const curr = r.ok ? 'healthy' : 'unhealthy';

    if (prev !== curr) {
      previousStatus[r.label] = curr;

      let message;
      if (curr === 'unhealthy') {
        message =
          `🚨 <b>Proxy DOWN</b>\n` +
          `Provider: <code>${r.label}</code> (${r.type})\n` +
          `Error: <code>${r.error || 'Unknown'}</code>\n` +
          `Time: ${new Date().toISOString()}`;
      } else {
        message =
          `✅ <b>Proxy RECOVERED</b>\n` +
          `Provider: <code>${r.label}</code> (${r.type})\n` +
          `Latency: ${r.latencyMs}ms\n` +
          `Country: ${r.country?.toUpperCase() || '?'}\n` +
          `IP: <code>${r.ip || '?'}</code>\n` +
          `Time: ${new Date().toISOString()}`;
      }

      try {
        await telegramBot.telegram.sendMessage(alertChatId, message, { parse_mode: 'HTML' });
        console.log(`[proxy:monitor] Alert sent to ${alertChatId}: ${curr}`);
      } catch (err) {
        console.log(`[proxy:monitor] Failed to send alert: ${err.message}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. STATUS / INTROSPECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get detailed status for all providers.
 */
export function getProviderStatus() {
  return PROXY_PROVIDERS.map(p => {
    const h = getHealth(p.label);
    return {
      label: p.label,
      type: p.type,
      host: p.host,
      port: p.port,
      healthy: !h.unhealthy,
      consecutiveFailures: h.consecutiveFailures,
      lastLatencyMs: h.lastLatencyMs,
      lastChecked: h.lastChecked,
      lastError: h.lastError,
      lastCountry: h.lastCountry,
      lastIp: h.lastIp,
    };
  });
}

/**
 * Get a human-readable proxy summary for Telegram messages.
 */
export function getProxySummary() {
  if (!HAS_PROXY) {
    return '⚠️ <b>No proxy configured.</b>\nRegistrations will use your real IP (not recommended).';
  }

  const statuses = getProviderStatus();
  const healthy = statuses.filter(s => s.healthy).length;
  const total = statuses.length;

  let summary = `<b>🔌 Proxy Status</b> (${healthy}/${total} healthy)\n`;
  summary += `<i>Mode: ${ROTATION_MODE} | Threshold: ${MAX_LATENCY_THRESHOLD_MS}ms</i>\n\n`;

  for (const s of statuses) {
    const icon = s.healthy ? '🟢' : '🔴';
    const lat = s.lastLatencyMs != null ? `${s.lastLatencyMs}ms` : 'untested';
    const country = s.lastCountry ? ` (${s.lastCountry.toUpperCase()})` : '';
    const ip = s.lastIp ? `\n   IP: <code>${s.lastIp}</code>` : '';
    const err = !s.healthy && s.lastError ? `\n   ❌ <code>${s.lastError}</code>` : '';

    summary += `${icon} <b>${s.label}</b> (${s.type}) — ${lat}${country}${ip}${err}\n`;
  }

  if (MONITOR_INTERVAL_MIN > 0) {
    summary += `\n🕐 Health monitor: every ${MONITOR_INTERVAL_MIN}min`;
  }

  return summary;
}

/**
 * Quick test: run a single health check and return result.
 * (Backward-compatible with old testProxy API)
 */
export async function testProxy(country, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const proxy = await getProxyForCountry(country, { requireHealthy: false });
  if (!proxy) {
    return { ok: false, country: normalizeCountry(country) || 'worldwide', error: 'No proxy configured' };
  }
  return testOneProxy(proxy, timeoutMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. FAILOVER WRAPPER
// ─────────────────────────────────────────────────────────────────────────────

export async function withProxyFailover(country, fn, { sessionId, maxAttempts } = {}) {
  if (!HAS_PROXY) {
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
    const proxy = await getProxyForCountry(country, { sessionId, requireHealthy: i < max - 1 });
    if (!proxy) {
      attempts.push({ label: 'none', error: 'No proxy available' });
      break;
    }
    if (tried.has(proxy.providerLabel)) continue;
    tried.add(proxy.providerLabel);

    try {
      const result = await fn(proxy);
      markSuccess(proxy.providerLabel, null);
      return { result, proxyUsed: proxy, attempts };
    } catch (err) {
      markFailure(proxy.providerLabel, err.message);
      attempts.push({ label: proxy.providerLabel, error: err.message });
    }
  }

  return { result: null, proxyUsed: null, attempts };
}