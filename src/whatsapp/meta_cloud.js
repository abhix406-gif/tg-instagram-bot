import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from '../config.js';
import { addToRegistry } from './registry.js';

const pendingMetaRegistrations = new Map();

function normalizePhone(phone) {
  const cleaned = phone.replace(/[^\d+]/g, '');
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function getGraphBaseUrl() {
  return `https://graph.facebook.com/${config.metaGraphVersion}`;
}

function parseGraphError(payload, fallback) {
  const error = payload?.error;
  if (!error) return fallback;

  const parts = [
    error.message,
    error.code ? `code ${error.code}` : null,
    error.error_subcode ? `subcode ${error.error_subcode}` : null,
    error.fbtrace_id ? `trace ${error.fbtrace_id}` : null,
  ].filter(Boolean);

  return parts.join(' | ') || fallback;
}

async function graphPost(path, body) {
  const response = await fetch(`${getGraphBaseUrl()}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.metaAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: { message: text } };
  }

  if (!response.ok) {
    throw new Error(parseGraphError(payload, `Meta Graph API returned HTTP ${response.status}`));
  }

  return payload;
}

function validateMetaConfig() {
  if (!config.metaAccessToken) {
    throw new Error('META_ACCESS_TOKEN is missing in .env');
  }

  if (!config.metaPhoneNumberId && (!config.metaWabaId || !config.metaVerifiedName)) {
    throw new Error('Set META_PHONE_NUMBER_ID, or set both META_WABA_ID and META_VERIFIED_NAME to add fresh numbers to a WABA.');
  }

  if (!/^\d{6}$/.test(config.metaTwoStepPin || '')) {
    throw new Error('META_TWO_STEP_PIN must be set to a 6-digit PIN for Cloud API registration.');
  }
}

function splitPhoneNumber(phone) {
  const parsed = parsePhoneNumberFromString(phone);
  if (!parsed?.isValid()) {
    throw new Error(`Invalid phone number: ${phone}`);
  }

  return {
    countryCode: parsed.countryCallingCode,
    nationalNumber: parsed.nationalNumber,
  };
}

async function createPhoneNumberOnWaba(phone) {
  const { countryCode, nationalNumber } = splitPhoneNumber(phone);
  const response = await graphPost(`${config.metaWabaId}/phone_numbers`, {
    cc: countryCode,
    phone_number: nationalNumber,
    verified_name: config.metaVerifiedName,
  });

  const phoneNumberId = response.id || response.phone_number_id;
  if (!phoneNumberId) {
    throw new Error('Meta did not return a phone number ID after adding the number to the WABA.');
  }

  return phoneNumberId;
}

async function resolvePhoneNumberId(phone) {
  if (config.metaPhoneNumberId) {
    return config.metaPhoneNumberId;
  }

  return createPhoneNumberOnWaba(phone);
}

export function isMetaCloudConfigured() {
  return Boolean(config.metaAccessToken && (config.metaPhoneNumberId || (config.metaWabaId && config.metaVerifiedName)));
}

export async function requestMetaVerificationCode(phone, method = 'sms') {
  const normalized = normalizePhone(phone);

  try {
    validateMetaConfig();

    const phoneNumberId = await resolvePhoneNumberId(normalized);
    const codeMethod = method.toUpperCase() === 'VOICE' ? 'VOICE' : 'SMS';

    await graphPost(`${phoneNumberId}/request_code`, {
      code_method: codeMethod,
      language: config.metaVerifyLanguage,
    });

    pendingMetaRegistrations.set(normalized, {
      phoneNumberId,
      requestedAt: Date.now(),
      method: codeMethod,
    });

    return {
      success: true,
      phone: normalized,
      phoneNumberId,
      message:
        `OTP requested for ${normalized} via ${codeMethod}.\n\n` +
        `When you receive the code, send it here as 6 digits.`,
    };
  } catch (error) {
    return {
      success: false,
      message:
        `Failed to request WhatsApp Business OTP: ${error?.message || 'Unknown error'}\n\n` +
        `This works only for numbers being registered under your Meta WhatsApp Business Account.`,
    };
  }
}

export async function verifyMetaRegistrationCode(phone, code) {
  const normalized = normalizePhone(phone);
  const cleanCode = String(code || '').replace(/\D/g, '');
  const pending = pendingMetaRegistrations.get(normalized);

  if (!/^\d{6}$/.test(cleanCode)) {
    return {
      success: false,
      message: 'Invalid OTP format. Send the 6-digit code from SMS or voice.',
    };
  }

  if (!pending && !config.metaPhoneNumberId) {
    return {
      success: false,
      message: `No active Meta registration found for ${normalized}. Send /register again.`,
    };
  }

  try {
    validateMetaConfig();

    const phoneNumberId = pending?.phoneNumberId || config.metaPhoneNumberId;

    await graphPost(`${phoneNumberId}/verify_code`, {
      code: cleanCode,
    });

    await graphPost(`${phoneNumberId}/register`, {
      messaging_product: 'whatsapp',
      pin: config.metaTwoStepPin,
    });

    pendingMetaRegistrations.delete(normalized);

    await addToRegistry(normalized, {
      method: 'meta-cloud',
      phoneNumberId,
      jid: null,
      lid: null,
    });

    return {
      success: true,
      message: `Done. ${normalized} was verified and registered through WhatsApp Business Cloud API.`,
    };
  } catch (error) {
    return {
      success: false,
      message:
        `Failed to verify/register OTP: ${error?.message || 'Unknown error'}\n\n` +
        `Check that the code is fresh, the number belongs to your WABA, and META_TWO_STEP_PIN is correct.`,
    };
  }
}
