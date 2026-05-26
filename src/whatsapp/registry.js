import { readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = path.join(__dirname, '..', '..', 'registered_numbers.json');

/** Path to the registry JSON file */
function getRegistryPath() {
  return REGISTRY_FILE;
}

/** Load the registered numbers map from disk */
export function loadRegistry() {
  const p = getRegistryPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

/** Save the registry map to disk */
async function saveRegistry(registry) {
  const p = getRegistryPath();
  await writeFile(p, JSON.stringify(registry, null, 2));
}

/** Add a phone number to the registry after successful registration */
export async function addToRegistry(phone, numberInfo) {
  const reg = loadRegistry();
  reg[phone] = {
    ...numberInfo,
    registeredAt: new Date().toISOString(),
  };
  await saveRegistry(reg);
}

/** Remove a phone number from the registry */
export async function removeFromRegistry(phone) {
  const reg = loadRegistry();
  delete reg[phone];
  await saveRegistry(reg);
}

/** Check if a phone number is already registered */
export function isRegistered(phone) {
  const reg = loadRegistry();
  return !!reg[phone];
}

/** Get (and create if needed) the auth state directory for a phone number */
export function getAuthDir(phone) {
  const dir = path.join(config.authStateDir, phone);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** List all auth state directories (phone numbers with saved sessions) */
export function listAuthDirs() {
  if (!existsSync(config.authStateDir)) return [];
  return readdirSync(config.authStateDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}