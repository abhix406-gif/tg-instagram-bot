import { Boom } from '@hapi/boom';
import { existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { getAuthDir, addToRegistry, listAuthDirs, loadRegistry, isRegistered } from './registry.js';
import { requestMetaVerificationCode, verifyMetaRegistrationCode } from './meta_cloud.js';

const BAILEYS_INFO_URL = 'https://raw.githubusercontent.com/z4phdev/client/refs/heads/main/information.json';
let baileysImportPromise = null;
let disconnectReason = {};

/** In-memory map: phone -> pending pairing registration */
const activeRegistrations = new Map();
/** Map: phone -> connected WASocket for active sessions */
const activeSockets = new Map();

// ---------- Helpers ----------

function normalizePhone(phone) {
  const cleaned = phone.replace(/[^\d+]/g, '');
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function formatPhoneForBaileys(phone) {
  return phone.replace('+', '');
}

async function getBaileys() {
  if (!baileysImportPromise) {
    baileysImportPromise = (async () => {
      const originalFetch = globalThis.fetch;
      const patchedFetch = (url, ...args) => {
        if (String(url).startsWith(BAILEYS_INFO_URL)) {
          return Promise.resolve({ json: async () => [''] });
        }
        return originalFetch(url, ...args);
      };

      if (typeof originalFetch === 'function') {
        globalThis.fetch = patchedFetch;
      }

      try {
        const mod = await import('@kyuu2nd/baileys');
        disconnectReason = mod.DisconnectReason || {};
        return mod;
      } finally {
        if (typeof originalFetch === 'function' && globalThis.fetch === patchedFetch) {
          globalThis.fetch = originalFetch;
        }
      }
    })().catch((error) => {
      baileysImportPromise = null;
      throw error;
    });
  }

  return baileysImportPromise;
}

function formatPairingCode(code) {
  const compact = String(code || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  return compact.match(/.{1,4}/g)?.join('-') || String(code || '');
}

async function getSocketVersion(fetchLatestBaileysVersion) {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch {
    return [2, 3000, 1093313117];
  }
}

function getDisconnectStatusCode(error) {
  if (!error) return undefined;
  if (error?.output?.statusCode) return error.output.statusCode;
  try {
    return new Boom(error).output?.statusCode;
  } catch {
    return undefined;
  }
}

function closeSocket(sock) {
  try {
    sock?.ws?.close();
  } catch {}
  try {
    sock?.end?.(undefined);
  } catch {}
}

async function notify(registration, callbackName, payload) {
  try {
    await registration?.callbacks?.[callbackName]?.(payload);
  } catch (error) {
    console.error(`Pairing callback failed (${callbackName}):`, error);
  }
}

async function cleanupPendingRegistration(normalized, { removeAuth = false } = {}) {
  const registration = activeRegistrations.get(normalized);
  if (!registration) return;

  if (registration.timeout) {
    clearTimeout(registration.timeout);
  }

  activeRegistrations.delete(normalized);
  closeSocket(registration.sock);

  if (removeAuth && registration.authDir && !isRegistered(normalized)) {
    await rm(registration.authDir, { recursive: true, force: true });
  }
}

async function finalizePairing(normalized) {
  const registration = activeRegistrations.get(normalized);
  if (!registration || registration.completed) return;

  registration.completed = true;
  if (registration.timeout) {
    clearTimeout(registration.timeout);
  }

  await addToRegistry(normalized, {
    jid: registration.sock.user?.id || null,
    lid: registration.sock.user?.lid || null,
    method: 'pairing-code',
  });

  activeSockets.set(normalized, registration.sock);
  activeRegistrations.delete(normalized);

  await notify(registration, 'onLinked', {
    phone: normalized,
    jid: registration.sock.user?.id || null,
  });
}

async function expirePairing(normalized) {
  const registration = activeRegistrations.get(normalized);
  if (!registration || registration.completed) return;

  await cleanupPendingRegistration(normalized, { removeAuth: true });
  await notify(registration, 'onTimeout', {
    phone: normalized,
    message: `Pairing code expired for ${normalized}. Start /register again to generate a new code.`,
  });
}

async function handlePairingConnectionUpdate(normalized, update) {
  const { connection, lastDisconnect } = update;
  const registration = activeRegistrations.get(normalized);

  if (connection === 'open') {
    await finalizePairing(normalized);
    return;
  }

  if (connection !== 'close') return;

  const reason = getDisconnectStatusCode(lastDisconnect?.error);
  if (registration && !registration.completed) {
    await cleanupPendingRegistration(normalized, { removeAuth: true });
    await notify(registration, 'onFailure', {
      phone: normalized,
      message: `Pairing failed for ${normalized}. ${lastDisconnect?.error?.message || 'Connection closed before the number was linked.'}`,
      reason,
    });
    return;
  }

  if (reason === disconnectReason.loggedOut) {
    activeSockets.delete(normalized);
  }
}

// ---------- Pairing Code Registration ----------

export function getRegistrationProvider() {
  return config.whatsappRegistrationProvider === 'meta-cloud' ? 'meta-cloud' : 'pairing';
}

export async function requestRegistrationCode(phone, options = {}) {
  if (getRegistrationProvider() === 'meta-cloud') {
    return requestMetaVerificationCode(phone, options.method || 'sms');
  }

  return requestPairingCode(phone, options.callbacks || {});
}

export async function verifyRegistrationCode(phone, code) {
  if (getRegistrationProvider() === 'meta-cloud') {
    return verifyMetaRegistrationCode(phone, code);
  }

  return {
    success: false,
    message: 'This bot is currently using pairing-code mode, so there is no SMS OTP to verify.',
  };
}

/**
 * Generate a WhatsApp linked-device pairing code for the given phone number.
 * The user enters the returned code inside WhatsApp on their phone.
 *
 * @param {string} phone - Phone number with country code (e.g., +911234567890)
 * @param {{ onLinked?: Function, onFailure?: Function, onTimeout?: Function }} callbacks
 * @returns {Promise<{ success: boolean, message: string, code?: string }>}
 */
export async function requestPairingCode(phone, callbacks = {}) {
  const normalized = normalizePhone(phone);

  if (isRegistered(normalized)) {
    return {
      success: false,
      message: `${normalized} is already registered.`,
    };
  }

  const existing = activeRegistrations.get(normalized);
  if (existing?.startedAt) {
    const elapsed = Date.now() - existing.startedAt;
    if (elapsed < config.otpCooldownMs) {
      const remaining = Math.ceil((config.otpCooldownMs - elapsed) / 1000);
      return {
        success: false,
        message: `Please wait ${remaining}s before requesting another pairing code for this number.`,
      };
    }
  }

  await cleanupPendingRegistration(normalized, { removeAuth: true });

  const authDir = path.join(config.authStateDir, normalized);
  await rm(authDir, { recursive: true, force: true });
  await mkdir(authDir, { recursive: true });

  try {
    const {
      makeWASocket,
      useMultiFileAuthState,
      Browsers,
      fetchLatestBaileysVersion,
    } = await getBaileys();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const pino = (await import('pino')).default;
    const sock = makeWASocket({
      auth: state,
      version: await getSocketVersion(fetchLatestBaileysVersion),
      browser: Browsers(config.browserDescription),
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      shouldSyncHistory: false,
      generateHighQualityLink: false,
    });

    const registration = {
      startedAt: Date.now(),
      phone: normalized,
      sock,
      authDir,
      callbacks,
      completed: false,
      timeout: null,
    };

    activeRegistrations.set(normalized, registration);
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      void handlePairingConnectionUpdate(normalized, update);
    });

    const rawCode = await sock.requestPairingCode(formatPhoneForBaileys(normalized));
    const code = formatPairingCode(rawCode);
    registration.code = code;
    registration.timeout = setTimeout(() => {
      void expirePairing(normalized);
    }, config.pairingTimeoutMs);

    return {
      success: true,
      code,
      message:
        `Pairing code generated for \`${normalized}\`.\n\n` +
        `Code: \`${code}\`\n\n` +
        `On WhatsApp, open Settings > Linked devices > Link a device > Link with phone number instead, then enter this code.\n\n` +
        `The bot will confirm here once the number is linked.`,
    };
  } catch (error) {
    await cleanupPendingRegistration(normalized, { removeAuth: true });
    return {
      success: false,
      message:
        `Failed to generate pairing code: ${error?.message || 'Unknown error'}\n\n` +
        `Make sure the number belongs to a WhatsApp account you control, then try /register again.`,
    };
  }
}

/**
 * @deprecated SMS OTP registration is not supported by this Baileys build.
 */
export async function requestOTP() {
  return {
    success: false,
    message: 'SMS OTP registration is not supported by the installed Baileys version. Use /register to generate a WhatsApp pairing code instead.',
  };
}

/**
 * @deprecated OTP verification is not used by the pairing-code flow.
 */
export async function registerPhone() {
  return {
    success: false,
    message: 'OTP verification is no longer used. Start /register, generate a pairing code, and enter it in WhatsApp.',
  };
}

// ---------- Session Management ----------

/**
 * Load an existing registered session and create an active WhatsApp socket.
 * @param {string} phone
 * @returns {Promise<{ success: boolean, socket?: any, message: string }>}
 */
export async function loadSession(phone) {
  const normalized = normalizePhone(phone);
  const authDir = getAuthDir(normalized);

  if (!existsSync(path.join(authDir, 'creds.json'))) {
    return { success: false, message: `No saved session found for ${normalized}.` };
  }

  try {
    const {
      makeWASocket,
      useMultiFileAuthState,
      Browsers,
      fetchLatestBaileysVersion,
    } = await getBaileys();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      version: await getSocketVersion(fetchLatestBaileysVersion),
      browser: Browsers(config.browserDescription),
      printQRInTerminal: false,
      shouldSyncHistory: false,
      generateHighQualityLink: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'close') {
        const reason = getDisconnectStatusCode(lastDisconnect?.error);
        if (reason === disconnectReason.loggedOut) {
          activeSockets.delete(normalized);
        }
      }
    });

    activeSockets.set(normalized, sock);

    await new Promise(resolve => setTimeout(resolve, 1000));

    return { success: true, socket: sock, message: `Session loaded for ${normalized}.` };
  } catch (error) {
    return { success: false, message: `Failed to load session: ${error?.message}` };
  }
}

/**
 * Load all registered sessions on startup.
 * @returns {Promise<number>} Number of sessions loaded
 */
export async function loadAllSessions() {
  const phones = listAuthDirs();
  let loaded = 0;
  for (const phone of phones) {
    if (phone.startsWith('_temp') || phone.startsWith('_pairing')) continue;
    const result = await loadSession(phone.startsWith('+') ? phone : `+${phone}`);
    if (result.success) loaded++;
  }
  return loaded;
}

/**
 * Send a WhatsApp text message using an active session.
 * @param {string} phone - Registered phone number to send from
 * @param {string} to - Recipient number with country code
 * @param {string} text - Message content
 */
export async function sendMessage(phone, to, text) {
  const normalized = normalizePhone(phone);
  const sock = activeSockets.get(normalized);
  if (!sock) {
    return { success: false, message: `No active session for ${normalized}.` };
  }

  try {
    const jid = formatPhoneForBaileys(normalizePhone(to)) + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text });
    return { success: true, message: `Message sent to ${to}.` };
  } catch (error) {
    return { success: false, message: `Failed to send message: ${error?.message}` };
  }
}

/**
 * Disconnect all active WhatsApp sessions gracefully.
 */
export async function disconnectAll() {
  for (const [phone, sock] of activeSockets.entries()) {
    closeSocket(sock);
    activeSockets.delete(phone);
  }
}

/**
 * List all currently registered phone numbers.
 */
export function listRegisteredPhones() {
  const reg = loadRegistry();
  return Object.keys(reg);
}
