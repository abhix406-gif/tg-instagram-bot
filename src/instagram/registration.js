import { chromium } from 'playwright';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProxyForCountry, getBestProxy, normalizeCountry, testProxy, HAS_PROXY, getProxySummary } from './proxy.js';

puppeteer.use(StealthPlugin());

const activeSession = {
  browser: null,
  page: null,
  email: null,
  proxyInfo: null,
  formData: null, // stored for email-code verification resume
  acquiredCreds: null, // { email, password, fullName, username } set after account creation, used by submit2FAOTP
};

// Screenshot directory — ensure it exists
const SCREENSHOT_DIR = path.resolve('logs', 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

let screenshotSeq = 0;
function resetScreenshotSeq() { screenshotSeq = 0; }

async function screenshot(page, label) {
  const seq = String(++screenshotSeq).padStart(2, '0');
  const file = path.join(SCREENSHOT_DIR, `${seq}_${label.replace(/[^a-z0-9_]/gi, '_')}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  📸 Screenshot: ${file}`);
  } catch (e) {
    console.log(`  ⚠️ Screenshot failed: ${e.message}`);
  }
  return file;
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Anti-ban: Scrape account page after successful creation for 2FA codes / backup info.
 * Instagram shows recovery/backup codes in settings after completing signup.
 * Returns scraped data string or null if nothing found.
 */
async function scrapeAccountCredentials(page, creds) {
  try {
    let credentialBlock = '';
    credentialBlock += `📧 Email: \`${creds.email}\`\n`;
    credentialBlock += `👤 Name: \`${creds.fullName}\`\n`;
    credentialBlock += `🔤 Username: \`${creds.username}\`\n`;
    credentialBlock += `🔑 Password: \`${creds.password}\`\n`;

    // ── Helper: click a visible element by text regex ──
    async function clickByText(regex, { timeout = 5000 } = {}) {
      const found = await page.evaluate((r) => {
        const all = document.querySelectorAll('a, button, span, div[role="button"], div[role="link"], div[role="menuitem"]');
        for (let i = 0; i < all.length; i++) {
          const text = (all[i].textContent || '').trim();
          if (new RegExp(r, 'i').test(text)) {
            const rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              all[i].scrollIntoView({ block: 'center' });
              return { idx: i, text: text.slice(0, 80) };
            }
          }
        }
        return null;
      }, regex.source);
      
      if (!found) return false;
      
      // Re-query fresh elements
      const fresh = await page.$$('a, button, span, div[role="button"], div[role="link"], div[role="menuitem"]');
      if (found.idx < fresh.length) {
        console.log(`    Clicked: "${found.text}"`);
        // Dual click: JS + Playwright
        await fresh[found.idx].evaluate(el => el.click()).catch(() => {});
        await fresh[found.idx].click({ timeout: 3000 }).catch(() => {});
        await delay(randomDelay(1500, 3000));
        return true;
      }
      return false;
    }

    // ── Helper: extract TOTP key from current page body ──
    async function extractTotpKey() {
      return await page.evaluate(() => {
        const body = (document.body?.innerText || '');
        const html = (document.body?.innerHTML || '');
        // Instagram displays TOTP key in format like: "JBSW Y3DP EHPK P3XP" or "JBSWY3DPEHPKP3XP"
        // Also look for QR code alt text or setup key paragraphs
        
        // ── Strategy 0: Extract from otpauth:// QR code URI (most reliable) ──
        // Instagram embeds the otpauth:// URI in an <img src="...">, a <canvas>, or inline data
        const otpauthMatch = html.match(/otpauth:\/\/totp\/[^"'\s<>]+/);
        if (otpauthMatch) {
          // Extract the secret parameter: ?secret=XXXX&issuer=...
          const secretMatch = otpauthMatch[0].match(/[?&]secret=([A-Za-z2-7]{16,52})(?:&|$)/);
          if (secretMatch) {
            // Instagram may lowercase the secret in the URI — normalize to uppercase
            const key = secretMatch[1].toUpperCase();
            if (key.length >= 16 && key.length <= 52) {
              return key;
            }
          }
        }
        
        // ── Strategy 0b: Check all img/canvas elements for otpauth data ──
        const allImages = document.querySelectorAll('img[src], canvas');
        for (const el of allImages) {
          try {
            if (el.tagName === 'CANVAS') {
              const dataUri = el.toDataURL();
              if (dataUri && dataUri.includes('otpauth')) {
                const sm = dataUri.match(/otpauth:\/\/totp\/[^"'\s<>]+/);
                if (sm) {
                  const secretM = sm[0].match(/[?&]secret=([A-Za-z2-7]{16,52})(?:&|$)/);
                  if (secretM) return secretM[1].toUpperCase();
                }
              }
            } else {
              const src = el.getAttribute('src') || '';
              if (src.includes('otpauth') || src.includes('data:image')) {
                const osm = src.match(/otpauth:\/\/totp\/[^"'\s<>]+/);
                if (osm) {
                  const secretM = osm[0].match(/[?&]secret=([A-Za-z2-7]{16,52})(?:&|$)/);
                  if (secretM) return secretM[1].toUpperCase();
                }
              }
            }
          } catch (_) {}
        }
        
        // ── Strategy 1: Standalone base32 key (16-52 chars, A-Z 2-7, optionally space-separated) ──
        const base32Pattern = /(?:[A-Z2-7]{4}\s*){4,13}/g;
        const matches = body.match(base32Pattern);
        if (matches) {
          // Filter out common false positives (words that happen to match base32)
          const filtered = matches
            .map(m => m.replace(/\s+/g, ''))
            .filter(m => {
              // Must be 16-52 chars of base32 alphabet
              if (m.length < 16 || m.length > 52) return false;
              // Reject strings that look like English words (contain only letters, no digits)
              // Real TOTP keys typically have a mix of letters and digits
              return true;
            });
          if (filtered.length > 0) {
            // Prefer keys that contain at least one digit (more likely TOTP than word)
            const withDigits = filtered.filter(m => /\d/.test(m));
            const candidates = withDigits.length > 0 ? withDigits : filtered;
            // Longest match is most likely the key
            candidates.sort((a, b) => b.length - a.length);
            return candidates[0];
          }
        }
        
        // ── Strategy 2: "Setup key" / "Manual entry" label followed by a code ──
        const setupKeyMatch = body.match(/(?:setup\s*key|manual\s*entry|secret\s*key|authenticator\s*key)[:\s]*([A-Z2-7]{16,52})/i);
        if (setupKeyMatch) return setupKeyMatch[1].toUpperCase();
        
        // ── Strategy 3: Look for text near "can't scan" or "enter manually" ──
        const cantScanSection = body.match(/(?:can'?t\s*scan|enter\s*manually|manual\s*setup)[\s\S]{0,300}/i);
        if (cantScanSection) {
          const codeInSection = cantScanSection[0].match(/[A-Z2-7]{16,52}/i);
          if (codeInSection) return codeInSection[0].toUpperCase();
        }
        
        // ── Strategy 4: Look for any base32 string in the full HTML (last resort) ──
        const htmlBase32 = html.match(/[A-Za-z2-7]{32,52}/g);
        if (htmlBase32) {
          const validKeys = htmlBase32
            .map(k => k.toUpperCase())
            .filter(k => k.length >= 16 && k.length <= 52 && /[2-7]/.test(k));
          if (validKeys.length > 0) {
            validKeys.sort((a, b) => b.length - a.length);
            return validKeys[0];
          }
        }
        
        return null;
      });
    }

    // ── Step 1: Check current page for any inline backup codes ──
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '');
      const recoveryMatches = bodyText.match(/(?:backup|recovery|2fa|two.factor)[\s\S]*?(\d[\d\s-]{4,})/gi);
      if (recoveryMatches && recoveryMatches.length > 0) {
        credentialBlock += `\n📋 *Recovery/Backup Codes:*\n\`\`\`\n${recoveryMatches.slice(0, 8).join('\n')}\n\`\`\``;
      }
    } catch {}

    // ── Step 2: Navigate to Account Center → Password & Security → 2FA → Auth App → Get Key ──
    let totpKey = null;
    let backupCodesFound = false;

    try {
      // 2a. Go to Instagram home to ensure we have the hamburger menu
      console.log('  [2FA] Navigating to Instagram home...');
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await delay(randomDelay(2000, 4000));

      // 2b. Click the hamburger menu (three lines, bottom-left or top-right on mobile)
      console.log('  [2FA] Opening hamburger menu...');
      const menuOpened = await page.evaluate(() => {
        // Mobile: the hamburger is often an SVG in the bottom nav
        const selectors = [
          'svg[aria-label="Settings"]',
          'svg[aria-label="More"]',
          'a[href="/accounts/activity/"]',
          'div[role="button"] svg[aria-label="Settings"]',
          // Fallback: any nav item with settings/menu aria
          '[aria-label="Settings"]',
          '[aria-label="Options"]',
        ];
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0) {
                // Click the closest clickable ancestor
                let clickable = el;
                while (clickable && clickable.tagName !== 'A' && clickable.tagName !== 'BUTTON' && clickable.getAttribute('role') !== 'button') {
                  clickable = clickable.parentElement;
                }
                if (clickable) clickable.click();
                else el.click();
                return true;
              }
            }
          } catch {}
        }
        // Try bottom nav bar items
        const navItems = document.querySelectorAll('nav a, nav button, nav div[role="button"]');
        for (const item of navItems) {
          const text = (item.textContent || '').trim();
          if (/settings|more|menu/i.test(text)) {
            item.click();
            return true;
          }
        }
        // Last resort: tap bottom-right area (common hamburger position)
        const navSvgs = document.querySelectorAll('nav svg, div[role="navigation"] svg');
        if (navSvgs.length >= 3) {
          navSvgs[navSvgs.length - 1].closest('a, button, div[role="button"]')?.click();
          return true;
        }
        return false;
      });
      console.log(`  [2FA] Menu opened: ${menuOpened}`);
      await delay(randomDelay(2000, 3500));

      // 2c. Click "Settings" or "Settings and privacy" in the menu
      console.log('  [2FA] Looking for Settings...');
      await clickByText(/settings/i);
      await delay(randomDelay(2000, 3000));

      // 2d. Click "Account Center" or "See more in Accounts Center"
      // Instagram now redirects 2FA management to accountscenter.instagram.com
      console.log('  [2FA] Looking for Accounts Center...');
      const foundAccountCenter = await clickByText(/account[s]?\s*center|see more in accounts center/i);
      
      if (foundAccountCenter) {
        // May have navigated to accountscenter.instagram.com
        await delay(randomDelay(3000, 5000));
        console.log('  [2FA] Current URL:', page.url());
      } else {
        // Try direct navigation to Accounts Center
        console.log('  [2FA] Trying direct navigation to Accounts Center...');
        try {
          await page.goto('https://accountscenter.instagram.com/', {
            waitUntil: 'domcontentloaded', timeout: 15000
          });
          await delay(randomDelay(3000, 5000));
        } catch {
          // Try the embedded path
          await page.goto('https://www.instagram.com/accounts/account_center/', {
            waitUntil: 'domcontentloaded', timeout: 15000
          });
          await delay(randomDelay(3000, 5000));
        }
      }

      // 2e. Click "Password and security"
      console.log('  [2FA] Looking for Password and security...');
      await clickByText(/password\s*(and|&)\s*security/i);
      await delay(randomDelay(2000, 3000));

      // 2f. Click "Two-factor authentication"
      console.log('  [2FA] Looking for Two-factor authentication...');
      await clickByText(/two[-\s]?factor\s*authentication/i);
      await delay(randomDelay(3000, 5000));

      // At this point we should see a list of accounts or the 2FA options
      const currentBody = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
      console.log('  [2FA] 2FA page body (first 600):', currentBody.slice(0, 600));

      // 2g. If there's an account selector/list, click the account
      // Instagram may show "Choose an account" or list accounts
      const accountClicked = await clickByText(new RegExp(creds.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      if (!accountClicked) {
        // Try clicking first account or "Continue" button
        await clickByText(/continue|next|select/i);
        await delay(randomDelay(1500, 3000));
      }

      // 2h. Click "Authentication app" option
      console.log('  [2FA] Looking for Authentication app option...');
      await clickByText(/authentication\s*app|authenticator\s*app/i);
      await delay(randomDelay(2000, 4000));

      // 2i. Click "Next" or "Continue" to proceed to the setup key screen
      console.log('  [2FA] Clicking Next to get setup key...');
      await clickByText(/next|continue|set\s*up/i);
      await delay(randomDelay(3000, 5000));

      // 2j. Extract the TOTP setup key from the page
      console.log('  [2FA] Extracting TOTP key...');
      totpKey = await extractTotpKey();
      
      if (totpKey) {
        console.log(`  [2FA] ✅ TOTP key extracted: ${totpKey}`);
        credentialBlock += `\n🔐 *2FA Authenticator Key:* \`${totpKey}\``;
        
        // Also try to grab backup codes if visible on this screen
        try {
          const postKeyBody = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '');
          const backupCodes = postKeyBody.match(/\b\d{8}\b/g);
          if (backupCodes && backupCodes.length >= 5) {
            credentialBlock += `\n📋 *Backup Codes:*\n\`\`\`\n${backupCodes.slice(0, 5).join('\n')}\n\`\`\``;
            backupCodesFound = true;
          }
        } catch {}
      } else {
        // Try looking for "Can't scan the QR code?" or "Try another way" link
        console.log('  [2FA] TOTP key not directly visible, trying manual entry link...');
        
        // Check if we're on a QR code screen and need to click "try another way"
        const qrScreen = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
        if (/qr\s*code|scan\s*the|point\s*your/i.test(qrScreen)) {
          // Click "Try another way" or "Can't scan" to reveal the text key
          await clickByText(/try\s*another\s*way|can'?t\s*scan|enter\s*manually|use\s*another\s*method|setup\s*key/i);
          await delay(randomDelay(2000, 4000));
          totpKey = await extractTotpKey();
          
          if (totpKey) {
            console.log(`  [2FA] ✅ TOTP key extracted (after manual entry): ${totpKey}`);
            credentialBlock += `\n🔐 *2FA Authenticator Key:* \`${totpKey}\``;
          }
        }
      }

      // 2k. Fallback: if still no key, try the old-style 2FA page
      if (!totpKey && !backupCodesFound) {
        console.log('  [2FA] Trying legacy 2FA page as fallback...');
        try {
          await page.goto('https://www.instagram.com/accounts/two_factor_authentication/', {
            waitUntil: 'domcontentloaded', timeout: 15000
          });
          await delay(randomDelay(3000, 5000));
          
          const legacyBody = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
          console.log('  [2FA] Legacy 2FA page (first 500):', legacyBody.slice(0, 500));
          
          // Check for backup codes on legacy page
          const legacyCodes = legacyBody.match(/\b\d{8}\b/g);
          if (legacyCodes && legacyCodes.length > 0) {
            credentialBlock += `\n📋 *Backup Codes:*\n\`\`\`\n${legacyCodes.slice(0, 5).join('\n')}\n\`\`\``;
            backupCodesFound = true;
          }
          
          // Try clicking "Use authentication app" or similar
          await clickByText(/authentication\s*app|authenticator/i);
          await delay(randomDelay(2000, 3000));
          
          totpKey = await extractTotpKey();
          if (totpKey) {
            credentialBlock += `\n🔐 *2FA Authenticator Key:* \`${totpKey}\``;
          }
        } catch (legacyErr) {
          console.log('  [2FA] Legacy page also failed:', legacyErr.message);
        }
      }

    } catch (navErr) {
      console.log('  [2FA] Navigation error:', navErr.message);
    }

    // ── Step 3: Final fallback if we got nothing ──
    if (!totpKey && !backupCodesFound) {
      console.log('  [2FA] No TOTP key or backup codes extracted.');
      credentialBlock += `\n⚙️ *2FA:* Not auto-configured. To get the authenticator key:\n1. Log in → Settings (☰) → Account Center\n2. Password and security → Two-factor authentication\n3. Select account → Authentication app → Next\n4. Copy the setup key shown on screen`;
    }

    credentialBlock += `\n\n🔗 Log in at instagram.com`;
    return credentialBlock;
  } catch (e) {
    console.log('  ⚠️ Credential scraping failed:', e.message);
    return `📧 Email: \`${creds.email}\`\n👤 Name: \`${creds.fullName}\`\n🔤 Username: \`${creds.username}\`\n🔑 Password: \`${creds.password}\`\n⚙️ *2FA:* To get the authenticator key go to Settings → Account Center → Password and security → Two-factor authentication → Authentication app\n\n🔗 Log in at instagram.com`;
  }
}

/**
 * Pool of iPhone/iOS device fingerprints to rotate per session.
 * Instagram easily detects Android-based browser automation. iOS/iPadOS
 * devices have much lower ban rates because Instagram's bot detection
 * heuristics are tuned for Android WebView / Chrome patterns.
 * Each entry: { name, ua, viewport: { w, h, dpr }, platform,
 *               webglVendor, webglRenderer, concurrency, deviceMem,
 *               colorDepth, pixelDepth }
 */
const IOS_DEVICE_POOL = [
  {
    name: 'iPhone 15 Pro Max',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.135 Mobile/15E148 Safari/604.1',
    viewport: { w: 430, h: 932, dpr: 3.0 },
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    concurrency: 6,
    deviceMem: 8,
    colorDepth: 24,
    pixelDepth: 24,
  },
  {
    name: 'iPhone 15 Pro',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.135 Mobile/15E148 Safari/604.1',
    viewport: { w: 393, h: 852, dpr: 3.0 },
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    concurrency: 6,
    deviceMem: 8,
    colorDepth: 24,
    pixelDepth: 24,
  },
  {
    name: 'iPhone 14 Pro Max',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/132.0.6834.122 Mobile/15E148 Safari/604.1',
    viewport: { w: 430, h: 932, dpr: 3.0 },
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    concurrency: 6,
    deviceMem: 6,
    colorDepth: 24,
    pixelDepth: 24,
  },
  {
    name: 'iPhone 14 Pro',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/132.0.6834.122 Mobile/15E148 Safari/604.1',
    viewport: { w: 393, h: 852, dpr: 3.0 },
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    concurrency: 6,
    deviceMem: 6,
    colorDepth: 24,
    pixelDepth: 24,
  },
  {
    name: 'iPhone 14',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.135 Mobile/15E148 Safari/604.1',
    viewport: { w: 390, h: 844, dpr: 3.0 },
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    concurrency: 6,
    deviceMem: 6,
    colorDepth: 24,
    pixelDepth: 24,
  },
  {
    name: 'iPhone 13 Pro Max',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/133.0.6943.85 Mobile/15E148 Safari/604.1',
    viewport: { w: 428, h: 926, dpr: 3.0 },
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    concurrency: 6,
    deviceMem: 6,
    colorDepth: 24,
    pixelDepth: 24,
  },
  {
    name: 'iPhone 13',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/133.0.6943.85 Mobile/15E148 Safari/604.1',
    viewport: { w: 390, h: 844, dpr: 3.0 },
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    concurrency: 6,
    deviceMem: 4,
    colorDepth: 24,
    pixelDepth: 24,
  },
  {
    name: 'iPhone SE (3rd Gen)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/132.0.6834.122 Mobile/15E148 Safari/604.1',
    viewport: { w: 375, h: 667, dpr: 2.0 },
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    concurrency: 6,
    deviceMem: 4,
    colorDepth: 24,
    pixelDepth: 24,
  },
];

/**
 * Track which devices have already been used in this session.
 * Each device is used exactly once, then removed from the pool.
 * When the pool is exhausted, a fresh device is dynamically generated.
 */
const _usedDeviceIndices = new Set();
const _dynamicallyGeneratedDevices = [];

/**
 * Pick a random iOS device profile from the pool.
 * Each device is used exactly ONCE — after selection it's removed
 * from the available pool. When the pool is exhausted, new devices
 * are dynamically generated with unique fingerprints to avoid
 * fingerprint reuse (the #1 cause of Instagram bans).
 *
 * @returns {object} The full device fingerprint object.
 */
function randomIOSDevice() {
  // Find available (un-used) devices from the original pool
  const availableIndices = [];
  for (let i = 0; i < IOS_DEVICE_POOL.length; i++) {
    if (!_usedDeviceIndices.has(i)) availableIndices.push(i);
  }

  // If all original devices are used, dynamically generate a new one
  if (availableIndices.length === 0) {
    const newDevice = _generateDynamicDevice();
    _dynamicallyGeneratedDevices.push(newDevice);
    console.log(`[device] Pool exhausted — dynamically generated new iOS device: ${newDevice.name}`);
    return newDevice;
  }

  // Pick a random available device and mark it as used
  const pickIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
  _usedDeviceIndices.add(pickIndex);
  const device = IOS_DEVICE_POOL[pickIndex];
  console.log(`[device] Selected ${device.name} (${_usedDeviceIndices.size}/${IOS_DEVICE_POOL.length} used)`);
  return device;
}

/**
 * Dynamically generate a unique iOS device fingerprint that has never
 * been used before. Varies iPhone model identifiers, iOS versions,
 * screen dimensions, and Safari build numbers to create a believable
 * iOS fingerprint.
 */
function _generateDynamicDevice() {
  const iphoneModels = [
    { name: 'iPhone 15 Pro Max', id: 'iPhone16,2', viewport: { w: 430, h: 932, dpr: 3.0 } },
    { name: 'iPhone 15 Pro', id: 'iPhone16,1', viewport: { w: 393, h: 852, dpr: 3.0 } },
    { name: 'iPhone 15', id: 'iPhone15,4', viewport: { w: 393, h: 852, dpr: 3.0 } },
    { name: 'iPhone 14 Pro Max', id: 'iPhone15,3', viewport: { w: 430, h: 932, dpr: 3.0 } },
    { name: 'iPhone 14 Pro', id: 'iPhone15,2', viewport: { w: 393, h: 852, dpr: 3.0 } },
    { name: 'iPhone 14', id: 'iPhone14,7', viewport: { w: 390, h: 844, dpr: 3.0 } },
    { name: 'iPhone 13 Pro Max', id: 'iPhone14,3', viewport: { w: 428, h: 926, dpr: 3.0 } },
    { name: 'iPhone 13', id: 'iPhone14,5', viewport: { w: 390, h: 844, dpr: 3.0 } },
    { name: 'iPhone 12 Pro Max', id: 'iPhone13,4', viewport: { w: 428, h: 926, dpr: 3.0 } },
    { name: 'iPhone 12', id: 'iPhone13,2', viewport: { w: 390, h: 844, dpr: 3.0 } },
    { name: 'iPhone 11 Pro Max', id: 'iPhone12,5', viewport: { w: 414, h: 896, dpr: 3.0 } },
  ];

  const model = iphoneModels[Math.floor(Math.random() * iphoneModels.length)];
  const iosVersions = ['16.6', '16.7', '17.0', '17.1', '17.2', '17.3', '17.4', '17.5', '18.0', '18.1'];
  const iosVer = iosVersions[Math.floor(Math.random() * iosVersions.length)];
  const iosVerUnderscore = iosVer.replace(/\./g, '_');
  const safariBuilds = ['605.1.15', '604.1', '605.1'];
  const safariBuild = safariBuilds[Math.floor(Math.random() * safariBuilds.length)];
  const chromeVersions = [131, 132, 133, 134, 135];
  const chromeVer = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];

  const concurrencyOptions = [6, 6, 6];
  const memOptions = [4, 4, 6, 6, 8, 8];
  // Apple GPU variants — use slightly different renderer strings
  const gpuVariants = ['Apple GPU', 'Apple A17 Pro GPU', 'Apple A16 Bionic GPU', 'Apple A15 Bionic GPU'];
  const gpuVariant = gpuVariants[Math.floor(Math.random() * gpuVariants.length)];

  return {
    name: `${model.name} (dynamic)`,
    ua: `Mozilla/5.0 (iPhone; CPU iPhone OS ${iosVerUnderscore} like Mac OS X) AppleWebKit/${safariBuild} (KHTML, like Gecko) CriOS/${chromeVer}.0.6778.135 Mobile/15E148 Safari/${safariBuild}`,
    viewport: model.viewport,
    platform: 'iPhone',
    webglVendor: 'Apple Inc.',
    webglRenderer: gpuVariant,
    concurrency: concurrencyOptions[Math.floor(Math.random() * concurrencyOptions.length)],
    deviceMem: memOptions[Math.floor(Math.random() * memOptions.length)],
    colorDepth: 24,
    pixelDepth: 24,
  };
}

/**
 * Reset the device tracker — call this on bot restart.
 */
export function resetDeviceTracker() {
  _usedDeviceIndices.clear();
  _dynamicallyGeneratedDevices.length = 0;
  console.log('[device] Device tracker reset — all devices available again.');
}

/**
 * Locale/timezone hints to make the browser fingerprint match the proxy
 * country. Falls back to en-US/America/New_York.
 */
function localeForCountry(cc) {
  const map = {
    us: { locale: 'en-US', timezone: 'America/New_York' },
    gb: { locale: 'en-GB', timezone: 'Europe/London' },
    in: { locale: 'en-IN', timezone: 'Asia/Kolkata' },
    de: { locale: 'de-DE', timezone: 'Europe/Berlin' },
    fr: { locale: 'fr-FR', timezone: 'Europe/Paris' },
    ca: { locale: 'en-CA', timezone: 'America/Toronto' },
    au: { locale: 'en-AU', timezone: 'Australia/Sydney' },
    br: { locale: 'pt-BR', timezone: 'America/Sao_Paulo' },
    jp: { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
    sg: { locale: 'en-SG', timezone: 'Asia/Singapore' },
    nl: { locale: 'nl-NL', timezone: 'Europe/Amsterdam' },
    es: { locale: 'es-ES', timezone: 'Europe/Madrid' },
    it: { locale: 'it-IT', timezone: 'Europe/Rome' },
    mx: { locale: 'es-MX', timezone: 'America/Mexico_City' },
    ru: { locale: 'ru-RU', timezone: 'Europe/Moscow' },
    tr: { locale: 'tr-TR', timezone: 'Europe/Istanbul' },
    id: { locale: 'id-ID', timezone: 'Asia/Jakarta' },
    ph: { locale: 'en-PH', timezone: 'Asia/Manila' },
    vn: { locale: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' },
    th: { locale: 'th-TH', timezone: 'Asia/Bangkok' },
    kr: { locale: 'ko-KR', timezone: 'Asia/Seoul' },
    hk: { locale: 'zh-HK', timezone: 'Asia/Hong_Kong' },
    tw: { locale: 'zh-TW', timezone: 'Asia/Taipei' },
    ae: { locale: 'ar-AE', timezone: 'Asia/Dubai' },
    sa: { locale: 'ar-SA', timezone: 'Asia/Riyadh' },
    za: { locale: 'en-ZA', timezone: 'Africa/Johannesburg' },
    pl: { locale: 'pl-PL', timezone: 'Europe/Warsaw' },
    se: { locale: 'sv-SE', timezone: 'Europe/Stockholm' },
    no: { locale: 'nb-NO', timezone: 'Europe/Oslo' },
    fi: { locale: 'fi-FI', timezone: 'Europe/Helsinki' },
    dk: { locale: 'da-DK', timezone: 'Europe/Copenhagen' },
    ch: { locale: 'de-CH', timezone: 'Europe/Zurich' },
    at: { locale: 'de-AT', timezone: 'Europe/Vienna' },
    be: { locale: 'nl-BE', timezone: 'Europe/Brussels' },
    ie: { locale: 'en-IE', timezone: 'Europe/Dublin' },
    pt: { locale: 'pt-PT', timezone: 'Europe/Lisbon' },
    gr: { locale: 'el-GR', timezone: 'Europe/Athens' },
    cz: { locale: 'cs-CZ', timezone: 'Europe/Prague' },
    ro: { locale: 'ro-RO', timezone: 'Europe/Bucharest' },
    hu: { locale: 'hu-HU', timezone: 'Europe/Budapest' },
    ua: { locale: 'uk-UA', timezone: 'Europe/Kyiv' },
    ng: { locale: 'en-NG', timezone: 'Africa/Lagos' },
    eg: { locale: 'ar-EG', timezone: 'Africa/Cairo' },
    pk: { locale: 'en-PK', timezone: 'Asia/Karachi' },
    bd: { locale: 'bn-BD', timezone: 'Asia/Dhaka' },
    my: { locale: 'en-MY', timezone: 'Asia/Kuala_Lumpur' },
    nz: { locale: 'en-NZ', timezone: 'Pacific/Auckland' },
    cl: { locale: 'es-CL', timezone: 'America/Santiago' },
    ar: { locale: 'es-AR', timezone: 'America/Argentina/Buenos_Aires' },
    co: { locale: 'es-CO', timezone: 'America/Bogota' },
  };
  return map[cc] || { locale: 'en-US', timezone: 'America/New_York' };
}

/**
 * Resolve a proxy descriptor from either:
 *  - a country code/name (string)       → dynamic provider proxy
 *  - an object { country, sessionId }   → dynamic provider proxy
 *  - an object { server, username?, password? } → raw proxy
 *  - "ip:port" string                   → raw proxy
 *  - null/undefined                     → no proxy
 */
async function resolveProxy(proxyInput, { sessionId } = {}) {
  if (!proxyInput) return null;

  // Raw "ip:port" → no auth, no country rotation
  if (typeof proxyInput === 'string') {
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/.test(proxyInput)) {
      return { server: `http://${proxyInput}`, country: null, isProvider: false, providerLabel: 'custom' };
    }
    // "auto" → run live parallel health checks, pick fastest under threshold
    if (proxyInput === 'auto') {
      const p = await getBestProxy({ sessionId });
      if (!p) return null;
      return { ...p, isProvider: true };
    }
    // Treat plain string as country code — use multi-provider pool
    const p = getProxyForCountry(proxyInput, { sessionId });
    if (!p) return null;
    return { ...p, isProvider: true };
  }

  if (typeof proxyInput === 'object') {
    if (proxyInput.country) {
      const p = getProxyForCountry(proxyInput.country, { sessionId: proxyInput.sessionId || sessionId });
      if (!p) return null;
      return { ...p, isProvider: true };
    }
    if (proxyInput.server) {
      return { ...proxyInput, isProvider: false, providerLabel: 'custom' };
    }
  }
  return null;
}

/**
 * Module-level DOM dumper — usable from any exported function.
 * Injects into page context to enumerate all inputs & selects.
 */
async function _dumpAllInputs(page) {
  // Use a single page.evaluate() to avoid cross-context JS world errors
  // caused by Instagram injecting captcha/challenge iframes mid-signup.
  const results = await page.evaluate(() => {
    const inputs = [];
    const selects = [];
    const allInputs = document.querySelectorAll('input');
    const allSelects = document.querySelectorAll('select');
    for (const inp of allInputs) {
      const rect = inp.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      inputs.push({
        type: inp.type,
        name: inp.name || '',
        autocomplete: inp.autocomplete || '',
        ariaLabel: inp.getAttribute('aria-label') || '',
        placeholder: inp.placeholder || '',
        value: (inp.value?.length || 0) > 0 ? '***filled***' : '',
        visible,
        disabled: inp.disabled,
        tabIndex: inp.tabIndex,
      });
    }
    for (const s of allSelects) {
      const rect = s.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      const opts = Array.from(s.options).map(o => ({ text: o.text?.slice(0, 20), value: o.value, selected: o.selected }));
      selects.push({
        name: s.name || '',
        ariaLabel: s.getAttribute('aria-label') || '',
        visible,
        optionsCount: opts.length,
        options: opts.slice(0, 5),
      });
    }
    return { inputs, selects };
  }).catch((err) => {
    console.log('  [_dumpAllInputs] evaluate failed:', err.message?.slice(0, 120));
    return { inputs: [], selects: [] };
  });
  console.log('FULL DOM DUMP:', JSON.stringify(results, null, 2));
}

/**
 * Scrape Instagram's actual on-page error message.
 * Uses multiple strategies: explicit error elements, then body text pattern matching.
 * Returns the error text or null if nothing found.
 */
async function _scrapeInstagramError(page) {
  try {
    // Priority 1: Explicit error/alert elements
    const errorSelectors = '[role="alert"], #ssfErrorAlert, div[data-testid="error"], p[data-testid], span[role="alert"], [aria-live="assertive"]';
    const errorEls = await page.$$(errorSelectors);
    for (const el of errorEls) {
      const text = (await el.evaluate(el => el.textContent || el.innerText || '').catch(() => '')).trim();
      if (text.length >= 2) return text;
    }

    // Priority 2: Scan body text for known Instagram error patterns
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const patterns = [
      /restrict certain activity/i,
      /try again later/i,
      /something went wrong/i,
      /we couldn't/i,
      /we can't/i,
      /sorry,? something/i,
      /couldn't create/i,
      /can't create/i,
      /not available/i,
      /already taken/i,
      /already in use/i,
      /too many attempts/i,
      /rate limit/i,
      /blocked/i,
      /suspicious/i,
      /unusual activity/i,
      /password.*(?:weak|short|common|easy)/i,
      /enter a valid/i,
      /check your info/i,
      /invalid (?:email|phone)/i,
      /we restrict/i,
      /protect.*community/i,
    ];
    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) {
        const idx = match.index;
        const start = Math.max(0, idx - 40);
        const end = Math.min(bodyText.length, idx + 250);
        const excerpt = bodyText.slice(start, end).replace(/\n/g, ' ').trim();
        return excerpt;
      }
    }

    return null;
  } catch (e) {
    console.log('_scrapeInstagramError failed:', e.message);
    return null;
  }
}

export async function startRegistration(formData, proxyInput = null) {
  const { fullName, email, password } = formData;

  if (activeSession.browser) {
    try { await activeSession.browser.close(); } catch {}
    activeSession.browser = null;
    activeSession.page = null;
  }

  // Build a sticky session id so the same exit IP is used for OTP step
  const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const proxy = await resolveProxy(proxyInput, { sessionId });

  // Verify proxy before launching the browser (much faster than letting
  // Puppeteer time out on a dead proxy).
  if (proxy && proxy.isProvider) {
    const label = proxy.providerLabel || 'unknown';

    // Skip redundant test if getBestProxy() already verified it live
    if (proxy._liveVerified && proxy._liveLatencyMs != null) {
      console.log(`[proxy] ${label} live-verified at ${proxy._liveLatencyMs}ms — skipping retest`);
    } else {
      console.log(`[proxy] Testing ${label} for country=${proxy.country}...`);
      const test = await testProxy(proxy.country, { timeoutMs: 12_000 });
      if (!test.ok) {
        console.log(`[proxy] ${label} FAILED: ${test.error}`);
        return {
          success: false,
          message: `❌ Proxy test failed (${proxy.country.toUpperCase()} via ${label}): ${test.error}\n\nTry another country or /noproxy.`,
        };
      }
      console.log(`[proxy] ${label} OK — exit IP ${test.ip} (${proxy.country}), ${test.latencyMs}ms`);
    }
  }

  try {
    resetScreenshotSeq();

    // ── Random iOS device profile (different device every session = lower ban risk) ──
    const device = randomIOSDevice();
    console.log(`Launching stealth browser as ${device.name} (puppeteer-extra + stealth plugin)...`);

    const { locale, timezone } = proxy?.country
      ? localeForCountry(proxy.country)
      : { locale: 'en-US', timezone: 'America/New_York' };

    // ── Resolve Chromium binary path ──
    // 0) PUPPETEER_EXECUTABLE_PATH env var (set by render.yaml startCommand)
    // 1) Build-time .chromium-path file (set by render.yaml: find after npx playwright install)
    // 2) Filesystem scan of ms-playwright cache (runtime fallback)
    // 3) chromium.executablePath() (API fallback)
    // 4) Let Puppeteer auto-discover
    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    if (executablePath) {
      console.log(`[browser] Using PUPPETEER_EXECUTABLE_PATH env: ${executablePath}`);
    }

    if (!executablePath) {
      const chromiumPathFile = path.resolve('.chromium-path');
      try {
        if (fs.existsSync(chromiumPathFile)) {
          const cached = fs.readFileSync(chromiumPathFile, 'utf8').trim();
          if (cached && fs.existsSync(cached)) {
            executablePath = cached;
          }
        }
      } catch (_) {}
    }

    if (!executablePath) {
      const playwrightCacheDir = path.join(
        process.env.PLAYWRIGHT_BROWSERS_PATH ||
          (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')),
        'ms-playwright'
      );
      try {
        if (fs.existsSync(playwrightCacheDir)) {
          for (const entry of fs.readdirSync(playwrightCacheDir)) {
            if (!entry.startsWith('chromium') || entry.includes('headless')) continue;
            for (const sub of ['chrome-linux64', 'chrome-linux']) {
              const bin = path.join(playwrightCacheDir, entry, sub, 'chrome');
              if (fs.existsSync(bin)) { executablePath = bin; break; }
            }
            if (executablePath) break;
          }
        }
      } catch (e) { console.log(`[browser] Cache scan failed: ${e.message}`); }
    }

    if (!executablePath) {
      try {
        const pwPath = chromium.executablePath();
        if (pwPath && fs.existsSync(pwPath)) executablePath = pwPath;
      } catch (_) {}
    }

    if (!executablePath) {
      console.log('[browser] No Playwright chromium found — falling back to Puppeteer auto-discovery');
    } else {
      console.log(`[browser] Using Chromium at: ${executablePath}`);
    }

    const launchOptions = {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors',
        '--disable-features=IsolateOrigins,site-per-process,OptimizationHints,TranslateUI,MediaRouter,InterestFeedContentSuggestions,AutofillServerCommunication',
        '--disable-component-extensions-with-background-pages',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--disable-field-trial-config',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-domain-reliability',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--no-default-browser-check',
        '--no-pings',
        '--password-store=basic',
        '--use-mock-keychain',
        // ── CRITICAL anti-bot Chromium flags ──
        '--disable-blink-features=AutomationControlled',
        `--window-size=${device.viewport.w},${device.viewport.h}`,
        `--user-agent=${device.ua}`,
        `--lang=${locale}`,
        `--timezone=${timezone}`,
      ],
    };

    // Proxy via --proxy-server arg (puppeteer-extra supports this better)
    if (proxy) {
      const proxyUrl = new URL(proxy.server);
      let proxyArg = `--proxy-server=${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`;
      launchOptions.args.push(proxyArg);
    }

    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    // Full iOS device emulation: viewport + touch (matches selected device)
    await page.setViewport({
      width: device.viewport.w,
      height: device.viewport.h,
      deviceScaleFactor: device.viewport.dpr,
      isMobile: true,
      hasTouch: true,
    });

    // Override navigator + WebGL fingerprint to match the selected device profile
    const DEVICE_WEBGL_VENDOR = device.webglVendor;
    const DEVICE_WEBGL_RENDERER = device.webglRenderer;
    const DEVICE_PLATFORM = device.platform;
    const DEVICE_CONCURRENCY = device.concurrency;
    const DEVICE_MEMORY = device.deviceMem;
    const DEVICE_COLOR_DEPTH = device.colorDepth;
    const DEVICE_PIXEL_DEPTH = device.pixelDepth;

    await page.evaluateOnNewDocument((plat, concurrency, devMem, colorDepth, pixelDepth, webglVendor, webglRenderer, loc, locs) => {
      // ── Core navigator overrides ──
      Object.defineProperty(navigator, 'platform', { get: () => plat });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => concurrency });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => devMem });

      // ── Language: must match --lang flag and proxy country ──
      Object.defineProperty(navigator, 'language', { get: () => loc, configurable: true });
      Object.defineProperty(navigator, 'languages', { get: () => locs, configurable: true });

      // ── CRITICAL: kill the navigator.webdriver flag ──
      // This is THE single most detectable bot fingerprint.
      // Mobile Chrome does NOT expose this property, so delete it entirely.
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

      // ── navigator.userAgentData (Chrome 131+ high-entropy client hints) ──
      // Instagram checks brands to confirm "Google Chrome" not "Chromium"/"HeadlessChrome".
      // puppeteer-extra-plugin-stealth does NOT cover this API.
      try {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => ({
            brands: [
              { brand: 'Google Chrome', version: '131' },
              { brand: 'Chromium', version: '131' },
              { brand: 'Not?A_Brand', version: '24' },
            ],
            mobile: true,
            platform: 'iPhone',
            getHighEntropyValues: async (hints) => {
              const result = {};
              if (hints.includes('platform')) result.platform = 'iPhone';
              if (hints.includes('platformVersion')) result.platformVersion = '17.0';
              if (hints.includes('architecture')) result.architecture = '';
              if (hints.includes('model')) result.model = '';
              if (hints.includes('uaFullVersion')) result.uaFullVersion = '131.0.6778.135';
              if (hints.includes('bitness')) result.bitness = '64';
              if (hints.includes('fullVersionList')) {
                result.fullVersionList = [
                  { brand: 'Google Chrome', version: '131.0.6778.135' },
                  { brand: 'Chromium', version: '131.0.6778.135' },
                  { brand: 'Not?A_Brand', version: '24.0.0.0' },
                ];
              }
              return result;
            },
          }),
          configurable: true,
        });
      } catch (_) {}

      // ── Plugins & MIME types: mobile Chrome has zero visible plugins ──
      // Puppeteer exposes a plugin array that real mobile Chrome does not have.
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            const arr = [];
            arr.item = () => null;
            arr.namedItem = () => null;
            arr.refresh = () => {};
            return arr;
          },
          configurable: true,
        });
        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => {
            const arr = [];
            arr.item = () => null;
            arr.namedItem = () => null;
            return arr;
          },
          configurable: true,
        });
      } catch (_) {}

      // ── chrome.runtime: must not exist on mobile Chrome ──
      // Puppeteer sometimes exposes this even without extensions.
      try {
        if (typeof chrome !== 'undefined') {
          delete chrome.runtime;
        }
      } catch (_) {}

      // ── Permissions API: realistic mobile Chrome behavior ──
      try {
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = function(params) {
          if (params && params.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null });
          }
          return origQuery.call(window.navigator.permissions, params);
        };
      } catch (_) {}

      // ── WebGL fingerprint matching device profile ──
      try {
        const getParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
          if (param === 37445) return webglVendor;     // UNMASKED_VENDOR_WEBGL
          if (param === 37446) return webglRenderer;   // UNMASKED_RENDERER_WEBGL
          return getParam.call(this, param);
        };
      } catch (_) {}

      // ── Canvas 2D fingerprint randomization ──
      // Instagram uses canvas fingerprinting as a fallback bot detector.
      // We inject subtle per-session noise to break fingerprint consistency.
      try {
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const origToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toDataURL = function(type) {
          const ctx = this.getContext('2d', { willReadFrequently: true });
          if (ctx && this.width > 0 && this.height > 0) {
            try {
              const imgData = ctx.getImageData(0, 0, this.width, this.height);
              const data = imgData.data;
              const pixelCount = data.length / 4;
              const noisePixels = Math.max(1, Math.floor(pixelCount * 0.003));
              for (let i = 0; i < noisePixels; i++) {
                const idx = Math.floor(Math.random() * pixelCount) * 4;
                const noise = (Math.random() < 0.5) ? -1 : 1;
                for (let c = 0; c < 3; c++) {
                  const val = data[idx + c] + noise;
                  data[idx + c] = Math.max(0, Math.min(255, val));
                }
              }
              ctx.putImageData(imgData, 0, 0);
            } catch (_) {}
          }
          return origToDataURL.apply(this, arguments);
        };
        HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
          const ctx = this.getContext('2d', { willReadFrequently: true });
          if (ctx && this.width > 0 && this.height > 0) {
            try {
              const imgData = ctx.getImageData(0, 0, this.width, this.height);
              const data = imgData.data;
              const pixelCount = data.length / 4;
              const noisePixels = Math.max(1, Math.floor(pixelCount * 0.003));
              for (let i = 0; i < noisePixels; i++) {
                const idx = Math.floor(Math.random() * pixelCount) * 4;
                const noise = (Math.random() < 0.5) ? -1 : 1;
                for (let c = 0; c < 3; c++) {
                  const val = data[idx + c] + noise;
                  data[idx + c] = Math.max(0, Math.min(255, val));
                }
              }
              ctx.putImageData(imgData, 0, 0);
            } catch (_) {}
          }
          return origToBlob.apply(this, arguments);
        };
      } catch (_) {}

      // ── AudioContext fingerprint randomization ──
      try {
        const origCreateAnalyser = OfflineAudioContext.prototype.createAnalyser ||
                                   AudioContext.prototype.createAnalyser;
        if (origCreateAnalyser) {
          const baseProto = OfflineAudioContext.prototype.createAnalyser
            ? OfflineAudioContext.prototype
            : AudioContext.prototype;
          const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
          if (origGetFloatFreq) {
            AnalyserNode.prototype.getFloatFrequencyData = function(array) {
              origGetFloatFreq.apply(this, arguments);
              // Subtle audio fingerprint perturbation (inaudible)
              for (let i = 0; i < array.length; i++) {
                array[i] += (Math.random() - 0.5) * 0.0001;
              }
            };
          }
        }
      } catch (_) {}

      // ── Screen & color properties ──
      Object.defineProperty(screen, 'colorDepth', { get: () => colorDepth });
      Object.defineProperty(screen, 'pixelDepth', { get: () => pixelDepth });

      // ── window.outerWidth/outerHeight (mobile: matches viewport) ──
      // Puppeteer headless sometimes reports 800x600 outer, which is impossible on mobile.
      Object.defineProperty(window, 'outerWidth', { get: () => screen.width, configurable: true });
      Object.defineProperty(window, 'outerHeight', { get: () => screen.height, configurable: true });

      // ── Screen orientation (mobile devices ALWAYS report this) ──
      try {
        if (screen.orientation) {
          Object.defineProperty(screen.orientation, 'type', { get: () => 'portrait-primary', configurable: true });
          Object.defineProperty(screen.orientation, 'angle', { get: () => 0, configurable: true });
        }
      } catch (_) {}

      // ── Connection info (mobile network RTT jitter) ──
      try {
        if (navigator.connection) {
          const baseRtt = 50 + Math.floor(Math.random() * 100);
          Object.defineProperty(navigator.connection, 'rtt', {
            get: () => baseRtt + Math.floor(Math.random() * 20),
            configurable: true,
          });
        }
      } catch (_) {}
      // ── Battery API (real mobile Chrome exposes this) ──
      // Instagram can detect the ABSENCE of getBattery on mobile = bot.
      try {
        navigator.getBattery = () => Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 0.7 + Math.random() * 0.25,
          onchargingchange: null,
          onchargingtimechange: null,
          ondischargingtimechange: null,
          onlevelchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
        });
      } catch (_) {}
    }, DEVICE_PLATFORM, DEVICE_CONCURRENCY, DEVICE_MEMORY, DEVICE_COLOR_DEPTH, DEVICE_PIXEL_DEPTH, DEVICE_WEBGL_VENDOR, DEVICE_WEBGL_RENDERER, locale, [locale]);

    // Proxy authentication if needed (puppeteer authenticates per-page)
    if (proxy && proxy.username) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password || '',
      });
    }

    activeSession.browser = browser;
    activeSession.page = page;
    activeSession.email = email;
    activeSession.proxyInfo = proxy;
    activeSession.formData = { fullName, email, password, proxy: proxyInput };

    // ── Navigate to Instagram homepage first (looks more human) ──
    console.log('Navigating to Instagram homepage...');
    await page.goto('https://www.instagram.com/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
      referer: 'https://www.google.com/',
    });
    await delay(randomDelay(3000, 5000));

    // ── Anti-ban: Human-like browsing preamble ──
    // A fresh browser jumping straight to signup is a strong bot indicator.
    // Instagram tracks pre-signup behavior — scroll the feed, view posts.
    console.log('Simulating human browsing (feed scroll, post viewing)...');
    for (let scroll = 0; scroll < 3 + Math.floor(Math.random() * 3); scroll++) {
      const scrollY = 200 + Math.floor(Math.random() * 600);
      await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), scrollY);
      await delay(randomDelay(2000, 6000));
    }
    // Occasionally scroll back up (real users do this)
    if (Math.random() < 0.5) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await delay(randomDelay(1500, 3000));
    }
    console.log('Browsing preamble complete.');

    // Dismiss cookie banner on homepage
    try {
      const cookieBtn = await page.$('button');
      if (cookieBtn) {
        const text = await page.evaluate(el => el.textContent, cookieBtn);
        if (text && /allow all cookies|accept/i.test(text)) {
          await cookieBtn.click();
          console.log('Dismissed cookie banner');
          await delay(randomDelay(1000, 2000));
        }
      }
    } catch {}

    // Scroll the homepage slightly (human-like behavior)
    await page.evaluate(() => window.scrollBy(0, 300));
    await delay(randomDelay(500, 1500));

    // Now navigate to the signup page
    console.log('Navigating to Instagram signup...');
    await page.goto('https://www.instagram.com/accounts/emailsignup/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
      referer: 'https://www.instagram.com/',
    });

    // Extra settling time for dynamic SPA rendering
    await delay(randomDelay(5000, 9000));

    // Scroll to ensure form triggers lazy rendering
    await page.evaluate(() => window.scrollBy(0, 200));
    await delay(randomDelay(1000, 2500));

    // Check if we actually landed on the signup page
    const currentUrl = page.url();
    console.log('Landed on URL:', currentUrl);

    // Dump page title and body snippet for debugging
    try {
      const title = await page.title();
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
      console.log('Page title:', title);
      console.log('Body text (first 500 chars):', bodyText);
    } catch (e) {
      console.log('Could not dump page info:', e.message);
    }

    // Screenshot + full DOM dump on initial load
    await screenshot(page, 'initial_page_load');
    await dumpAllInputs();

    if (currentUrl.includes('/challenge') || currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
      await screenshot(page, 'redirected_blocked');
      const igErr = await _scrapeInstagramError(page);
      return {
        success: false,
        message: igErr
          ? `❌ Instagram blocked this session.\n\nInstagram says: "${igErr}"\n\nTry a different proxy country or /noproxy.`
          : '❌ Instagram redirected away from signup (possible proxy block or rate limit).\n\nTry a different proxy country or /noproxy.',
      };
    }

    // iOS UA may redirect emailsignup/ → signup/phone/ (phone-first flow).
    // Click "Sign up with email" to switch to email-based signup.
    if (currentUrl.includes('/signup/phone') || currentUrl.includes('/signup')) {
      console.log('Phone-first signup detected. Looking for "Sign up with email" link...');
      // Try to find and click "Sign up with email" text
      const emailLink = await findClickableByText(/sign\s*up\s*with\s*email|use\s*email|email\s*instead/i);
      if (emailLink) {
        console.log('Clicking "Sign up with email"...');
        await delay(randomDelay(800, 2500));
        await emailLink.click({ delay: randomDelay(200, 500) });
        await delay(randomDelay(5000, 10000));
        console.log('After email switch - URL:', page.url());
        await dumpAllInputs();
        await screenshot(page, 'after_email_switch');
      } else {
        // Fallback: try clicking any link/button containing "email" or "Email"
        // Use evaluate to find index, then re-query fresh to avoid cross-context errors.
        const emailLinkMarker = await page.evaluate(() => {
          const all = document.querySelectorAll('a, button, span, div[role="button"], div[tabindex]');
          for (let i = 0; i < all.length; i++) {
            const el = all[i];
            const text = (el.textContent || '').trim();
            const rect = el.getBoundingClientRect();
            if (rect.width < 20) continue;
            if (/email/i.test(text) && text.length < 30) return { idx: i, text };
          }
          return null;
        }).catch(() => null);
        if (emailLinkMarker && emailLinkMarker.idx !== undefined) {
          const freshLinks = await page.$$('a, button, span, div[role="button"], div[tabindex]');
          if (emailLinkMarker.idx < freshLinks.length) {
            try {
              const link = freshLinks[emailLinkMarker.idx];
              console.log(`Clicking element with text: "${emailLinkMarker.text}"`);
              await delay(randomDelay(800, 2500));
              await link.click({ delay: randomDelay(200, 500) });
              await delay(randomDelay(5000, 10000));
              console.log('After email link click - URL:', page.url());
              await dumpAllInputs();
              await screenshot(page, 'after_email_link_click');
            } catch (ctxErr) {
              console.log(`  [emailLinkFallback] context error: ${ctxErr.message?.slice(0,80)}`);
            }
          }
        }
      }
    }

    // Cookie dialog (may appear on signup page too)
    try {
      const cookieMarker = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (let i = 0; i < buttons.length; i++) {
          const text = (buttons[i].textContent || '').trim();
          if (/accept|allow all cookies/i.test(text) && buttons[i].offsetParent !== null) {
            return { idx: i };
          }
        }
        return null;
      }).catch(() => null);
      if (cookieMarker && cookieMarker.idx !== undefined) {
        const freshBtns = await page.$$('button');
        if (cookieMarker.idx < freshBtns.length) {
          await freshBtns[cookieMarker.idx].click().catch(() => {});
          await delay(1500);
        }
      }
    } catch {}

    // ── Instagram signup: React-based lazy rendering
    //     Fields appear only when previous ones are filled (React onChange).
    //     Puppeteer's .type() does NOT fire React onChange reliably, so we
    //     use evaluate() to set value + dispatch input/change events.
    //     After each field we wait and rescan for newly-rendered fields.
    //     Buttons may be <div>, <span>, etc. – search all clickables. ──

    // --- Helper: fill an input field AND fire React-compatible events ---
    // Anti-ban: realistic human typing speed (80-260ms per char) + pre-click pauses
    async function reactType(el, value, { delayMs = 100 } = {}) {
      // Random pre-click pause — simulate human reading before typing
      await delay(randomDelay(500, 2000));
      // Click to focus (with context error protection)
      try {
        await el.click({ clickCount: 3 });
        await delay(150);
        // Clear existing value via evaluate
        await el.evaluate(input => { input.value = ''; });
      } catch (ctxErr) {
        console.log(`  [reactType] context error during click/clear: ${ctxErr.message?.slice(0,80)}`);
        return; // Can't type if handle is stale
      }
      // Human-like pause before starting to type
      await delay(randomDelay(300, 1200));
      // Type character by character with keyboard (triggers React onChange)
      // Anti-ban: slower, more variable typing speed
      try {
        await el.focus();
      } catch { /* focus may fail on stale handle, keyboard.type still works on page */ }
      for (const ch of String(value)) {
        await page.keyboard.type(ch, { delay: 80 + Math.random() * 180 });
      }
      await delay(delayMs);
      // Dispatch explicit events for React to process
      try {
        await el.evaluate(input => {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } catch (ctxErr) {
        console.log(`  [reactType] context error dispatching React events: ${ctxErr.message?.slice(0,80)}`);
      }
      // Tab out to trigger blur (triggers React validation/next-field reveal)
      await page.keyboard.press('Tab');
      await delay(randomDelay(500, 1000));
    }

    // --- Helper: select dropdown option AND fire React events ---
    async function reactSelect(el, optionValue) {
      try {
        await el.evaluate((select, val) => {
          select.value = val;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }, optionValue);
      } catch (ctxErr) {
        console.log(`  [reactSelect] context error (ignored): ${ctxErr.message?.slice(0,80)}`);
      }
      await delay(randomDelay(200, 500));
    }

    // --- Helper: find visible input by type, optionally nth match ---
    async function findInputByType(type, nth = 0) {
      // Use evaluate to find the index of the matching element in the full input list,
      // then re-query with fresh $$() to avoid cross-context JS world errors.
      const selector = type === 'text'
        ? `input[type="text"], input:not([type]):not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="email"]):not([type="tel"]):not([type="search"])`
        : `input[type="${type}"]`;
      const marker = await page.evaluate(({ sel, nth }) => {
        const all = document.querySelectorAll(sel);
        let count = 0;
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.offsetParent !== null) {
            if (count === nth) return { idx: i };
            count++;
          }
        }
        return null;
      }, { sel: selector, nth }).catch(() => null);
      if (marker && marker.idx !== undefined) {
        const freshAll = await page.$$('input');
        if (marker.idx < freshAll.length) {
          try {
            const box = await freshAll[marker.idx].boundingBox().catch(() => null);
            if (box) return freshAll[marker.idx];
          } catch (ctxErr) {
            console.log(`  [findInputByType] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      return null;
    }

    // --- Helper: find visible input by aria-label or autocomplete hint ---
    async function findInputByHint(hints) {
      // Use evaluate to find the index, then re-query with fresh $$() to avoid
      // cross-context JS world errors from Instagram captcha iframe injection.
      const marker = await page.evaluate((hints) => {
        const all = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.offsetParent === null) continue;
          const auto = (el.autocomplete || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const combined = auto + ' ' + aria;
          if (hints.some(h => combined.includes(h))) return { idx: i };
        }
        return null;
      }, hints).catch(() => null);
      if (marker && marker.idx !== undefined) {
        const freshAll = await page.$$('input:not([type="hidden"]):not([type="submit"])');
        if (marker.idx < freshAll.length) {
          try {
            const box = await freshAll[marker.idx].boundingBox().catch(() => null);
            if (box) return freshAll[marker.idx];
          } catch (ctxErr) {
            console.log(`  [findInputByHint] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      return null;
    }

    // --- Helper: find ANY clickable by text regex ---
    async function findClickableByText(pattern) {
      // Use evaluate to find the index in the full selector list, then re-query
      // with fresh $$() to avoid cross-context JS world errors.
      const selectors = 'button, [role="button"], input[type="submit"], a, span, div[tabindex="0"], div[tabindex]';
      const marker = await page.evaluate(({ sel, src }) => {
        const all = document.querySelectorAll(sel);
        const regex = new RegExp(src);
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          const rect = el.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) continue;
          const text = (el.textContent || el.value || el.getAttribute('aria-label') || '');
          if (text && regex.test(text)) return { idx: i };
        }
        return null;
      }, { sel: selectors, src: pattern.source }).catch(() => null);
      if (marker && marker.idx !== undefined) {
        const freshAll = await page.$$(selectors);
        if (marker.idx < freshAll.length) {
          try {
            const box = await freshAll[marker.idx].boundingBox().catch(() => null);
            if (box && box.width >= 20 && box.height >= 20) return freshAll[marker.idx];
          } catch (ctxErr) {
            console.log(`  [findClickableByText] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      return null;
    }

    // --- Debug helpers ---
    async function dumpInputs() {
      // Collect all data in a single page.evaluate() to avoid cross-context
      // JS world errors from Instagram captcha iframe injection.
      const visible = await page.evaluate(() => {
        const all = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="search"])');
        const out = [];
        for (const inp of all) {
          const rect = inp.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            out.push({
              type: inp.type,
              autocomplete: inp.autocomplete,
              ariaLabel: inp.getAttribute('aria-label'),
            });
          }
        }
        return out;
      }).catch((err) => {
        console.log(`  [dumpInputs] evaluate failed: ${err.message?.slice(0, 80)}`);
        return [];
      });
      console.log(`Visible inputs (${visible.length}):`, JSON.stringify(visible));
    }
    async function dumpSelects() {
      const vis = await page.evaluate(() => {
        const all = document.querySelectorAll('select');
        let count = 0;
        for (const s of all) {
          const rect = s.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) count++;
        }
        return count;
      }).catch((err) => {
        console.log(`  [dumpSelects] evaluate failed: ${err.message?.slice(0, 80)}`);
        return 0;
      });
      console.log(`Visible selects: ${vis}`);
    }
    async function dumpClickables() {
      const items = await page.evaluate(() => {
        const all = document.querySelectorAll('button, [role="button"], input[type="submit"]');
        const out = [];
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const text = (el.textContent || el.value || '').trim().slice(0, 40);
          if (text) out.push({ tag: el.tagName.toLowerCase(), text });
        }
        return out;
      }).catch((err) => {
        console.log(`  [dumpClickables] evaluate failed: ${err.message?.slice(0, 80)}`);
        return [];
      });
      for (const { tag, text } of items) {
        console.log(`  [${tag}] "${text}"`);
      }
    }
    // Thin wrapper — delegates to the module-level _dumpAllInputs(page)
    async function dumpAllInputs() { await _dumpAllInputs(page); }

    // --- Wait for initial form render ---
    // Mobile/iOS modes may use input[type="tel"] (phone) or input[type="email"] (email switch)
    console.log('Waiting for signup form...');
    try {
      await page.waitForSelector('input[type="text"], input[type="tel"], input[type="email"]', { visible: true, timeout: 25000 });
    } catch {
      await screenshot(page, 'signup_form_not_found');
      const igErrForm = await _scrapeInstagramError(page);
      return { success: false, message: igErrForm ? `❌ Signup form did not appear.\n\nInstagram says: "${igErrForm}"` : '❌ Signup form did not appear.' };
    }
    await dumpInputs();
    await dumpSelects();
    await dumpClickables();
    await screenshot(page, 'form_detected');

    // Detect: multi-step vs single-page
    let isMultiStep = false;
    let nextBtn = await findClickableByText(/^\s*Next\s*$/i);
    if (nextBtn) {
      isMultiStep = true;
      console.log('Detected MULTI-STEP wizard');
    } else {
      console.log('Detected SINGLE-PAGE form');
    }

    // ═══════════════════════════════════════════
    // FIELD 1: Email (always present on load, but type varies: text/email/tel)
    // ═══════════════════════════════════════════
    console.log('Filling email...');
    let emailInput = await findInputByType('email', 0)
      || await findInputByHint(['email', 'e-mail', 'email address'])
      || await findInputByType('text', 0)
      || await findInputByType('tel', 0);
    if (!emailInput) {
      // Last resort: use evaluate to find first visible non-password input index,
      // then re-query with fresh $$() to avoid cross-context JS world errors.
      const emailMarker = await page.evaluate(() => {
        const all = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="password"])');
        for (let i = 0; i < all.length; i++) {
          if (all[i].offsetParent !== null) return { idx: i };
        }
        return null;
      }).catch(() => null);
      if (emailMarker && emailMarker.idx !== undefined) {
        const freshAll = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="password"])');
        if (emailMarker.idx < freshAll.length) {
          try {
            const box = await freshAll[emailMarker.idx].boundingBox().catch(() => null);
            if (box) emailInput = freshAll[emailMarker.idx];
          } catch (ctxErr) {
            console.log(`  [emailFallback] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
    }
    if (!emailInput) {
      return { success: false, message: '❌ Email input not found.' };
    }
    await reactType(emailInput, email, { delayMs: 800 });
    console.log('After email fill:');
    await dumpInputs();
    await screenshot(page, 'after_email');

    if (isMultiStep) {
      const beforeNextUrl = page.url().replace(/#.*$/, '');
      console.log('Clicking Next...');
      await delay(randomDelay(800, 2500));
      await nextBtn.click({ delay: randomDelay(200, 500) });
      await delay(randomDelay(5000, 10000));
      const afterNextUrl = page.url().replace(/#.*$/, '');
      console.log('After Next - URL:', afterNextUrl);
      await dumpInputs();
      await dumpSelects();
      await dumpClickables();
      await dumpAllInputs();
      await screenshot(page, 'after_email_next');

      // Detect email confirmation code step (iOS mobile wizard)
      // Instagram sends a confirmation code to email BEFORE showing password/name fields
      const foundCodeInput = await page.evaluate(() => {
        const all = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])');
        for (const el of all) {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const autocomplete = (el.autocomplete || '').toLowerCase();
          if (aria.includes('confirmation code') || aria.includes('code') || autocomplete.includes('code')) {
            return true;
          }
        }
        return false;
      }).catch(() => false);
      if (foundCodeInput) {
        console.log('Email confirmation code step detected!');
        await screenshot(page, 'email_code_required');
        return {
          success: true,
          step: 'email_code_required',
          message: '📧 Instagram sent a confirmation code to your email.\n\nCheck your inbox (and spam folder), then send me the 6-digit code.',
        };
      }

      // If URL didn't change and no confirmation code appeared, Instagram likely rejected the email
      if (beforeNextUrl === afterNextUrl) {
        const igErrEmailNext = await _scrapeInstagramError(page);
        if (igErrEmailNext) {
          console.log('Instagram error detected on email screen:', igErrEmailNext);
          await screenshot(page, 'email_rejected');
          return {
            success: false,
            message: `❌ Instagram rejected this step.\n\nInstagram says: "${igErrEmailNext}"\n\nTry a different email address or proxy.`,
          };
        }
      }
    } else {
      // Scroll to trigger lazy sections
      await page.evaluate(() => window.scrollBy(0, 600));
      await delay(1500);
      await dumpInputs();
      await dumpSelects();
      await dumpAllInputs();
      await screenshot(page, 'after_email_singlepage');
    }

    // ═══════════════════════════════════════════
    // FIELD 2: Password
    // ═══════════════════════════════════════════
    console.log('Filling password...');
    let passInput = await page.$('input[type="password"]');
    // Wait up to 5s if password field not yet rendered
    for (let retry = 0; retry < 10 && !passInput; retry++) {
      await delay(1000);
      passInput = await page.$('input[type="password"]');
    }
    if (!passInput) {
      const igErrPass = await _scrapeInstagramError(page);
      return { success: false, message: igErrPass ? `❌ Password field not found.\n\nInstagram says: "${igErrPass}"` : '❌ Password field not found.' };
    }
    await reactType(passInput, password, { delayMs: 600 });
    console.log('After password fill:');
    await dumpInputs();
    await screenshot(page, 'after_password');

    // ═══════════════════════════════════════════
    // FIELD 3: Full Name (new input should appear)
    // ═══════════════════════════════════════════
    console.log('Filling name...');
    // Wait for a new text input that isn't the email field
    let nameInput = null;
    for (let retry = 0; retry < 12; retry++) {
      const nameMarker = await page.evaluate(() => {
        const allText = document.querySelectorAll('input[type="text"]');
        for (let i = 0; i < allText.length; i++) {
          const el = allText[i];
          if (el.offsetParent === null) continue;
          const val = el.value;
          if (val && val.includes('@')) continue;
          return { idx: i };
        }
        return null;
      }).catch(() => null);
      if (nameMarker && nameMarker.idx !== undefined) {
        const freshAll = await page.$$('input[type="text"]');
        if (nameMarker.idx < freshAll.length) {
          try {
            const box = await freshAll[nameMarker.idx].boundingBox().catch(() => null);
            if (box) {
              nameInput = freshAll[nameMarker.idx];
              break;
            }
          } catch (ctxErr) {
            console.log(`  [nameInput] context error at retry ${retry}: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      await delay(1000);
      await dumpInputs();
    }
    if (nameInput) {
      await reactType(nameInput, fullName, { delayMs: 600 });
      console.log('After name fill:');
      await dumpInputs();
      await dumpAllInputs();
      await screenshot(page, 'after_name');
    } else {
      console.log('Name field never appeared, continuing...');
      await screenshot(page, 'name_field_missing');
    }

    // ═══════════════════════════════════════════
    // FIELD 4: Username (should appear after name)
    // ═══════════════════════════════════════════
    console.log('Filling username...');
    const usernameBase = fullName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    const usernameSuffix = Math.floor(Math.random() * 9999);
    const generatedUsername = `${usernameBase}_${usernameSuffix}`;
    let usernameInput = null;
    // Instagram uses type="search" for username on simplified forms
    for (let retry = 0; retry < 12; retry++) {
      const userMarker = await page.evaluate((fullName) => {
        const all = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]):not([type="password"]):not([type="hidden"]):not([type="submit"])');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.offsetParent === null) continue;
          const val = el.value;
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const autoc = (el.autocomplete || '').toLowerCase();
          if (val && val.includes('@')) continue;
          if (aria.includes('username') || autoc.includes('username')) return { idx: i, aria };
          if (val && val === fullName) continue;
          return { idx: i };
        }
        return null;
      }, fullName).catch(() => null);
      if (userMarker && userMarker.idx !== undefined) {
        const freshAll = await page.$$('input[type="text"], input[type="search"], input:not([type]):not([type="password"]):not([type="hidden"]):not([type="submit"])');
        if (userMarker.idx < freshAll.length) {
          try {
            const box = await freshAll[userMarker.idx].boundingBox().catch(() => null);
            if (box) {
              usernameInput = freshAll[userMarker.idx];
              console.log('Found username input via aria-label/autocomplete');
              break;
            }
          } catch (ctxErr) {
            console.log(`  [usernameInput] context error at retry ${retry}: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      await delay(1000);
      await dumpInputs();
    }
    if (usernameInput) {
      await reactType(usernameInput, generatedUsername, { delayMs: 600 });
      console.log('Username:', generatedUsername);
      console.log('After username fill:');
      await dumpInputs();
      await dumpAllInputs();
      await screenshot(page, 'after_username');
    } else {
      console.log('Username field never appeared, skipping...');
      await screenshot(page, 'username_field_missing');
    }

    // ═══════════════════════════════════════════
    // Shared helper: click-based custom dropdown (for mobile fallback too)
    // ═══════════════════════════════════════════
    async function clickCustomSelect(labelText, optionText) {
      // Step 1: Find and click the label to open dropdown
      // Use evaluate to avoid cross-context JS world errors.
      const labelMarker = await page.evaluate((labelText) => {
        const all = document.querySelectorAll('span, div[role="button"], [tabindex]');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          const text = (el.textContent || '').trim();
          if (text === labelText) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 200 && rect.height < 60) return { idx: i };
          }
        }
        return null;
      }, labelText).catch(() => null);
      if (labelMarker && labelMarker.idx !== undefined) {
        const freshSpans = await page.$$('span, div[role="button"], [tabindex]');
        if (labelMarker.idx < freshSpans.length) {
          try {
            const box = await freshSpans[labelMarker.idx].boundingBox().catch(() => null);
            if (box) {
              console.log(`    Clicking "${labelText}" label to open dropdown`);
              await freshSpans[labelMarker.idx].click({ delay: randomDelay(50, 150) });
              await delay(800);
            }
          } catch (ctxErr) {
            console.log(`    [clickCustomSelect label] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      // Step 2: Find and click the option in the now-open dropdown
      const optMarker = await page.evaluate((optionText) => {
        const all = document.querySelectorAll('span, div, [role="option"], [role="menuitem"], li');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          const text = (el.textContent || '').trim();
          if (text === optionText && el.offsetParent !== null) return { idx: i };
        }
        return null;
      }, optionText).catch(() => null);
      if (optMarker && optMarker.idx !== undefined) {
        const freshOpts = await page.$$('span, div, [role="option"], [role="menuitem"], li');
        if (optMarker.idx < freshOpts.length) {
          try {
            const box = await freshOpts[optMarker.idx].boundingBox().catch(() => null);
            if (box) {
              console.log(`    Selecting "${optionText}"`);
              await freshOpts[optMarker.idx].click({ delay: randomDelay(50, 150) });
              await delay(600);
              return true;
            }
          } catch (ctxErr) {
            console.log(`    [clickCustomSelect option] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      return false;
    }

    // ═══════════════════════════════════════════
    // FIELD 5: Birthday (3 select dropdowns) — with fallback injection
    // ═══════════════════════════════════════════
    console.log('Setting birthday...');
    await dumpSelects();
    await dumpAllInputs();
    await screenshot(page, 'before_birthday');
    const now = new Date();
    const age = Math.floor(Math.random() * 23) + 20; // age 20-42, always >19
    const birthYear = now.getFullYear() - age;
    const birthMonth = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    const birthDayVal = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');

    // Strategy 1: Click "Birthday" label/area to trigger React rendering
    // Use a more targeted approach — look for small elements whose ONLY text is "Birthday"
    let birthdayClicked = false;
    try {
      // Search LABEL first (most specific), then SPAN
      // Use evaluate to find index, then re-query fresh to avoid cross-context errors.
      const bdayLabelMarker = await page.evaluate(() => {
        const candidates = document.querySelectorAll('label, span');
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i];
          const text = (el.textContent || '').trim();
          if ((text === 'Birthday' || /^Birthday$/i.test(text)) && el.offsetParent !== null) {
            return { idx: i, text };
          }
        }
        return null;
      }).catch(() => null);
      if (bdayLabelMarker && bdayLabelMarker.idx !== undefined) {
        const freshCandidates = await page.$$('label, span');
        if (bdayLabelMarker.idx < freshCandidates.length) {
          try {
            const box = await freshCandidates[bdayLabelMarker.idx].boundingBox().catch(() => null);
            if (box) {
              console.log(`  Clicking birthday label: "${bdayLabelMarker.text}" at (${Math.round(box.x)},${Math.round(box.y)})`);
              await freshCandidates[bdayLabelMarker.idx].click({ delay: randomDelay(80, 200) });
              await delay(1500);
              birthdayClicked = true;
            }
          } catch (ctxErr) {
            console.log(`  [birthday label] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      if (!birthdayClicked) {
        // Fallback: look for small div with "Birthday" text only (not page-level)
        const bdayDivMarker = await page.evaluate(() => {
          const divs = document.querySelectorAll('div');
          for (let i = 0; i < divs.length; i++) {
            const el = divs[i];
            const text = (el.textContent || '').trim();
            if (text === 'Birthday' && el.querySelector('select,input')) {
              if (el.offsetParent !== null) return { idx: i };
            }
          }
          return null;
        }).catch(() => null);
        if (bdayDivMarker && bdayDivMarker.idx !== undefined) {
          const freshDivs = await page.$$('div');
          if (bdayDivMarker.idx < freshDivs.length) {
            try {
              const box = await freshDivs[bdayDivMarker.idx].boundingBox().catch(() => null);
              if (box) {
                console.log(`  Clicking birthday wrapper div`);
                await freshDivs[bdayDivMarker.idx].click({ delay: randomDelay(80, 200) });
                await delay(1500);
                birthdayClicked = true;
              }
            } catch (ctxErr) {
              console.log(`  [birthday div] context error: ${ctxErr.message?.slice(0,80)}`);
            }
          }
        }
      }
    } catch (e) {
      console.log(`  Birthday click attempt failed: ${e.message}`);
    }

    // Wait for 3 visible birthday selects (filtering out language switcher)
    let selectsReady = [];
    for (let retry = 0; retry < 12; retry++) {
      // Use evaluate to collect indices of valid selects, then re-query fresh.
      const selMarkers = await page.evaluate(() => {
        const allSel = document.querySelectorAll('select');
        const indices = [];
        for (let i = 0; i < allSel.length; i++) {
          const s = allSel[i];
          const rect = s.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const aria = (s.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('language') || aria.includes('switch')) continue;
          indices.push(i);
        }
        return indices;
      }).catch(() => []);
      if (selMarkers.length >= 3) {
        const freshAll = await page.$$('select');
        for (const idx of selMarkers.slice(0, 3)) {
          if (idx < freshAll.length) {
            try {
              const box = await freshAll[idx].boundingBox().catch(() => null);
              if (box) selectsReady.push(freshAll[idx]);
            } catch (ctxErr) {
              console.log(`  [birthday selects] context error at retry ${retry}: ${ctxErr.message?.slice(0,80)}`);
            }
          }
        }
        if (selectsReady.length >= 3) break;
        selectsReady = [];
      }
      console.log(`  Waiting for birthday selects... (${selMarkers.length}/3 visible, language filtered)`);
      await page.evaluate(() => window.scrollBy(0, 300));
      await delay(1500);
    }
    console.log(`  Birthday selects ready: ${selectsReady.length}`);

    if (selectsReady.length >= 3) {
      // Month select first, then Day, then Year (Instagram order)
      console.log(`Selecting: Month=${birthMonth}, Day=${birthDayVal}, Year=${birthYear}`);
      await reactSelect(selectsReady[0], String(parseInt(birthMonth, 10)));
      await delay(400);
      await reactSelect(selectsReady[1], String(parseInt(birthDayVal, 10)));
      await delay(400);
      await reactSelect(selectsReady[2], String(birthYear));
      await delay(600);
      console.log(`Birthday set via selects: ${birthYear}-${birthMonth}-${birthDayVal} (age ${age})`);
    } else {
      // Strategy 2: Instagram uses custom div-based dropdowns, not native <select>
      // The body text reveals: "Birthday Month Day Year" followed by option values
      // Click each label ("Month", "Day", "Year") then click the option from the dropdown
      console.log(`No native selects found. Using click-based dropdown interaction...`);

      const months = ['January','February','March','April','May','June','July',
                      'August','September','October','November','December'];
      const monthText = months[parseInt(birthMonth, 10) - 1];

      const monthOk = await clickCustomSelect('Month', monthText);
      const dayOk = await clickCustomSelect('Day', birthDayVal);
      const yearOk = await clickCustomSelect('Year', String(birthYear));

      console.log(`  Dropdown results: Month=${monthOk}, Day=${dayOk}, Year=${yearOk}`);

      // Fallback: If dropdown clicks didn't work, use keyboard Tab + type
      if (!monthOk || !dayOk || !yearOk) {
        console.log('  Dropdown clicks incomplete. Trying keyboard Tab + type approach...');
        // Tab to reach the birthday fields (they come after username)
        // Count how many Tabs needed by tabbing from current position
        // First, click on the username input which is the last known field
        let usernameClicked = false;
        const unameMarker = await page.evaluate(() => {
          const all = document.querySelectorAll('input[aria-label="Username"], input[type="search"]');
          for (let i = all.length - 1; i >= 0; i--) {
            if (all[i].offsetParent !== null) return { idx: i, total: all.length };
          }
          return null;
        }).catch(() => null);
        if (unameMarker && unameMarker.idx !== undefined) {
          const freshAll = await page.$$('input[aria-label="Username"], input[type="search"]');
          if (unameMarker.idx < freshAll.length) {
            try {
              await freshAll[unameMarker.idx].click({ delay: 100 });
              await delay(300);
              usernameClicked = true;
            } catch (ctxErr) {
              console.log(`  [birthday tab uname] context error: ${ctxErr.message?.slice(0,80)}`);
            }
          }
        }
        // Fallback: use original $$ approach for any remaining clickables
        if (!usernameClicked) {
          const usernameInputs = await page.$$('input[aria-label="Username"], input[type="search"]');
          if (usernameInputs.length > 0) {
            try {
              await usernameInputs[usernameInputs.length - 1].click({ delay: 100 });
              await delay(300);
            } catch (ctxErr) {
              console.log(`  [birthday tab uname fallback] context error: ${ctxErr.message?.slice(0,80)}`);
            }
          }
        }
        // Tab through: username -> (maybe something) -> Month -> Day -> Year
        // Instagram's tab order after username: Month select, Day select, Year select
        for (let tab = 0; tab < 4; tab++) {
          await page.keyboard.press('Tab');
          await delay(400);
        }
        // Now type the month number
        await page.keyboard.type(parseInt(birthMonth, 10).toString(), { delay: 100 });
        await delay(400);
        await page.keyboard.press('Tab');
        await delay(400);
        // Type the day
        await page.keyboard.type(parseInt(birthDayVal, 10).toString(), { delay: 100 });
        await delay(400);
        await page.keyboard.press('Tab');
        await delay(400);
        // Type the year
        await page.keyboard.type(String(birthYear), { delay: 100 });
        await delay(600);
        console.log('  Keyboard tab-type birthday attempt complete');
      }

      console.log(`Birthday set: ${birthYear}-${birthMonth}-${birthDayVal} (age ${age})`);
      await dumpAllInputs();
    }
    await screenshot(page, 'after_birthday');

    // ═══════════════════════════════════════════
    // SUBMIT
    // ═══════════════════════════════════════════
    console.log('Clicking Submit...');
    let submitBtn = await findClickableByText(/submit|sign\s*up|create\s*account/i);
    if (!submitBtn) {
      submitBtn = await findClickableByText(/next/i);
    }
    if (!submitBtn) {
      // Use evaluate to find last visible clickable index, then re-query fresh.
      const submitMarker = await page.evaluate(() => {
        const all = document.querySelectorAll('button, [role="button"], input[type="submit"]');
        for (let i = all.length - 1; i >= 0; i--) {
          if (all[i].offsetParent !== null) return { idx: i };
        }
        return null;
      }).catch(() => null);
      if (submitMarker && submitMarker.idx !== undefined) {
        const freshAll = await page.$$('button, [role="button"], input[type="submit"]');
        if (submitMarker.idx < freshAll.length) {
          try {
            const box = await freshAll[submitMarker.idx].boundingBox().catch(() => null);
            if (box) {
              submitBtn = freshAll[submitMarker.idx];
              console.log('Fallback: last visible clickable');
            }
          } catch (ctxErr) {
            console.log(`  [submitFallback] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
    }
    if (submitBtn) {
      await screenshot(page, 'before_submit');

      // ── Anti-ban: Pre-submit hesitation + touch jitter ──
      // Real users hesitate before the final "I agree" click (reading terms).
      // Randomly wait 3-8 seconds, then add touch micro-movements (finger tremor).
      console.log('Pre-submit hesitation (simulating terms reading)...');
      await delay(randomDelay(3000, 8000));

      // ── CRITICAL: Touch events for mobile Chrome realism ──
      // page.mouse.click() on a hasTouch emulation = instant bot flag.
      console.log('Tapping submit with touch events...');
      try {
        const btnBox = await submitBtn.boundingBox().catch(() => null);
        if (btnBox) {
          const jx = btnBox.x + btnBox.width * (0.2 + Math.random() * 0.6);
          const jy = btnBox.y + btnBox.height * (0.2 + Math.random() * 0.6);
          await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return;
            el.dispatchEvent(new TouchEvent('touchstart', {
              bubbles: true, cancelable: true,
              touches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
              targetTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
              changedTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
            }));
            setTimeout(() => {
              el.dispatchEvent(new TouchEvent('touchend', {
                bubbles: true, cancelable: true,
                touches: [], targetTouches: [],
                changedTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0 })],
              }));
              el.click();
            }, 80 + Math.random() * 150);
          }, { x: jx, y: jy });
          await delay(300);
        } else {
          await submitBtn.click({ delay: randomDelay(200, 500) });
        }
      } catch (clickErr) {
        if (/callFunctionOn|detached|stale|context/i.test(clickErr.message || '')) {
          console.log('submitBtn stale - re-finding in page context...');
          await page.evaluate(() => {
            const all = document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex]');
            for (const el of all) {
              const t = (el.textContent || '').trim();
              if (/agree|submit|sign\s*up|create/i.test(t) && el.offsetParent !== null) {
                el.click();
                return;
              }
            }
            for (let i = all.length - 1; i >= 0; i--) {
              if (all[i].offsetParent) { all[i].click(); return; }
            }
          });
        } else {
          throw clickErr;
        }
      }
    } else {
      await screenshot(page, 'submit_button_not_found');
      return { success: false, message: '❌ Submit button not found.' };
    }
    await delay(randomDelay(5000, 12000));
    console.log('After Submit - URL:', page.url());
    await dumpAllInputs();
    await screenshot(page, 'after_submit');

    // ── OTP check (no-name inputs) ──
    try {
      // Search all visible inputs for OTP hints (autocomplete / aria-label)
      // Use evaluate to find index, then re-query fresh to avoid cross-context errors.
      const otpMarker = await page.evaluate(() => {
        const all = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.offsetParent === null) continue;
          const autocomplete = (el.autocomplete || '').toLowerCase();
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const combined = autocomplete + ' ' + ariaLabel;
          if (/confirmation|code|otp|verification|one.time/i.test(combined)) {
            return { idx: i };
          }
        }
        return null;
      }).catch(() => null);
      let codeInput = null;
      if (otpMarker && otpMarker.idx !== undefined) {
        const freshInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
        if (otpMarker.idx < freshInputs.length) {
          try {
            const box = await freshInputs[otpMarker.idx].boundingBox().catch(() => null);
            if (box) codeInput = freshInputs[otpMarker.idx];
          } catch (ctxErr) {
            console.log(`  [otpDetection] context error: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      if (codeInput) {
        await screenshot(page, 'otp_required');
        return {
          success: true,
          step: 'otp_required',
          message: '✅ Form filled and submitted!\n\n📧 OTP sent to your email.\n\nSend me the 6-digit code when you receive it.',
        };
      }
      // Also check for 6 individual digit inputs (split OTP)
      const singleDigitInputs = await page.$$('input[maxlength="1"]');
      if (singleDigitInputs.length >= 6) {
        await screenshot(page, 'otp_required_split');
        return {
          success: true,
          step: 'otp_required',
          message: '✅ Form filled and submitted!\n\n📧 OTP sent to your email.\n\nSend me the 6-digit code when you receive it.',
        };
      }
    } catch {}

    // Check for error messages — scan broadly for any visible error/alert
    try {
      // Narrow selector set — avoid giant wrapper divs that contain all page content
      const errorSelectors = '[role="alert"], #ssfErrorAlert, div[data-testid="error"], p[data-testid], span[role="alert"], [aria-live="assertive"]';
      const errorEls = await page.$$(errorSelectors);
      for (const errorEl of errorEls) {
        const errorText = await errorEl.evaluate(el => el.textContent).catch(() => '');
        if (!errorText || errorText.trim().length < 2) continue;
        const lower = errorText.toLowerCase();
        const isErrorLike = /error|invalid|required|cannot|must|missing|incorrect|already|taken|try again|something went wrong|sorry/i.test(lower);
        if (!isErrorLike) continue;
        console.log(`ERROR TEXT FOUND: "${errorText.trim()}"`);
        await screenshot(page, 'form_error');
        if (lower.includes('already') || lower.includes('exist') || lower.includes('taken') || lower.includes('another account')) {
          return {
            success: false,
            message: `❌ Email already registered.\n\n${errorText.trim()}\n\nTry a different email.`,
          };
        }
        if (lower.includes('invalid') || lower.includes('format') || lower.includes('required') || lower.includes('missing') || lower.includes('must') || lower.includes('cannot')) {
          return {
            success: false,
            message: `❌ Form validation error: ${errorText.trim()}\n\nInstagram requires additional fields.`,
          };
        }
        return {
          success: false,
          message: `❌ Instagram error: ${errorText.trim()}`,
        };
      }
    } catch (e) {
      console.log('Error checking failed:', e.message);
    }

    let url = page.url();
    console.log('Current URL:', url);

    // ── Detect ban/suspension in old flow (before success check) ──
    if (/suspended|blocked|disabled/i.test(url)) {
      console.log(`ACCOUNT BANNED (old flow): ${url}`);
      await screenshot(page, 'account_banned');
      const banBodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '');
      let banMessage = '🚫 *Account banned/suspended!*\n\nInstagram flagged this registration.\n\nTry again with a different email and proxy.';
      if (banBodyText.length > 10) banMessage += `\n\nInstagram says: "${banBodyText.slice(0, 300)}"`;
      try { await activeSession.browser?.close(); } catch {}
      activeSession.browser = null; activeSession.page = null; activeSession.proxyInfo = null;
      return { success: false, message: banMessage };
    }

    // === SUCCESS: Redirected away from signup (no OTP needed) ===
    if (url.includes('instagram.com') && !url.includes('emailsignup') && !url.includes('challenge') && !url.includes('suspended')) {
      await screenshot(page, 'account_created_success');
      return {
        success: true,
        step: 'complete',
        message: '🎉 Account created!\n\nLog in at instagram.com',
      };
    }

    // === BLOCKED: Still on emailsignup → captcha / anti-bot ===
    if (url.includes('emailsignup')) {
      await screenshot(page, 'form_blocked_desktop');
      console.log('Form blocked on desktop. Checking for captcha...');

      // ── Step 1: Detect captcha/challenge elements ──
      let captchaDetected = false;
      try {
        const captchaSelectors = [
          'iframe[src*="captcha"]', 'iframe[src*="challenge"]',
          'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
          '#captcha', '.captcha', '[data-testid="captcha"]',
          'div[role="dialog"]', '#challenge', '.challenge',
          'input[name="captcha"]', 'img[src*="captcha"]',
          '.g-recaptcha', '#rc-imageselect',
        ];
        for (const sel of captchaSelectors) {
          const el = await page.$(sel).catch(() => null);
          if (!el) continue;
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 20 && box.height > 20) {
            captchaDetected = true;
            console.log(`Captcha element: ${sel} at (${Math.round(box.x)},${Math.round(box.y)}) ${Math.round(box.width)}x${Math.round(box.height)}`);
            await screenshot(page, 'captcha_detected');
            break;
          }
        }
      } catch (e) {
        console.log('Captcha detection error:', e.message);
      }

      // ── Step 2: Try to bypass captcha ──
      if (captchaDetected) {
        console.log('CAPTCHA detected! Attempting bypass...');
        try {
          // Try clicking reCAPTCHA iframe checkbox
          const robotFrame = await page.$('iframe[src*="recaptcha"], iframe[src*="captcha"]');
          if (robotFrame) {
            const frame = await robotFrame.contentFrame();
            if (frame) {
              const checkbox = await frame.$('.recaptcha-checkbox-border, #recaptcha-anchor, .recaptcha-checkbox');
              if (checkbox) {
                await checkbox.click({ delay: randomDelay(100, 300) });
                console.log('Clicked captcha checkbox, waiting...');
                await delay(5000);
              }
            }
          }
          // Also try clicking any "I am not a robot" text nearby
          const notRobotBtn = await findClickableByText(/not\s*a\s*robot|verify|i\s*am\s*human/i);
          if (notRobotBtn) {
            await notRobotBtn.click({ delay: randomDelay(100, 300) });
            await delay(4000);
          }
        } catch (e) {
          console.log('Captcha bypass attempt error:', e.message);
        }

        // Check if bypass worked
        const postBypassUrl = page.url();
        if (!postBypassUrl.includes('emailsignup') && !postBypassUrl.includes('challenge')) {
          console.log('Captcha bypass succeeded!');
          await screenshot(page, 'captcha_bypassed');
          return {
            success: true,
            step: 'pending',
            message: '✅ Form submitted after captcha bypass!\n\nCheck your email for OTP and send it here.',
          };
        }
        console.log('Captcha bypass did not work. Falling back to mobile mode...');
      } else {
        console.log('No visible captcha. Form silently blocked (anti-bot). Falling back to mobile mode...');
      }

      // ── Step 3: Full iOS device emulation + re-fill entire form ──
      console.log('=== SWITCHING TO iOS DEVICE EMULATION ===');
      await screenshot(page, 'before_android_switch');

      // Use a random device from the pool (not hardcoded)
      const fallbackDevice = randomIOSDevice();
      console.log(`Fallback device: ${fallbackDevice.name}`);

      await page.setViewport({
        width: fallbackDevice.viewport.w,
        height: fallbackDevice.viewport.h,
        deviceScaleFactor: fallbackDevice.viewport.dpr,
        isMobile: true,
        hasTouch: true,
      });
      await page.setUserAgent(fallbackDevice.ua);

      // Override navigator + WebGL fingerprint before the next page load
      await page.evaluateOnNewDocument((dev) => {
        Object.defineProperty(navigator, 'platform', { get: () => dev.platform });
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => dev.concurrency });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => dev.deviceMem });
        try {
          const getParam = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return dev.webglVendor;
            if (param === 37446) return dev.webglRenderer;
            return getParam.call(this, param);
          };
        } catch (_) {}
        Object.defineProperty(screen, 'colorDepth', { get: () => dev.colorDepth });
        Object.defineProperty(screen, 'pixelDepth', { get: () => dev.pixelDepth });
      }, fallbackDevice);

      await delay(1000);

      // Re-navigate to signup with full iOS fingerprint
      console.log('Re-navigating to signup as iOS...');
      await page.goto('https://www.instagram.com/accounts/emailsignup/', {
        waitUntil: 'networkidle2',
        timeout: 60000,
        referer: 'https://www.google.com/',
      });
      await delay(randomDelay(5000, 9000));
      await page.evaluate(() => window.scrollBy(0, 400));
      await delay(randomDelay(1000, 2500));

      const mobileUrl = page.url();
      console.log('Mobile mode URL:', mobileUrl);
      await screenshot(page, 'mobile_initial_page');
      await dumpAllInputs();

      if (mobileUrl.includes('/challenge') || mobileUrl.includes('/login') || mobileUrl.includes('/checkpoint')) {
        await screenshot(page, 'mobile_redirected_blocked');
        const igErrMob = await _scrapeInstagramError(page);
        return {
          success: false,
          message: igErrMob
            ? `❌ Even mobile mode was blocked.\n\nInstagram says: "${igErrMob}"\n\nTry a different proxy country or /noproxy.`
            : '❌ Even mobile mode was blocked. Instagram may be rate-limiting this IP.\n\nTry a different proxy country or /noproxy.',
        };
      }

      // Handle signup/phone/ redirect — click "Sign up with email"
      if (mobileUrl.includes('/signup/phone') || mobileUrl.includes('/signup')) {
        console.log('Mobile - phone-first signup. Looking for "Sign up with email"...');
        const emailLink = await findClickableByText(/sign\s*up\s*with\s*email|use\s*email|email\s*instead/i);
        if (emailLink) {
          console.log('Mobile - clicking "Sign up with email"...');
          await delay(randomDelay(800, 2500));
          await emailLink.click({ delay: randomDelay(200, 500) });
          await delay(randomDelay(5000, 10000));
          console.log('Mobile - after email switch URL:', page.url());
          await dumpAllInputs();
          await screenshot(page, 'mobile_after_email_switch');
        } else {
          const allLinks = await page.$$('a, button, span, div[role="button"], div[tabindex]');
          for (const link of allLinks) {
            const text = (await link.evaluate(el => el.textContent || '').catch(() => '')).trim();
            const box = await link.boundingBox().catch(() => null);
            if (!box || box.width < 20) continue;
            if (/email/i.test(text) && text.length < 30) {
              console.log(`Mobile - clicking element with text: "${text}"`);
              await delay(randomDelay(800, 2500));
              await link.click({ delay: randomDelay(200, 500) });
              await delay(randomDelay(5000, 10000));
              console.log('Mobile - after email link click URL:', page.url());
              await dumpAllInputs();
              await screenshot(page, 'mobile_after_email_link_click');
              break;
            }
          }
        }
      }

      // Dismiss cookie banner if present (mobile)
      try {
        const buttons = await page.$$('button');
        for (const btn of buttons) {
          const text = await page.evaluate(el => el.textContent, btn).catch(() => '');
          if (/accept|allow all cookies/i.test(text)) {
            await btn.click();
            await delay(1500);
            break;
          }
        }
      } catch {}

      // ── Re-detect form type in mobile mode ──
      nextBtn = await findClickableByText(/^\s*Next\s*$/i);
      isMultiStep = !!nextBtn;
      console.log(`Mobile mode: ${isMultiStep ? 'MULTI-STEP' : 'SINGLE-PAGE'} form`);

      // ── FIELD 1: Email (flexible: email/tel/text) ──
      console.log('Filling email (mobile)...');
      emailInput = await findInputByType('email', 0)
        || await findInputByHint(['email', 'e-mail', 'email address'])
        || await findInputByType('text', 0)
        || await findInputByType('tel', 0);
      if (!emailInput) {
        const allVisible = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="password"])');
        for (const inp of allVisible) {
          const box = await inp.boundingBox().catch(() => null);
          if (box) { emailInput = inp; break; }
        }
      }
      if (!emailInput) {
        await screenshot(page, 'mobile_email_not_found');
        return { success: false, message: '❌ Email input not found in mobile mode.' };
      }
      await reactType(emailInput, email, { delayMs: 800 });
      console.log('Mobile - after email fill');
      await screenshot(page, 'mobile_after_email');

      if (isMultiStep) {
        console.log('Mobile - clicking Next...');
        await delay(randomDelay(800, 2500));
        await nextBtn.click({ delay: randomDelay(200, 500) });
        await delay(randomDelay(5000, 10000));
        console.log('Mobile - After Next URL:', page.url());
        await dumpAllInputs();
        await screenshot(page, 'mobile_after_email_next');

        // Detect email confirmation code (mobile wizard sends code before password)
        const allMobInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
        for (const inp of allMobInputs) {
          const aria = (await inp.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '')).toLowerCase();
          const autocomplete = (await inp.evaluate(el => el.autocomplete || '').catch(() => '')).toLowerCase();
          if (aria.includes('confirmation code') || aria.includes('code') || autocomplete.includes('code')) {
            console.log('Mobile - email confirmation code step detected!');
            await screenshot(page, 'mobile_email_code_required');
            return {
              success: true,
              step: 'email_code_required',
              message: '📧 Instagram sent a confirmation code to your email.\n\nCheck your inbox (and spam folder), then send me the 6-digit code.',
            };
          }
        }
      } else {
        await page.evaluate(() => window.scrollBy(0, 600));
        await delay(1500);
        await dumpAllInputs();
        await screenshot(page, 'mobile_after_email_singlepage');
      }

      // ── FIELD 2: Password ──
      console.log('Filling password (mobile)...');
      passInput = await page.$('input[type="password"]');
      for (let retry = 0; retry < 10 && !passInput; retry++) {
        await delay(1000);
        passInput = await page.$('input[type="password"]');
      }
      if (!passInput) {
        await screenshot(page, 'mobile_password_not_found');
        return { success: false, message: '❌ Password field not found in mobile mode.' };
      }
      await reactType(passInput, password, { delayMs: 600 });
      await screenshot(page, 'mobile_after_password');

      // ── FIELD 3: Full Name ──
      console.log('Filling name (mobile)...');
      nameInput = null;
      for (let retry = 0; retry < 12; retry++) {
        const allText = await page.$$('input[type="text"]');
        for (const inp of allText) {
          const box = await inp.boundingBox().catch(() => null);
          if (!box) continue;
          const val = await inp.evaluate(el => el.value);
          if (val && val.includes('@')) continue;
          nameInput = inp;
          break;
        }
        if (nameInput) break;
        await delay(1000);
      }
      if (nameInput) {
        await reactType(nameInput, fullName, { delayMs: 600 });
        await screenshot(page, 'mobile_after_name');
      } else {
        console.log('Mobile - name field never appeared, continuing...');
      }

      // ── FIELD 4: Username ──
      console.log('Filling username (mobile)...');
      const mobileUsernameSuffix = Math.floor(Math.random() * 9999);
      const mobileUsername = `${usernameBase}_${mobileUsernameSuffix}`;
      usernameInput = null;
      for (let retry = 0; retry < 12; retry++) {
        const allInputs = await page.$$('input[type="text"], input[type="search"], input:not([type]):not([type="password"]):not([type="hidden"]):not([type="submit"])');
        for (const inp of allInputs) {
          const box = await inp.boundingBox().catch(() => null);
          if (!box) continue;
          const val = await inp.evaluate(el => el.value);
          const aria = (await inp.evaluate(el => el.getAttribute('aria-label') || '')).toLowerCase();
          const autoc = (await inp.evaluate(el => el.autocomplete || '')).toLowerCase();
          if (val && val.includes('@')) continue;
          if (aria.includes('username') || autoc.includes('username')) {
            usernameInput = inp;
            console.log('Mobile - found username via aria/autocomplete');
            break;
          }
          if (val && val === fullName) continue;
          usernameInput = inp;
          break;
        }
        if (usernameInput) break;
        await delay(1000);
      }
      if (usernameInput) {
        await reactType(usernameInput, mobileUsername, { delayMs: 600 });
        console.log('Mobile Username:', mobileUsername);
        await screenshot(page, 'mobile_after_username');
      } else {
        console.log('Mobile - username field never appeared, skipping...');
      }

      // ── FIELD 5: Birthday ──
      console.log('Setting birthday (mobile)...');
      await page.evaluate(() => window.scrollBy(0, 400));
      await delay(1000);

      // Click "Birthday" label to trigger React rendering
      try {
        const candidates = await page.$$('label, span');
        for (const el of candidates) {
          const text = (await el.evaluate(n => n.textContent || '').catch(() => '')).trim();
          if (text === 'Birthday' || /^Birthday$/i.test(text)) {
            const box = await el.boundingBox().catch(() => null);
            if (box) {
              await el.click({ delay: randomDelay(80, 200) });
              await delay(1500);
              break;
            }
          }
        }
      } catch {}

      // Wait for 3 birthday selects (filter language switcher)
      selectsReady = [];
      for (let retry = 0; retry < 12; retry++) {
        const allSel = await page.$$('select');
        const vis = [];
        for (const s of allSel) {
          const box = await s.boundingBox().catch(() => null);
          if (!box) continue;
          const aria = await s.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '');
          if (aria.toLowerCase().includes('language') || aria.toLowerCase().includes('switch')) continue;
          vis.push(s);
        }
        if (vis.length >= 3) { selectsReady = vis; break; }
        await page.evaluate(() => window.scrollBy(0, 300));
        await delay(1500);
      }
      console.log(`Mobile birthday selects: ${selectsReady.length}`);

      if (selectsReady.length >= 3) {
        await reactSelect(selectsReady[0], String(parseInt(birthMonth, 10)));
        await delay(300);
        await reactSelect(selectsReady[1], String(parseInt(birthDayVal, 10)));
        await delay(300);
        await reactSelect(selectsReady[2], String(birthYear));
        await delay(500);
      } else {
        // Custom dropdown fallback
        console.log('Mobile - no selects, using custom dropdown interaction...');
        const months = ['January','February','March','April','May','June','July',
                        'August','September','October','November','December'];
        const monthText = months[parseInt(birthMonth, 10) - 1];
        await clickCustomSelect('Month', monthText);
        await clickCustomSelect('Day', birthDayVal);
        await clickCustomSelect('Year', String(birthYear));
      }
      console.log(`Mobile birthday: ${birthYear}-${birthMonth}-${birthDayVal} (age ${age})`);
      await screenshot(page, 'mobile_after_birthday');

      // ── SUBMIT in mobile mode ──
      console.log('Submitting form in mobile mode...');
      submitBtn = await findClickableByText(/submit|sign\s*up|create\s*account/i);
      if (!submitBtn) {
        submitBtn = await findClickableByText(/next/i);
      }
      if (!submitBtn) {
        const fallbackIdx = await page.evaluate(() => {
          const all = document.querySelectorAll('button, [role="button"], input[type="submit"]');
          for (let i = all.length - 1; i >= 0; i--) {
            if (all[i].offsetParent !== null) return i;
          }
          return -1;
        });
        if (fallbackIdx >= 0) {
          const freshClickables = await page.$$('button, [role="button"], input[type="submit"]');
          if (fallbackIdx < freshClickables.length) {
            try { submitBtn = freshClickables[fallbackIdx]; console.log('Mobile - fallback: last visible clickable'); } catch {}
          }
        }
      }
      if (submitBtn) {
        await screenshot(page, 'mobile_before_submit');

        // ── Anti-ban: Pre-submit hesitation + touch tap (mobile mode) ──
        // CRITICAL: Use touch events, NOT mouse events on hasTouch emulation.
        // page.mouse.click() on mobile = dead giveaway to Instagram's bot detection.
        console.log('Pre-submit hesitation (mobile, simulating terms reading)...');
        await delay(randomDelay(3000, 8000));

        console.log('Tapping submit with touch events (mobile)...');
        try {
          const btnBox = await submitBtn.boundingBox().catch(() => null);
          if (btnBox) {
            const jx = btnBox.x + btnBox.width * (0.2 + Math.random() * 0.6);
            const jy = btnBox.y + btnBox.height * (0.2 + Math.random() * 0.6);
            await page.evaluate(({ x, y }) => {
              const el = document.elementFromPoint(x, y);
              if (!el) return;
              el.dispatchEvent(new TouchEvent('touchstart', {
                bubbles: true, cancelable: true,
                touches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
                targetTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
                changedTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
              }));
              setTimeout(() => {
                el.dispatchEvent(new TouchEvent('touchend', {
                  bubbles: true, cancelable: true,
                  touches: [], targetTouches: [],
                  changedTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0 })],
                }));
                el.click();
              }, 80 + Math.random() * 150);
            }, { x: jx, y: jy });
            await delay(300);
          } else {
            await submitBtn.click({ delay: randomDelay(200, 500) });
          }
        } catch (clickErr) {
          if (/callFunctionOn|detached|stale|context/i.test(clickErr.message || '')) {
            console.log('mobile submitBtn stale - re-finding in page context...');
            await page.evaluate(() => {
              const all = document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex]');
              for (const el of all) {
                const t = (el.textContent || '').trim();
                if (/agree|submit|sign\s*up|create/i.test(t) && el.offsetParent !== null) {
                  el.click();
                  return;
                }
              }
              for (let i = all.length - 1; i >= 0; i--) {
                if (all[i].offsetParent) { all[i].click(); return; }
              }
            });
          } else {
            throw clickErr;
          }
        }
        await delay(randomDelay(7000, 14000));
        console.log('Mobile - After Submit URL:', page.url());
        await dumpAllInputs();
        await screenshot(page, 'mobile_after_submit');
      } else {
        await screenshot(page, 'mobile_submit_not_found');
        return { success: false, message: '❌ Submit button not found in mobile mode.' };
      }

      // ── Check for OTP inputs after mobile submit ──
      try {
        const allInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
        for (const inp of allInputs) {
          const box = await inp.boundingBox().catch(() => null);
          if (!box) continue;
          const autocomplete = await inp.evaluate(el => el.autocomplete || '').catch(() => '');
          const ariaLabel = await inp.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '');
          const combined = (autocomplete + ' ' + ariaLabel).toLowerCase();
          if (/confirmation|code|otp|verification|one.time/i.test(combined)) {
            await screenshot(page, 'mobile_otp_required');
            return {
              success: true,
              step: 'otp_required',
              message: '✅ Form submitted via mobile mode!\n\n📧 OTP sent to your email.\n\nSend me the 6-digit code when you receive it.',
            };
          }
        }
        const singleDigitInputs = await page.$$('input[maxlength="1"]');
        if (singleDigitInputs.length >= 6) {
          await screenshot(page, 'mobile_otp_required_split');
          return {
            success: true,
            step: 'otp_required',
            message: '✅ Form submitted via mobile mode!\n\n📧 OTP sent to your email.\n\nSend me the 6-digit code when you receive it.',
          };
        }
      } catch {}

      // ── Check for form errors on mobile submit ──
      try {
        const errorSelectors = '[role="alert"], #ssfErrorAlert, div[data-testid="error"], p[data-testid], span[role="alert"], [aria-live="assertive"]';
        const errorEls = await page.$$(errorSelectors);
        for (const errorEl of errorEls) {
          const errorText = await errorEl.evaluate(el => el.textContent).catch(() => '');
          if (!errorText || errorText.trim().length < 2) continue;
          console.log(`Mobile ERROR: "${errorText.trim()}"`);
          await screenshot(page, 'mobile_form_error');
          return {
            success: false,
            message: `❌ Mobile submission error: ${errorText.trim()}`,
          };
        }
      } catch (e) {
        console.log('Mobile error check failed:', e.message);
      }

      const mobileFinalUrl = page.url();
      console.log('Mobile final URL:', mobileFinalUrl);

      // If still on emailsignup even in mobile mode → fully blocked
      if (mobileFinalUrl.includes('emailsignup')) {
        await screenshot(page, 'mobile_still_blocked');
        const igErrStill = await _scrapeInstagramError(page);
        return {
          success: false,
          message: igErrStill
            ? `❌ Form blocked even in mobile mode.\n\nInstagram says: "${igErrStill}"\n\nTry a different proxy country or wait 15 minutes.`
            : '❌ Form blocked even in mobile mode. Instagram may have flagged this IP.\n\nTry a different proxy country or wait 15 minutes.',
        };
      }

      // Mobile submission succeeded (redirected from emailsignup)
      await screenshot(page, 'mobile_success');
      return {
        success: true,
        step: 'pending',
        message: '✅ Form submitted via mobile mode!\n\nCheck your email for OTP and send it here.',
      };
    }

    // === Fallback: unknown URL state ===
    await screenshot(page, 'unknown_result');
    
    // ── Don't blindly report success — check for signs of ban/suspension ──
    const fallbackUrl = page.url();
    console.log('Fallback unknown URL:', fallbackUrl);
    if (/suspended|challenge|blocked|disabled/i.test(fallbackUrl)) {
      console.log(`ACCOUNT BANNED (fallback): ${fallbackUrl}`);
      const fbBanText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '');
      let fbBanMsg = '🚫 *Account banned/suspended!*\n\nInstagram flagged this registration.\n\nTry again with a different email and proxy.';
      if (fbBanText.length > 10) fbBanMsg += `\n\nInstagram says: "${fbBanText.slice(0, 300)}"`;
      try { await activeSession.browser?.close(); } catch {}
      activeSession.browser = null; activeSession.page = null; activeSession.proxyInfo = null;
      return { success: false, message: fbBanMsg };
    }
    // Check for "Confirm you're human" in body
    const fbBodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '');
    if (/confirm\s*(you('re|.?re)\s*)?(a\s*)?human/i.test(fbBodyText) ||
        /verify\s*you\s*are\s*(a\s*)?human/i.test(fbBodyText) ||
        /challenge_required/i.test(fbBodyText)) {
      console.log('CAPTCHA/HUMAN VERIFICATION in fallback — account likely banned');
      try { await activeSession.browser?.close(); } catch {}
      activeSession.browser = null; activeSession.page = null; activeSession.proxyInfo = null;
      return { success: false, message: `🚫 *Account flagged — human verification required!*\n\nInstagram says: "${fbBodyText.slice(0, 300)}"\n\nTry again with a different email and proxy.` };
    }

    // If truly unknown but seems to have left signup, report cautiously
    return {
      success: true,
      step: 'pending',
      message: '✅ Registration may have succeeded.\n\nCheck your email for a confirmation code, or try logging in at instagram.com.',
    };

  } catch (error) {
    console.error('Registration error:', error?.message || error);
    // Try to screenshot even on error
    try {
      if (activeSession.page) {
        await screenshot(activeSession.page, 'fatal_error');
        // Inline DOM dump since dumpAllInputs is scoped inside try block
        // Use evaluate to collect all data in one call to avoid cross-context errors.
        const results = await activeSession.page.evaluate(() => {
          const inputs = [];
          const selects = [];
          const allInps = document.querySelectorAll('input');
          const allSels = document.querySelectorAll('select');
          for (const inp of allInps) {
            const rect = inp.getBoundingClientRect();
            inputs.push({
              type: inp.type,
              name: inp.name || '',
              visible: rect.width > 0 && rect.height > 0,
            });
          }
          for (const s of allSels) {
            selects.push({ name: s.name || '', visible: s.getBoundingClientRect().width > 0 });
          }
          return { inputs, selects };
        }).catch(() => ({ inputs: [], selects: [] }));
        console.log('FATAL ERROR DOM DUMP:', JSON.stringify(results, null, 2));
      }
    } catch {}
    if (activeSession.browser) {
      try { await activeSession.browser.close(); } catch {}
      activeSession.browser = null;
      activeSession.page = null;
    }

    return {
      success: false,
      message: `❌ Error: ${error?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Resume the iOS mobile wizard after the email confirmation code.
 * The user enters the 6-digit code Instagram sent to their email.
 * This function types the code, clicks Next, then fills the remaining
 * wizard steps: password → name → username → birthday → submit.
 */
export async function submitEmailCode(code) {
  if (!activeSession.page || !activeSession.formData) {
    return { success: false, message: 'Session expired. Start /register again.' };
  }

  const page = activeSession.page;
  const cleanCode = String(code).replace(/\D/g, '');

  if (!/^\d{6}$/.test(cleanCode)) {
    return { success: false, message: 'Code must be 6 digits.' };
  }

  const { fullName, password } = activeSession.formData;

  try {
    // ── Step 1: Find and fill the confirmation code input ──
    console.log('Looking for confirmation code input...');
    let codeInput = null;
    const allInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
    for (const inp of allInputs) {
      const box = await inp.boundingBox().catch(() => null);
      if (!box) continue;
      const aria = (await inp.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '')).toLowerCase();
      const autocomplete = (await inp.evaluate(el => el.autocomplete || '').catch(() => '')).toLowerCase();
      if (aria.includes('confirmation') || aria.includes('code') || autocomplete.includes('code')) {
        codeInput = inp;
        break;
      }
    }
    if (!codeInput) {
      // Fallback: first visible text input
      const textInputs = await page.$$('input[type="text"]');
      for (const inp of textInputs) {
        if (await inp.boundingBox().catch(() => null)) { codeInput = inp; break; }
      }
    }
    if (!codeInput) {
      const igErrCI = await _scrapeInstagramError(page);
      return { success: false, message: igErrCI ? `❌ Confirmation code input not found.\n\nInstagram says: "${igErrCI}"\n\nSession may have expired.` : '❌ Confirmation code input not found. Session may have expired.' };
    }

    // ── Step 1b: Type the code WITH React event dispatch (critical!) ──
    // Without dispatching Input/Change events, React's controlled component
    // doesn't register the value, so the Next button stays disabled.
    await delay(randomDelay(500, 2000));

    // Click to focus
    try {
      await codeInput.click({ clickCount: 3 });
      await delay(150);
      await codeInput.evaluate(input => { input.value = ''; });
    } catch (ctxErr) {
      console.log(`  [codeInput] context error during click/clear: ${ctxErr.message?.slice(0,80)}`);
    }

    // Human-like pause before typing
    await delay(randomDelay(300, 1200));

    // Type character by character with keyboard (triggers keydown/keyup)
    try { await codeInput.focus(); } catch {}
    for (const ch of cleanCode) {
      await page.keyboard.type(ch, { delay: 80 + Math.random() * 150 });
    }
    await delay(randomDelay(300, 600));

    // CRITICAL: Dispatch React synthetic events so Instagram's wizard
    // registers the code value and enables the Next button
    try {
      await codeInput.evaluate(input => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } catch (ctxErr) {
      console.log(`  [codeInput] React event dispatch error: ${ctxErr.message?.slice(0,80)}`);
    }

    // Tab out to trigger blur/validation — this often enables the Next button
    await page.keyboard.press('Tab');
    await delay(randomDelay(500, 1000));

    console.log(`Entered confirmation code: ${cleanCode}`);
    await screenshot(page, 'email_code_entered');

    // ── Step 2: Find and click Next using the same robust approach as email step ──
    // Use page.evaluate to find the matching element index, then click via JS
    // to avoid cross-context JS world errors and ensure React processes the click.
    const nextBtnMarker = await page.evaluate(() => {
      const all = document.querySelectorAll('button, [role="button"], div[tabindex="0"], div[tabindex], span, a');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) continue;
        const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
        if (/^\s*Next\s*$/i.test(text)) return { idx: i };
      }
      return null;
    }).catch(() => null);

    if (!nextBtnMarker || nextBtnMarker.idx === undefined) {
      await _dumpAllInputs(page);
      await screenshot(page, 'no_next_button');
      const igErrNextCode = await _scrapeInstagramError(page);
      return { success: false, message: igErrNextCode ? `❌ Next button not found after code entry.\n\nInstagram says: "${igErrNextCode}"` : '❌ Next button not found after code entry. Session may have expired.' };
    }

    const freshBtns = await page.$$('button, [role="button"], div[tabindex="0"], div[tabindex], span, a');
    if (nextBtnMarker.idx >= freshBtns.length) {
      await _dumpAllInputs(page);
      await screenshot(page, 'no_next_button');
      return { success: false, message: '❌ Next button disappeared. Session may have expired.' };
    }

    const nextBtn = freshBtns[nextBtnMarker.idx];

    // Anti-ban: pre-click pause (simulate reading)
    await delay(randomDelay(800, 2500));

    // Click the Next button — use both JS click and Playwright click for reliability
    try {
      await nextBtn.evaluate(el => el.click());
    } catch {}
    await delay(randomDelay(200, 500));
    try {
      await nextBtn.click({ delay: randomDelay(100, 300) });
    } catch {}

    await delay(randomDelay(5000, 10000));
    console.log('After code Next - URL:', page.url());
    await screenshot(page, 'after_email_code_next');

    // ── Step 3a: First, wait for Instagram to transition to the next screen ──
    // The next screen after email code is the password screen.
    // Give Instagram generous time to render it before jumping to conclusions.
    console.log('Waiting for password field to appear (after code)...');
    let passInput = await page.$('input[type="password"]');
    for (let retry = 0; retry < 15 && !passInput; retry++) {
      await delay(1000);
      passInput = await page.$('input[type="password"]');
    }

    if (passInput) {
      // ── Password field found — code was accepted successfully ──
      console.log('Password field visible. Asking user for password...');
      await screenshot(page, 'password_required');
      return {
        success: true,
        step: 'password_required',
        message: '✅ Code accepted! Now send me a *password* for this account.\n\n(at least 6 characters)',
      };
    }

    // ── Step 3b: No password field yet — check for explicit error messages ──
    // If code was genuinely wrong, Instagram shows text like "That code is incorrect"
    const codeIgErr = await _scrapeInstagramError(page);
    if (codeIgErr) {
      console.log(`Code error detected: "${codeIgErr}"`);
      return {
        success: false,
        message: `❌ Code rejected.\n\nInstagram says: "${codeIgErr}"\n\nCheck your email for the correct 6-digit code and try again.`,
      };
    }

    // ── Step 3c: No explicit error, no password field — check if still on code screen ──
    // Be more precise: only flag rejection if a code/confirmation input is actually
    // visible AND there's no other indication the page changed (URL didn't change, etc.)
    const stillCodeInput = await page.$('input:not([type="hidden"]):not([type="submit"]):not([type="password"])');
    if (stillCodeInput) {
      const stillBox = await stillCodeInput.boundingBox().catch(() => null);
      const stillAria = stillBox
        ? (await stillCodeInput.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '')).toLowerCase()
        : '';
      if (stillBox && (stillAria.includes('code') || stillAria.includes('confirmation'))) {
        // One more short wait — sometimes Instagram is just slow to render
        console.log('Still on code screen — waiting a bit more for transition...');
        await delay(randomDelay(3000, 5000));
        passInput = await page.$('input[type="password"]');
        if (passInput) {
          console.log('Password field appeared after extra wait.');
          await screenshot(page, 'password_required');
          return {
            success: true,
            step: 'password_required',
            message: '✅ Code accepted! Now send me a *password* for this account.\n\n(at least 6 characters)',
          };
        }
        // Still on code screen after extra wait — likely genuine rejection
        console.log('Still on code screen — code may have been rejected.');
        await screenshot(page, 'code_rejected');
        return {
          success: false,
          message: '❌ Code rejected or session reset.\n\nCheck your email for the correct 6-digit code and try again.',
        };
      }
    }

    // ── Step 3d: Neither password, nor error, nor code input — dump state for debugging ──
    await _dumpAllInputs(page);
    await screenshot(page, 'after_code_no_password');
    return { success: false, message: '❌ Password field not found after email code. Instagram may have changed the flow.' };

  } catch (error) {
    console.error('submitEmailCode error:', error?.message || error);
    return {
      success: false,
      message: `❌ Error: ${error?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Fill the password and click Next.
 * In the iOS multi-step wizard, each field is on its own screen.
 * After password+Next, Instagram shows the full-name field.
 */
export async function submitPassword(password) {
  if (!activeSession.page || !activeSession.formData) {
    return { success: false, message: 'Session expired. Start /register again.' };
  }

  const page = activeSession.page;

  if (!password || password.length < 6) {
    return { success: false, message: 'Password must be at least 6 characters.' };
  }

  // Store password in formData for later steps
  activeSession.formData.password = password;

  try {
    // ── Step 1: Find password field ──
    console.log('Filling password...');
    let passInput = await page.$('input[type="password"]');
    for (let retry = 0; retry < 10 && !passInput; retry++) {
      await delay(1000);
      passInput = await page.$('input[type="password"]');
    }
    if (!passInput) {
      // Dump all inputs to see what's there
      const allVisible = await page.$$('input:not([type="hidden"]):not([type="submit"])');
      const info = [];
      for (const inp of allVisible) {
        const b = await inp.boundingBox().catch(() => null);
        if (!b) continue;
        info.push({
          type: await inp.evaluate(el => el.type),
          aria: await inp.evaluate(el => el.getAttribute('aria-label') || ''),
          autocomplete: await inp.evaluate(el => el.autocomplete || ''),
        });
      }
      console.log('Visible inputs on password screen:', JSON.stringify(info));
      await screenshot(page, 'password_field_missing');
      const igErrPF = await _scrapeInstagramError(page);
      return { success: false, message: igErrPF ? `❌ Password field not found.\n\nInstagram says: "${igErrPF}"` : '❌ Password field not found.' };
    }

    // Anti-ban: pre-click pause before typing password
    await delay(randomDelay(500, 2000));
    await passInput.click({ clickCount: 3 });
    for (const ch of password) {
      await page.keyboard.type(ch, { delay: 70 + Math.random() * 140 });
    }
    await delay(600);
    console.log('Password filled.');
    await screenshot(page, 'after_password');

    // ── Step 2: Click Next to advance to name step ──
    console.log('Clicking Next after password...');
    let nextBtn = null;
    const clickables = await page.$$('button, [role="button"], div[tabindex]');
    for (const el of clickables) {
      const text = (await el.evaluate(el => el.textContent || '').catch(() => '')).trim();
      if (/^\s*Next\s*$/i.test(text)) {
        const box = await el.boundingBox().catch(() => null);
        if (box) { nextBtn = el; break; }
      }
    }
    if (!nextBtn) {
      const igErrNextPW = await _scrapeInstagramError(page);
      return { success: false, message: igErrNextPW ? `❌ Next button not found after password.\n\nInstagram says: "${igErrNextPW}"` : '❌ Next button not found after password.' };
    }
    // Anti-ban: pre-click pause before Next
    await delay(randomDelay(800, 2500));
    await nextBtn.click({ delay: randomDelay(200, 500) });
    await delay(randomDelay(5000, 10000));
    console.log('After password Next - URL:', page.url());

    // ── Step 3: Check what's on screen ──
    // Dump all visible inputs
    const visibleInfo = [];
    const allVis = await page.$$('input:not([type="hidden"]):not([type="submit"])');
    for (const inp of allVis) {
      const b = await inp.boundingBox().catch(() => null);
      if (!b) continue;
      visibleInfo.push({
        type: await inp.evaluate(el => el.type),
        aria: await inp.evaluate(el => el.getAttribute('aria-label') || ''),
        autocomplete: await inp.evaluate(el => el.autocomplete || ''),
      });
    }
    console.log('After password Next, visible inputs:', JSON.stringify(visibleInfo));
    await _dumpAllInputs(page);
    await screenshot(page, 'after_password_next');

    // Check if we're still on password (wrong password)
    const stillPass = await page.$('input[type="password"]');
    if (stillPass) {
      const pwBox = await stillPass.boundingBox().catch(() => null);
      if (pwBox) {
        console.log('Still on password screen — password may have been rejected.');
        await screenshot(page, 'password_rejected');
        const igErrPW = await _scrapeInstagramError(page);
        return {
          success: false,
          message: igErrPW
            ? `❌ Password rejected.\n\nInstagram says: "${igErrPW}"\n\nTry a stronger password and /register again.`
            : '❌ Password rejected. Try a stronger password (8+ chars, mix of letters, numbers, symbols).\n\nSend /register to try again.',
        };
      }
    }

    // ── Step 4: Check what screen we're on ──
    // Instagram iOS wizard order: password → birthday → name → username → submit
    let visibleInput = null;
    let visibleType = '';
    let visibleAria = '';
    const allInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
    for (const inp of allInputs) {
      const b = await inp.boundingBox().catch(() => null);
      if (!b) continue;
      visibleInput = inp;
      visibleType = await inp.evaluate(el => el.type);
      visibleAria = (await inp.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '')).toLowerCase();
      break;
    }

    // Detect birthday screen (type="date" or aria-label contains "birthday")
    if (visibleType === 'date' || visibleAria.includes('birth')) {
      console.log('Birthday step detected! Auto-filling birthday...');
      const now = new Date();
      const age = Math.floor(Math.random() * 23) + 20; // 20-42
      const birthYear = now.getFullYear() - age;
      const birthMonth = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
      const birthDay = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
      // Instagram expects MM/DD/YYYY format (per aria-label)
      const birthdayValue = `${birthMonth}-${birthDay}-${birthYear}`;
      console.log(`Auto-birthday: ${birthdayValue} (age ${age})`);

      // Focus and type the date (native date input on iOS)
      await delay(randomDelay(500, 2000));
      await visibleInput.click({ delay: randomDelay(200, 500) });
      await delay(500);
      // Clear and type via keyboard (handles custom date widgets)
      await visibleInput.click({ clickCount: 3 });
      await page.keyboard.type(birthdayValue, { delay: 70 + Math.random() * 140 });
      // Dispatch React events so Instagram registers the value
      await visibleInput.evaluate(input => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.keyboard.press('Tab'); // trigger blur/validation
      await delay(600);
      await screenshot(page, 'after_birthday_filled');

      // Click Next after birthday
      let bdayNextBtn = null;
      const bdayClickables = await page.$$('button, [role="button"], div[tabindex]');
      for (const el of bdayClickables) {
        const text = (await el.evaluate(el => el.textContent || '').catch(() => '')).trim();
        if (/^\s*Next\s*$/i.test(text)) {
          const box = await el.boundingBox().catch(() => null);
          if (box) { bdayNextBtn = el; break; }
        }
      }
      if (bdayNextBtn) {
        await delay(randomDelay(800, 2500));
        await bdayNextBtn.click({ delay: randomDelay(200, 500) });
        await delay(randomDelay(5000, 10000));
        console.log('After birthday Next - URL:', page.url());
        await _dumpAllInputs(page);
        await screenshot(page, 'after_birthday_next');
      }
    }

    // Detect name field (after birthday or directly after password if no birthday)
    if (visibleType === 'date' || visibleAria.includes('birth')) {
      // We just handled birthday, re-scan for name
      visibleType = '';
      visibleAria = '';
    }
    const recheckInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
    for (const inp of recheckInputs) {
      const b = await inp.boundingBox().catch(() => null);
      if (!b) continue;
      const aria = (await inp.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '')).toLowerCase();
      const type = await inp.evaluate(el => el.type);
      if (aria.includes('full name') || aria.includes('name') || (type === 'text' && !aria.includes('birth') && !aria.includes('code') && !aria.includes('confirmation'))) {
        console.log('Name step detected!');
        await screenshot(page, 'name_required');
        return {
          success: true,
          step: 'name_required',
          message: '✅ Password set! Now send me your *full name* for the profile.',
        };
      }
    }

    // ── BEFORE falling through, check for ban/suspension ──
    const pwUrl = page.url();
    if (/suspended|challenge|blocked|disabled/i.test(pwUrl)) {
      console.log('BAN DETECTED after password/birthday — URL:', pwUrl);
      await screenshot(page, 'ban_after_password');
      await activeSession.browser?.close().catch(() => {});
      activeSession.browser = null;
      activeSession.page = null;
      return { success: false, message: '🚫 Account suspended or blocked during signup.' };
    }
    const pwBody = await page.evaluate(() => document.body?.innerText || '');
    if (/confirm you.{0,10}are.{0,10}a human/i.test(pwBody) || /verify you.{0,10}are.{0,10}a human/i.test(pwBody)) {
      console.log('CAPTCHA/BAN body text detected after password/birthday');
      await screenshot(page, 'ban_after_password');
      await activeSession.browser?.close().catch(() => {});
      activeSession.browser = null;
      activeSession.page = null;
      return { success: false, message: '🚫 Account flagged — "Verify you are a human" captcha detected.' };
    }

    // Fallback: if we still don't see a name input, but there's no ban, assume name step
    console.log('No visible name input found after password/birthday, but no ban detected. Assuming name step.');
    await screenshot(page, 'name_required');
    return {
      success: true,
      step: 'name_required',
      message: '✅ Password set! Now send me your *full name* for the profile.',
    };

  } catch (error) {
    console.error('submitPassword error:', error?.message || error);
    return {
      success: false,
      message: `❌ Error: ${error?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Fill full name, auto-generate username, set birthday, and submit.
 * This is the final step of the iOS multi-step wizard.
 * After the name step, Instagram may present the name field on the same screen
 * or advance through username → birthday → submit automatically.
 */
export async function submitNameAndFinish(fullName) {
  if (!activeSession.page || !activeSession.formData) {
    return { success: false, message: 'Session expired. Start /register again.' };
  }

  const page = activeSession.page;

  if (!fullName || fullName.trim().length < 2) {
    return { success: false, message: 'Name must be at least 2 characters.' };
  }

  // Store name in formData
  activeSession.formData.fullName = fullName.trim();

  try {
    // ── Step 0: Handle birthday if it appears before name ──
    // Instagram iOS wizard flow: password → birthday → name → username
    // Sometimes the birthday step lands here instead of submitPassword()
    const preCheckInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
    let birthdayField = null;
    for (const inp of preCheckInputs) {
      const box = await inp.boundingBox().catch(() => null);
      if (!box) continue;
      const type = await inp.evaluate(el => el.type);
      const aria = (await inp.evaluate(el => el.getAttribute('aria-label') || '')).toLowerCase();
      if (type === 'date' || aria.includes('birth')) {
        birthdayField = inp;
        break;
      }
    }
    if (birthdayField) {
      console.log('Birthday step detected in submitNameAndFinish — handling it first...');
      const now = new Date();
      const age = Math.floor(Math.random() * 23) + 20; // 20-42
      const birthYear = now.getFullYear() - age;
      const birthMonth = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
      const birthDay = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
      // Instagram expects MM/DD/YYYY format (per aria-label)
      const birthdayValue = `${birthMonth}-${birthDay}-${birthYear}`;
      console.log(`Auto-birthday: ${birthdayValue} (age ${age})`);

      await delay(randomDelay(500, 2000));
      await birthdayField.click({ delay: randomDelay(200, 500) });
      await delay(500);
      await birthdayField.click({ clickCount: 3 });
      await page.keyboard.type(birthdayValue, { delay: 70 + Math.random() * 140 });
      // Dispatch React events so Instagram registers the value
      await birthdayField.evaluate(input => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.keyboard.press('Tab');
      await delay(600);
      await screenshot(page, 'after_birthday_filled_submitname');

      // Click Next after birthday
      let bdayNextBtn = null;
      const bdayClickables = await page.$$('button, [role="button"], div[tabindex]');
      for (const el of bdayClickables) {
        const text = (await el.evaluate(el => el.textContent || '').catch(() => '')).trim();
        if (/^\s*Next\s*$/i.test(text)) {
          const box = await el.boundingBox().catch(() => null);
          if (box) { bdayNextBtn = el; break; }
        }
      }
      if (bdayNextBtn) {
        await delay(randomDelay(800, 2500));
        await bdayNextBtn.click({ delay: randomDelay(200, 500) });
        await delay(randomDelay(5000, 10000));
        console.log('After birthday Next (from submitNameAndFinish) - URL:', page.url());
        await _dumpAllInputs(page);
        await screenshot(page, 'after_birthday_next_submitname');
      }
    }

    // ── Step 1: Check URL for ban/suspension BEFORE hunting for name ──
    const preNameUrl = page.url();
    if (/suspended|challenge|blocked|disabled/i.test(preNameUrl)) {
      console.log('BAN DETECTED before name step — URL:', preNameUrl);
      await screenshot(page, 'ban_before_name');
      await activeSession.browser?.close().catch(() => {});
      activeSession.browser = null;
      activeSession.page = null;
      return { success: false, message: '🚫 Account suspended or blocked during signup.' };
    }
    const preNameBody = await page.evaluate(() => document.body?.innerText || '');
    if (/confirm you.{0,10}are.{0,10}a human/i.test(preNameBody) || /verify you.{0,10}are.{0,10}a human/i.test(preNameBody)) {
      console.log('CAPTCHA/BAN body text detected before name step');
      await screenshot(page, 'ban_before_name');
      await activeSession.browser?.close().catch(() => {});
      activeSession.browser = null;
      activeSession.page = null;
      return { success: false, message: '🚫 Account flagged — "Verify you are a human" captcha detected.' };
    }

    // ── Step 2: Fill full name ──
    console.log('Filling name...');
    let nameInput = null;
    for (let retry = 0; retry < 15; retry++) {
      // Look for any visible text input (not date, not password, not email, not hidden)
      const candidates = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="password"])');
      for (const inp of candidates) {
        const box = await inp.boundingBox().catch(() => null);
        if (!box) continue;
        const type = await inp.evaluate(el => el.type);
        const val = await inp.evaluate(el => el.value);
        const aria = (await inp.evaluate(el => el.getAttribute('aria-label') || '')).toLowerCase();
        // If we're STILL on birthday screen (Next didn't advance), re-handle it
        if (type === 'date' || aria.includes('birth')) {
          if (retry >= 3) {
            // Next button may have failed — retry birthday fill & Next
            console.log('Still on birthday after 3s — retrying birthday fill...');
            const now = new Date();
            const age = Math.floor(Math.random() * 23) + 20;
            const birthYear = now.getFullYear() - age;
            const birthMonth = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
            const birthDay = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
            // Instagram expects MM/DD/YYYY format
            const birthdayValue = `${birthMonth}-${birthDay}-${birthYear}`;
            await delay(randomDelay(500, 1500));
            await inp.click({ clickCount: 3 });
            await page.keyboard.type(birthdayValue, { delay: 70 + Math.random() * 140 });
            await inp.evaluate(input => {
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.keyboard.press('Tab');
            await delay(600);
            // Find & click Next
            const bdayBtns = await page.$$('button, [role="button"], div[tabindex]');
            for (const btn of bdayBtns) {
              const txt = (await btn.evaluate(el => el.textContent || '').catch(() => '')).trim();
              if (/^\s*Next\s*$/i.test(txt)) {
                const bb = await btn.boundingBox().catch(() => null);
                if (bb) { await delay(randomDelay(500, 1500)); await btn.click({ delay: randomDelay(200, 500) }); break; }
              }
            }
            await delay(randomDelay(5000, 10000));
            console.log('Retried birthday. URL:', page.url());
            await _dumpAllInputs(page);
          }
          continue;
        }
        if (val && val.includes('@')) continue;
        if (aria.includes('code') || aria.includes('confirmation')) continue;
        // Accept text, name, or type-less inputs
        // Exclude "Age" input (Instagram fallback when date parse fails)
        if (aria.includes('age')) continue;
        if (type === 'text' || type === 'name' || !type || aria.includes('name') || aria.includes('full')) {
          nameInput = inp;
          console.log(`Name input: type="${type}", aria="${aria}"`);
          break;
        }
        // Last resort: any visible non-date, non-age input
        if (!nameInput && type !== 'date' && !aria.includes('birth') && !aria.includes('age')) {
          nameInput = inp;
        }
      }
      if (nameInput) break;
      // Check URL for ban during retries
      const retryUrl = page.url();
      if (/suspended|challenge|blocked|disabled/i.test(retryUrl)) {
        console.log('BAN DETECTED during name retry loop — URL:', retryUrl);
        await screenshot(page, 'ban_during_name');
        await activeSession.browser?.close().catch(() => {});
        activeSession.browser = null;
        activeSession.page = null;
        return { success: false, message: '🚫 Account suspended or blocked during signup.' };
      }
      await delay(1000);
    }
    if (!nameInput) {
      await _dumpAllInputs(page);
      await screenshot(page, 'name_field_missing');
      const igErrName = await _scrapeInstagramError(page);
      // Final ban check before reporting failure
      const finalUrl = page.url();
      const isBanUrl = /suspended|challenge|blocked|disabled/i.test(finalUrl);
      const finalBody = await page.evaluate(() => document.body?.innerText || '');
      const isCaptcha = /confirm you.{0,10}are.{0,10}a human/i.test(finalBody) || /verify you.{0,10}are.{0,10}a human/i.test(finalBody);
      if (isBanUrl || isCaptcha) {
        console.log('BAN/CAPTCHA detected at name failure — URL:', finalUrl);
        await activeSession.browser?.close().catch(() => {});
        activeSession.browser = null;
        activeSession.page = null;
        return { success: false, message: isCaptcha ? '🚫 Account flagged — "Verify you are a human" captcha detected.' : '🚫 Account suspended or blocked during signup.' };
      }
      return { success: false, message: igErrName ? `❌ Name field not found.\n\nInstagram says: "${igErrName}"\n\nSession may have expired. Send /register to retry.` : '❌ Name field not found. Session may have expired. Send /register to retry.' };
    }

    // Anti-ban: pre-click pause before typing name
    await delay(randomDelay(500, 2000));
    await nameInput.click({ clickCount: 3 });
    for (const ch of fullName.trim()) {
      await page.keyboard.type(ch, { delay: 70 + Math.random() * 140 });
    }
    await delay(600);
    console.log('Name filled.');
    await screenshot(page, 'after_name');

    // ── Step 2: Click Next to advance ──
    console.log('Clicking Next after name...');
    let nextBtn = null;
    let clickables = await page.$$('button, [role="button"], div[tabindex]');
    for (const el of clickables) {
      const text = (await el.evaluate(el => el.textContent || '').catch(() => '')).trim();
      if (/^\s*Next\s*$/i.test(text)) {
        const box = await el.boundingBox().catch(() => null);
        if (box) { nextBtn = el; break; }
      }
    }
    if (!nextBtn) {
      // Maybe it's the final Submit step — proceed
      console.log('No Next button after name — may be Submit step.');
    } else {
      await delay(randomDelay(800, 2500));
      await nextBtn.click({ delay: randomDelay(200, 500) });
      await delay(randomDelay(5000, 10000));
      console.log('After name Next - URL:', page.url());
      await screenshot(page, 'after_name_next');
    }

    // ── Ask user for username instead of auto-generating ──
    console.log('Name step complete. Asking user for username...');
    return {
      success: true,
      step: 'username_required',
      message: '✅ Name saved!\n\n' +
        '🔤 *Step 5 — Choose a username*\n\n' +
        'Send me your desired Instagram username.\n\n' +
        '• 1–30 characters\n' +
        '• Letters, numbers, underscores, periods\n' +
        '• No spaces or special characters',
    };

  } catch (error) {
    console.error('submitNameAndFinish error:', error?.message || error);
    return {
      success: false,
      message: `❌ Error: ${error?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Fill username (user-provided), auto-fill birthday if needed,
 * and click through agree/submit to create the account.
 * This is the final step of the iOS multi-step wizard.
 */
export async function submitUsername(username) {
  if (!activeSession.page || !activeSession.formData) {
    return { success: false, message: 'Session expired. Start /register again.' };
  }

  const page = activeSession.page;

  if (!username || username.trim().length < 1) {
    return { success: false, message: 'Username must be at least 1 character.' };
  }

  const cleanUsername = username.trim().replace(/\s/g, '');
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(cleanUsername)) {
    return { success: false, message: 'Username can only contain letters, numbers, underscores, and periods (1–30 characters).' };
  }

  activeSession.formData.username = cleanUsername;

  try {
    // ── Step 1: Find and fill username input ──
    console.log('Filling username:', cleanUsername);
    await _dumpAllInputs(page);
    console.log('  [submitUsername] Dumped inputs, beginning username detection...');

    // Page-health check: detect bans/captchas before spending time searching
    const preLoopUrl = page.url();
    if (/suspended|challenge|blocked|disabled/i.test(preLoopUrl)) {
      console.log('  [submitUsername] BAN DETECTED before username search — URL:', preLoopUrl);
      await screenshot(page, 'ban_before_username');
      await activeSession.browser?.close().catch(() => {});
      activeSession.browser = null;
      activeSession.page = null;
      return { success: false, message: '🚫 Account suspended or blocked before username step.' };
    }
    const preLoopBody = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    if (/confirm you.{0,10}are.{0,10}a human|verify you.{0,10}are.{0,10}a human/i.test(preLoopBody)) {
      console.log('  [submitUsername] CAPTCHA/HUMAN VERIFICATION detected before username search');
      await screenshot(page, 'captcha_before_username');
      await activeSession.browser?.close().catch(() => {});
      activeSession.browser = null;
      activeSession.page = null;
      return { success: false, message: '🚫 Account flagged — "Verify you are a human" captcha detected before username step.' };
    }
    // Detect Instagram's "How old are you?" numeric age fallback screen
    // (appears when date format is rejected — e.g. wrong DD/MM/YYYY vs MM/DD/YYYY)
    if (/how old are you/i.test(preLoopBody) || /\bage\b/i.test(preLoopBody)) {
      console.log('  [submitUsername] "How old are you?" age screen detected — filling numeric age...');
      try {
        const ageInput = await page.$('input[aria-label="Age"], input[aria-label="age"], input:not([type="hidden"])');
        if (ageInput) {
          const box = await ageInput.boundingBox().catch(() => null);
          if (box) {
            const age = Math.floor(Math.random() * 13) + 20; // 20-32
            console.log(`  Filling age: ${age}`);
            await ageInput.click({ clickCount: 3 });
            await page.keyboard.type(String(age), { delay: 70 + Math.random() * 140 });
            await ageInput.evaluate((el, val) => {
              el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, String(age));
            await page.keyboard.press('Tab');
            await delay(600);
            // Find and click Next
            const ageNextBtns = await page.$$('button, [role="button"], div[tabindex]');
            for (const btn of ageNextBtns) {
              const txt = (await btn.evaluate(el => el.textContent || '').catch(() => '')).trim();
              if (/^\s*Next\s*$/i.test(txt)) {
                const bb = await btn.boundingBox().catch(() => null);
                if (bb) { await delay(randomDelay(500, 1500)); await btn.click({ delay: randomDelay(200, 500) }); break; }
              }
            }
            await delay(randomDelay(5000, 10000));
            console.log('  After age Next - URL:', page.url());
            await _dumpAllInputs(page);
            await screenshot(page, 'after_age_screen');
          }
        }
      } catch (e) {
        console.log('  Age screen handler error:', e.message);
      }
    }

    let usernameInput = null;
    for (let retry = 0; retry < 8; retry++) {
      // Use evaluate (not evaluateHandle) to avoid cross-context JS world errors
      // when Instagram injects captcha iframes mid-signup.
      const marker = await page.evaluate(() => {
        const allInputs = document.querySelectorAll('input');
        for (let i = 0; i < allInputs.length; i++) {
          const el = allInputs[i];
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const type = (el.type || '').toLowerCase();
          const autocomplete = (el.autocomplete || '').toLowerCase();
          if (type === 'hidden' || type === 'submit' || type === 'password' || type === 'date' || type === 'email') continue;
          if (aria.includes('code') || aria.includes('confirmation')) continue;
          if (aria.includes('username') || autocomplete.includes('username') || el.name === 'username') {
            if (el.offsetParent !== null) return { idx: i, aria };
          }
        }
        for (let i = 0; i < allInputs.length; i++) {
          const el = allInputs[i];
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const type = (el.type || '').toLowerCase();
          if (type === 'hidden' || type === 'submit' || type === 'password' || type === 'date' || type === 'email') continue;
          if (aria.includes('code') || aria.includes('confirmation') || aria.includes('name') || aria.includes('full') || aria.includes('email') || aria.includes('birth')) continue;
          if (el.offsetParent !== null && (type === 'text' || type === 'search' || !type)) return { idx: i, aria };
        }
        return null;
      }).catch(() => null);
      if (marker && marker.idx !== undefined) {
        // Re-query fresh in the current execution context
        const freshInputs = await page.$$('input');
        if (marker.idx < freshInputs.length) {
          const freshEl = freshInputs[marker.idx];
          try {
            const box = await freshEl.boundingBox().catch(() => null);
            if (box) {
              usernameInput = freshEl;
              console.log(`Found username input: aria="${marker.aria}"`);
              break;
            }
          } catch (ctxErr) {
            console.log(`  Context error at retry ${retry + 1}, will re-scan: ${ctxErr.message?.slice(0,80)}`);
          }
        }
      }
      console.log(`Username retry ${retry + 1}: not found yet`);
      await delay(1000);
    }
    if (usernameInput) {
      // Anti-ban: pre-click pause before typing username
      await delay(randomDelay(500, 2000));
      await usernameInput.click({ clickCount: 3 });
      await delay(150);
      // Explicitly clear the field — Instagram often auto-fills the email prefix
      // and React-controlled inputs may not respect triple-click selection replacement
      await usernameInput.evaluate(input => { input.value = ''; });
      await usernameInput.focus();
      // Redundant keyboard clear for stubborn React widgets
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await delay(100);
      for (const ch of cleanUsername) {
        await page.keyboard.type(ch, { delay: 70 + Math.random() * 140 });
      }
      // Dispatch React events so Instagram registers the manually-set value
      await usernameInput.evaluate(input => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await delay(600);
      console.log('Username filled:', cleanUsername);
      await screenshot(page, 'after_username');

      // Click Next after username
      let nextBtn = null;
      const clickables = await page.$$('button, [role="button"], div[tabindex]');
      for (const el of clickables) {
        const text = (await el.evaluate(el => el.textContent || '').catch(() => '')).trim();
        if (/^\s*Next\s*$/i.test(text)) {
          const box = await el.boundingBox().catch(() => null);
          if (box) { nextBtn = el; break; }
        }
      }
      if (nextBtn) {
        await delay(randomDelay(800, 2500));
        await nextBtn.click({ delay: randomDelay(200, 500) });
        await delay(randomDelay(5000, 10000));
        console.log('After username Next - URL:', page.url());
        await screenshot(page, 'after_username_next');
      }
    } else {
      return { success: false, message: '❌ Username input not found. Session may have expired.' };
    }

    // ── Step 2: Birthday (auto-fill if present) ──
    const birthdayDateInput = await page.$('input[type="date"]');
    const bdayBox = birthdayDateInput ? await birthdayDateInput.boundingBox().catch(() => null) : null;
    if (bdayBox) {
      console.log('Birthday on screen, auto-filling...');
      const now = new Date();
      const age = Math.floor(Math.random() * 23) + 20;
      const birthYear = now.getFullYear() - age;
      const birthMonth = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
      const birthDayVal = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
      // Instagram expects MM/DD/YYYY format (per aria-label)
      const birthdayValue = `${birthMonth}-${birthDayVal}-${birthYear}`;
      console.log(`Auto-birthday: ${birthdayValue} (age ${age})`);

      await delay(randomDelay(500, 2000));
      await birthdayDateInput.click({ delay: randomDelay(200, 500) });
      await delay(500);
      await birthdayDateInput.click({ clickCount: 3 });
      await page.keyboard.type(birthdayValue, { delay: 70 + Math.random() * 140 });
      // Dispatch React events so Instagram registers the value
      await birthdayDateInput.evaluate(input => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.keyboard.press('Tab');
      await delay(600);

      let birthdaySelects = [];
      for (let retry = 0; retry < 6; retry++) {
        const allSel = await page.$$('select');
        const vis = [];
        for (const s of allSel) {
          const box = await s.boundingBox().catch(() => null);
          if (!box) continue;
          const aria = await s.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '');
          if (aria.toLowerCase().includes('language') || aria.toLowerCase().includes('switch')) continue;
          vis.push(s);
        }
        if (vis.length >= 3) { birthdaySelects = vis; break; }
        await delay(1000);
      }
      if (birthdaySelects.length >= 3) {
        await birthdaySelects[0].evaluate((select, val) => {
          select.value = val;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(parseInt(birthMonth, 10)));
        await delay(200);
        await birthdaySelects[1].evaluate((select, val) => {
          select.value = val;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(parseInt(birthDayVal, 10)));
        await delay(200);
        await birthdaySelects[2].evaluate((select, val) => {
          select.value = val;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(birthYear));
        await delay(500);
      }

      console.log(`Birthday set: ${birthYear}-${birthMonth}-${birthDayVal} (age ${age})`);
      await screenshot(page, 'after_birthday');

      let bdayNextBtn = null;
      const bdayClickables = await page.$$('button, [role="button"], div[tabindex]');
      for (const el of bdayClickables) {
        const text = (await el.evaluate(el => el.textContent || '').catch(() => '')).trim();
        if (/^\s*Next\s*$/i.test(text)) {
          const box = await el.boundingBox().catch(() => null);
          if (box) { bdayNextBtn = el; break; }
        }
      }
      if (bdayNextBtn) {
        await delay(randomDelay(800, 2500));
        await bdayNextBtn.click({ delay: randomDelay(200, 500) });
        await delay(randomDelay(5000, 10000));
        await screenshot(page, 'after_birthday_next');
      }
    } else {
      console.log('No birthday input found — already handled by submitPassword, skipping.');
    }

    // ── Step 3: Submit with retry loop (I agree → confirm → create) ──
    // Anti-ban: mouse jitter helper for realistic human behavior during waits
    async function mouseJitter() {
      try {
        const vp = page.viewportSize();
        if (vp) {
          const mx = Math.floor(Math.random() * vp.width);
          const my = Math.floor(Math.random() * vp.height * 0.6); // upper 60% of page
          await page.mouse.move(mx, my, { steps: Math.floor(Math.random() * 5) + 2 });
        }
      } catch {}
    }
    for (let submitAttempt = 0; submitAttempt < 5; submitAttempt++) {
      console.log(`Submit attempt ${submitAttempt + 1}...`);
      // Anti-ban: extra delay before searching for submit (simulates reading terms)
      await delay(randomDelay(2000, 4000));
      
      // ── Guard: if execution context was destroyed by a previous click, the account was created ──
      let debugData;
      try {
        debugData = await page.evaluate(() => {
          const texts = [];
          const all = document.querySelectorAll('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
          for (const el of all) {
            if (el.offsetParent === null) continue;
            const t = (el.textContent || '').trim();
            if (t) texts.push(t);
          }
          return { texts, body: document.body?.innerText?.slice(0, 500) || '' };
        });
      } catch (ctxDestroyErr) {
        if (/execution context was destroyed|detached frame|target closed/i.test(ctxDestroyErr.message || '')) {
          console.log('  Page navigated away (context destroyed) — account likely created!');
          // Check if we're on a non-signup URL now
          try {
            const finalUrlCheck = page.url();
            console.log('  Post-navigation URL:', finalUrlCheck);
            if (!finalUrlCheck.includes('signup') && !finalUrlCheck.includes('emailsignup')) {
              console.log('  Confirmed: left signup flow — account created!');
            }
          } catch {}
          break; // Exit submit loop — account was created
        }
        throw ctxDestroyErr; // Re-throw unexpected errors
      }
      console.log(`Visible clickable buttons: [${debugData.texts.map(t => `"${t}"`).join(', ')}]`);
      console.log(`Page body (first 500): ${debugData.body.replace(/\n/g, ' | ')}`);

      let submitBtn = null;
      // Priority 1: I agree / Agree — use page.evaluate to find index safely
      const agreeMarker = await page.evaluate(() => {
        const all = document.querySelectorAll('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
        for (let i = 0; i < all.length; i++) {
          const t = (all[i].textContent || all[i].innerText || '').trim();
          if (/agree/i.test(t) && !/privacy|cookie/i.test(t) && all[i].offsetParent !== null) {
            return { idx: i, text: t };
          }
        }
        return null;
      });
      if (agreeMarker) {
        const freshClickables = await page.$$('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
        if (agreeMarker.idx < freshClickables.length) {
          try {
            const box = await freshClickables[agreeMarker.idx].boundingBox().catch(() => null);
            if (box) {
              submitBtn = freshClickables[agreeMarker.idx];
              console.log(`Found agree button: "${agreeMarker.text}"`);
            }
          } catch {}
        }
      }
      if (!submitBtn) {
        // Use evaluate (not evaluateHandle) to avoid cross-context JS world errors
        const agreeIdx = await page.evaluate(() => {
          const all = document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex]');
          for (let i = 0; i < all.length; i++) {
            const t = (all[i].textContent || all[i].innerText || '').trim();
            if (/agree/i.test(t) && all[i].offsetParent !== null) return i;
          }
          // Deep walk fallback
          const bodyWalk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (bodyWalk.nextNode()) {
            const el = bodyWalk.currentNode;
            if (el.children.length === 0 && /^\s*(I\s*)?agree\s*$/i.test(el.textContent || '')) {
              let parent = el.parentElement;
              while (parent) {
                if (parent.matches('button, [role="button"], div[tabindex], span[tabindex], a')) {
                  // Find this parent in allClickables by outerHTML
                  const html = parent.outerHTML || '';
                  const all2 = document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex]');
                  for (let j = 0; j < all2.length; j++) {
                    if (all2[j].outerHTML === html) return j;
                  }
                  return -2; // found parent but no index match — use fallback below
                }
                parent = parent.parentElement;
              }
            }
          }
          return -1; // not found
        }).catch(() => -1);
        if (agreeIdx >= 0) {
          // Re-query fresh in the current execution context
          const freshClickables = await page.$$('button, [role="button"], div[tabindex], span[tabindex]');
          if (agreeIdx < freshClickables.length) {
            try {
              const box = await freshClickables[agreeIdx].boundingBox().catch(() => null);
              if (box) {
                submitBtn = freshClickables[agreeIdx];
                const text = await submitBtn.evaluate(el => el.textContent || '').catch(() => '');
                console.log(`Found agree via page search: "${text}"`);
              }
            } catch (ctxErr) {
              console.log(`  Context error on agree button, retrying next attempt: ${ctxErr.message?.slice(0,80)}`);
            }
          }
        } else if (agreeIdx === -2) {
          // Deep walk found a match but couldn't map index — try last visible clickable
          const freshClickables = await page.$$('button, [role="button"], div[tabindex], span[tabindex]');
          for (let i = freshClickables.length - 1; i >= 0; i--) {
            try {
              const text = await freshClickables[i].evaluate(el => el.textContent || '').catch(() => '');
              if (/agree/i.test(text)) {
                const box = await freshClickables[i].boundingBox().catch(() => null);
                if (box) { submitBtn = freshClickables[i]; console.log(`Found agree via fallback: "${text}"`); break; }
              }
            } catch {}
          }
        }
      }
      // Priority 2: Submit / Sign up / Create account — safe page.evaluate find
      if (!submitBtn) {
        const submitMarker = await page.evaluate(() => {
          const all = document.querySelectorAll('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
          for (let i = 0; i < all.length; i++) {
            const t = (all[i].textContent || '').trim();
            if (/submit|sign\s*up|create\s*account/i.test(t) && all[i].offsetParent !== null) return i;
          }
          return -1;
        });
        if (submitMarker >= 0) {
          const fresh = await page.$$('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
          if (submitMarker < fresh.length) {
            try { submitBtn = fresh[submitMarker]; console.log('Found submit button'); } catch {}
          }
        }
      }
      // Priority 3: Next (only on first attempt) — safe page.evaluate find
      if (!submitBtn && submitAttempt === 0) {
        const nextMarker = await page.evaluate(() => {
          const all = document.querySelectorAll('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
          for (let i = 0; i < all.length; i++) {
            const t = (all[i].textContent || '').trim();
            if (/^\s*next\s*$/i.test(t) && all[i].offsetParent !== null) return i;
          }
          return -1;
        });
        if (nextMarker >= 0) {
          const fresh = await page.$$('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
          if (nextMarker < fresh.length) {
            try { submitBtn = fresh[nextMarker]; console.log('Found Next button (first attempt only)'); } catch {}
          }
        }
      }
      // Fallback: last visible clickable — safe page.evaluate find
      if (!submitBtn) {
        const fallbackIdx = await page.evaluate(() => {
          const all = document.querySelectorAll('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
          for (let i = all.length - 1; i >= 0; i--) {
            if (all[i].offsetParent !== null) return i;
          }
          return -1;
        });
        if (fallbackIdx >= 0) {
          const fresh = await page.$$('button, [role="button"], input[type="submit"], div[tabindex], span[tabindex]');
          if (fallbackIdx < fresh.length) {
            try { submitBtn = fresh[fallbackIdx]; console.log('Using fallback clickable'); } catch {}
          }
        }
      }
      if (!submitBtn) {
        console.log('No clickable button found on attempt', submitAttempt + 1);
        await delay(2000);
        continue;
      }
      await screenshot(page, `before_final_submit_${submitAttempt + 1}`);
      // Anti-ban: realistic pre-click hesitation (reading terms)
      await delay(randomDelay(3000, 8000));
      const urlBefore = page.url().replace(/#.*$/, '');
      // ── CRITICAL: Use touch events, NOT mouse events ──
      // Mobile Safari/iOS Chrome fires touchstart→touchend→click, NOT mousedown→mouseup→click.
      // Using page.mouse.click() on a hasTouch:true device is a dead giveaway to Instagram.
      try {
        const btnBox = await submitBtn.boundingBox().catch(() => null);
        if (btnBox) {
          const jx = btnBox.x + btnBox.width * (0.2 + Math.random() * 0.6);
          const jy = btnBox.y + btnBox.height * (0.2 + Math.random() * 0.6);
          // Dispatch touch events in page context for maximum realism
          await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return;
            const touchStart = new TouchEvent('touchstart', {
              bubbles: true, cancelable: true,
              touches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
              targetTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
              changedTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0.5 })],
            });
            el.dispatchEvent(touchStart);
            setTimeout(() => {
              const touchEnd = new TouchEvent('touchend', {
                bubbles: true, cancelable: true,
                touches: [],
                targetTouches: [],
                changedTouches: [new Touch({ identifier: 0, target: el, clientX: x, clientY: y, radiusX: 5, radiusY: 5, force: 0 })],
              });
              el.dispatchEvent(touchEnd);
              el.click();
            }, 80 + Math.random() * 150);
          }, { x: jx, y: jy });
          await delay(300);
        } else {
          // Box unavailable, fall back to direct click
          await submitBtn.click({ delay: randomDelay(200, 500) });
        }
      } catch (clickErr) {
        if (/callFunctionOn|detached|stale|context/i.test(clickErr.message || '')) {
          console.log('submitBtn stale after delay - re-finding in page context...');
          await page.evaluate(() => {
            const all = document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex]');
            for (const el of all) {
              const t = (el.textContent || '').trim();
              if (/agree|submit|sign\s*up|create/i.test(t) && el.offsetParent !== null) {
                el.click();
                return;
              }
            }
            for (let i = all.length - 1; i >= 0; i--) {
              if (all[i].offsetParent) { all[i].click(); return; }
            }
          });
        } else {
          throw clickErr;
        }
      }
      // Anti-ban: longer wait with mouse jitter for realism
      await delay(randomDelay(6000, 12000));
      await mouseJitter();
      const urlAfter = page.url().replace(/#.*$/, '');
      console.log(`After click ${submitAttempt + 1} - URL (no hash):`, urlAfter);
      await screenshot(page, `after_final_submit_${submitAttempt + 1}`);
      // Detect ban/suspension URLs BEFORE treating as success
      if (/suspended|challenge|blocked|disabled/i.test(urlAfter)) {
        console.log(`ACCOUNT BANNED — landed on: ${urlAfter}`);
        await screenshot(page, 'account_banned');
        const banBodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '');
        let banMessage = '🚫 *Account banned/suspended!*\n\nInstagram flagged this registration and suspended the account immediately.\n\nTry again with:\n• A different email\n• A different proxy/country\n• A different device profile (already randomized)';
        if (banBodyText.length > 10) {
          banMessage += `\n\nInstagram says: "${banBodyText.slice(0, 300)}"`;
        }
        // Clean up
        try { await activeSession.browser?.close(); } catch {}
        activeSession.browser = null;
        activeSession.page = null;
        activeSession.proxyInfo = null;
        return { success: false, message: banMessage };
      }
      if (urlAfter !== urlBefore || (!urlAfter.includes('signup') && !urlAfter.includes('emailsignup'))) {
        console.log('URL changed or left signup — submit succeeded!');
        break;
      }
      try {
        const postInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
        for (const inp of postInputs) {
          const box = await inp.boundingBox().catch(() => null);
          if (!box) continue;
          const autocomplete = await inp.evaluate(el => el.autocomplete || '').catch(() => '');
          const ariaLabel = await inp.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '');
          const combined = (autocomplete + ' ' + ariaLabel).toLowerCase();
          if (/confirmation|code|otp|verification|one.time/i.test(combined)) {
            await screenshot(page, 'post_submit_otp');
            return { success: true, step: 'otp_required', message: '✅ Form submitted!\n\n📧 Instagram sent a verification code to your email.\n\nSend me the 6-digit code.' };
          }
        }
        const singleDigitInputs = await page.$$('input[maxlength="1"]');
        if (singleDigitInputs.length >= 6) {
          await screenshot(page, 'post_submit_otp_split');
          return { success: true, step: 'otp_required', message: '✅ Form submitted!\n\n📧 Instagram sent a verification code to your email.\n\nSend me the 6-digit code.' };
        }
      } catch {}
      await _dumpAllInputs(page);
    }

    // ── Post-loop: determine outcome (with context-destruction safety) ──
    // If the page navigated away during the submit loop, all page.evaluate() calls
    // will throw "Execution context was destroyed". That means account creation succeeded.
    let pageNavigatedAway = false;

    // Check for OTP inputs (post-registration verification)
    try {
      const postInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
      for (const inp of postInputs) {
        const box = await inp.boundingBox().catch(() => null);
        if (!box) continue;
        const autocomplete = await inp.evaluate(el => el.autocomplete || '').catch(() => '');
        const ariaLabel = await inp.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '');
        const combined = (autocomplete + ' ' + ariaLabel).toLowerCase();
        if (/confirmation|code|otp|verification|one.time/i.test(combined)) {
          await screenshot(page, 'post_submit_otp');
          return { success: true, step: 'otp_required', message: '✅ Form submitted!\n\n📧 Instagram sent a verification code to your email.\n\nSend me the 6-digit code.' };
        }
      }
      const singleDigitInputs = await page.$$('input[maxlength="1"]');
      if (singleDigitInputs.length >= 6) {
        await screenshot(page, 'post_submit_otp_split');
        return { success: true, step: 'otp_required', message: '✅ Form submitted!\n\n📧 Instagram sent a verification code to your email.\n\nSend me the 6-digit code.' };
      }
    } catch (postErr) {
      if (/execution context was destroyed|detached frame|target closed/i.test(postErr.message || '')) {
        console.log('  Post-loop: context destroyed during OTP check — page navigated away');
        pageNavigatedAway = true;
      }
    }

    // Check for errors
    if (!pageNavigatedAway) {
      try {
        const errorSelectors = '[role="alert"], #ssfErrorAlert, div[data-testid="error"], p[data-testid], span[role="alert"], [aria-live="assertive"]';
        const errorEls = await page.$$(errorSelectors);
        for (const errorEl of errorEls) {
          const errorText = await errorEl.evaluate(el => el.textContent).catch(() => '');
          if (!errorText || errorText.trim().length < 2) continue;
          console.log(`ERROR after submit: "${errorText.trim()}"`);
          await screenshot(page, 'after_submit_error');
          return { success: false, message: `❌ Submission error: ${errorText.trim()}` };
        }
      } catch (e) {
        if (/execution context was destroyed|detached frame|target closed/i.test(e.message || '')) {
          pageNavigatedAway = true;
        } else {
          console.log('Error check failed:', e.message);
        }
      }
    }

    let finalUrl;
    try {
      finalUrl = page.url();
    } catch {
      finalUrl = 'about:blank';
      pageNavigatedAway = true;
    }
    console.log('Final URL after username+submit flow:', finalUrl);

    // ── If page navigated away from signup, assume account created ──
    if (pageNavigatedAway || (!finalUrl.includes('emailsignup') && !finalUrl.includes('signup'))) {
      console.log('  Page left signup flow — account created successfully!');
      // Fall through to success path below
    } else {
      // ── Check for ban/suspension/challenge URLs ──
      if (/suspended|challenge|blocked|disabled/i.test(finalUrl)) {
        console.log(`ACCOUNT BANNED — final URL: ${finalUrl}`);
        await screenshot(page, 'account_banned');
        let banBodyText = '';
        try { banBodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || ''); } catch {}
        let banMessage = '🚫 *Account banned/suspended!*\n\nInstagram flagged this registration and suspended the account immediately.\n\nTry again with:\n• A different email\n• A different proxy/country\n• A different device (already randomized each session)';
        if (banBodyText.length > 10) {
          banMessage += `\n\nInstagram says: "${banBodyText.slice(0, 300)}"`;
        }
        // Clean up
        try { await activeSession.browser?.close(); } catch {}
        activeSession.browser = null;
        activeSession.page = null;
        activeSession.proxyInfo = null;
        return { success: false, message: banMessage };
      }

      // ── Check for "Confirm you're human" captcha/challenge in body ──
      try {
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || '');
        if (/confirm\s*(you('re|.?re)\s*)?(a\s*)?human/i.test(bodyText) ||
            /verify\s*you\s*are\s*(a\s*)?human/i.test(bodyText) ||
            /challenge_required/i.test(bodyText)) {
          console.log('CAPTCHA/HUMAN VERIFICATION triggered — account likely banned');
          await screenshot(page, 'human_verification_ban');
          // Clean up
          try { await activeSession.browser?.close(); } catch {}
          activeSession.browser = null;
          activeSession.page = null;
          activeSession.proxyInfo = null;
          return { success: false, message: `🚫 *Account flagged — human verification required!*\n\nInstagram is asking "Confirm you're human" which means the account is likely banned or under review.\n\nInstagram says: "${bodyText.slice(0, 300)}"\n\nTry again with a different email and proxy.` };
        }
      } catch {}

      // Still on signup page — failed
      if (finalUrl.includes('emailsignup') || finalUrl.includes('signup')) {
        await screenshot(page, 'still_on_signup');
        let igErrSignup = '';
        try { igErrSignup = await _scrapeInstagramError(page); } catch {}
        return {
          success: false,
          message: igErrSignup
            ? `❌ Form still on signup page after submission.\n\nInstagram says: "${igErrSignup}"\n\nTry a different username, proxy, or wait a few minutes.`
            : '❌ Form still on signup page after submission. Instagram may have blocked this attempt.\n\nTry a different username, proxy, or wait a few minutes.',
        };
      }
    }

    await screenshot(page, 'account_created');
    const { email, password, fullName: storedName } = activeSession.formData;

    // ── Scrape credential dump (2FA codes, recovery info) BEFORE closing browser ──
    console.log('Scraping account credentials before cleanup...');
    const fullCredMessage = await scrapeAccountCredentials(page, {
      email, password, fullName: storedName, username: cleanUsername
    });

    // ── Store full credentials in session for later (after 2FA setup) ──
    activeSession.acquiredCreds = { email, password, fullName: storedName, username: cleanUsername };

    // ── Extract just the TOTP key from the scraped message ──
    const totpKeyMatch = fullCredMessage.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
    const totpKey = totpKeyMatch?.[1] || null;

    // ── Clean up session — next /register gets a fresh device ──
    console.log('Cleaning up session after account creation...');
    try { await activeSession.browser?.close(); } catch {}
    activeSession.browser = null;
    activeSession.page = null;
    activeSession.proxyInfo = null;

    let setupMsg = '🎉 *Account Created!*\n\n';
    if (totpKey) {
      setupMsg += '🔐 *2FA Setup Key:* Ready — tap the 🔐 2FA Setup button below to reveal it and complete setup.\n\n';
      setupMsg += '📲 *Next step:* Tap the button, add the key to your authenticator app, then send the 6-digit OTP.';
    } else {
      setupMsg += '⚙️ *2FA:* Could not auto-extract the authenticator key.\n';
      setupMsg += 'To get it manually:\n1. Log in → Settings → Account Center\n2. Password and security → Two-factor authentication\n3. Select account → Authentication app → Copy the setup key\n\n';
      setupMsg += `Then send \`/2fa\` to complete setup.`;
    }

    return {
      success: true,
      step: '2fa_setup',
      message: setupMsg,
      _totpKey: totpKey,
    };

  } catch (error) {
    console.error('submitUsername error:', error?.message || error);
    return {
      success: false,
      message: `❌ Error: ${error?.message || 'Unknown error'}`,
    };
  }
}

export async function submitOTP(otp) {
  if (!activeSession.page) {
    return { success: false, message: 'Session expired. Start /register again.' };
  }

  try {
    const page = activeSession.page;
    const cleanOtp = String(otp).replace(/\D/g, '');

    if (!/^\d{6}$/.test(cleanOtp)) {
      return { success: false, message: 'OTP must be 6 digits.' };
    }

    try {
      // Find OTP input by autocomplete/aria-label hints (no name attribute)
      let otpInput = null;
      const allInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
      for (const inp of allInputs) {
        const box = await inp.boundingBox().catch(() => null);
        if (!box) continue;
        const autocomplete = await inp.evaluate(el => el.autocomplete || '').catch(() => '');
        const ariaLabel = await inp.evaluate(el => el.getAttribute('aria-label') || '').catch(() => '');
        if (autocomplete.includes('one-time-code') || autocomplete.includes('code') ||
            ariaLabel.toLowerCase().includes('code') || ariaLabel.toLowerCase().includes('otp') ||
            ariaLabel.toLowerCase().includes('confirmation') || ariaLabel.toLowerCase().includes('verification')) {
          otpInput = inp;
          break;
        }
      }
      if (otpInput) {
        // Anti-ban: pre-click pause + slower typing for OTP
        await delay(randomDelay(500, 2000));
        await otpInput.click({ clickCount: 3 });
        await otpInput.type(cleanOtp, { delay: 120 + Math.random() * 200 });
      } else {
        // Fallback: 6 single-digit input boxes
        const inputs = await page.$$('input[maxlength="1"]');
        if (inputs.length >= 6) {
          for (let i = 0; i < 6; i++) {
            await delay(randomDelay(200, 600));
            await inputs[i].click({ clickCount: 3 });
            await inputs[i].type(cleanOtp[i], { delay: 120 + Math.random() * 200 });
          }
        }
      }
    } catch {}

    await delay(randomDelay(800, 1500));

    // Click Confirm/Next — anti-ban: pre-click pause
    await delay(randomDelay(800, 2500));
    const allBtns = await page.$$('button');
    for (const btn of allBtns) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text && /confirm|next|submit/i.test(text)) {
        await btn.click({ delay: randomDelay(200, 500) });
        break;
      }
    }

    await delay(randomDelay(7000, 12000));

    const url = page.url();
    console.log('Final URL:', url);

    // ── Detect ban/suspension/challenge URLs BEFORE treating as success ──
    if (/suspended|challenge|blocked|disabled/i.test(url)) {
      console.log(`ACCOUNT BANNED — final URL after OTP: ${url}`);
      await screenshot(page, 'otp_account_banned');
      const banBodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '');
      let banMessage = '🚫 *Account banned/suspended!*\n\nInstagram flagged this registration and suspended the account immediately.\n\nTry again with:\n• A different email\n• A different proxy/country\n• A different device (already randomized each session)';
      if (banBodyText.length > 10) {
        banMessage += `\n\nInstagram says: "${banBodyText.slice(0, 300)}"`;
      }
      // Clean up
      try { await activeSession.browser?.close(); } catch {}
      activeSession.browser = null;
      activeSession.page = null;
      activeSession.proxyInfo = null;
      return { success: false, message: banMessage };
    }

    // ── Detect "Confirm you're human" captcha/challenge in body ──
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || '');
      if (/confirm\s*(you('re|.?re)\s*)?(a\s*)?human/i.test(bodyText) ||
          /verify\s*you\s*are\s*(a\s*)?human/i.test(bodyText) ||
          /challenge_required/i.test(bodyText)) {
        console.log('CAPTCHA/HUMAN VERIFICATION triggered after OTP — account likely banned');
        await screenshot(page, 'otp_human_verification_ban');
        // Clean up
        try { await activeSession.browser?.close(); } catch {}
        activeSession.browser = null;
        activeSession.page = null;
        activeSession.proxyInfo = null;
        return { success: false, message: `🚫 *Account flagged — human verification required!*\n\nInstagram is asking "Confirm you're human" which means the account is likely banned or under review.\n\nInstagram says: "${bodyText.slice(0, 300)}"\n\nTry again with a different email and proxy.` };
      }
    } catch {}

    if (!url.includes('emailsignup')) {
      // ── Scrape credentials before closing browser ──
      let fullCredMessage = '';
      let storedEmail, storedPassword, storedFullName;
      if (activeSession.formData) {
        const { email, password, fullName } = activeSession.formData;
        storedEmail = email; storedPassword = password; storedFullName = fullName;
        try {
          fullCredMessage = await scrapeAccountCredentials(page, {
            email, password, fullName, username: 'N/A'
          });
        } catch {
          fullCredMessage = `📧 Email: \`${email}\`\n👤 Name: \`${fullName}\`\n🔑 Password: \`${password}\`\n\n🔗 Log in at instagram.com`;
        }
      }

      // ── Store full credentials in session for later (after 2FA setup) ──
      activeSession.acquiredCreds = { email: storedEmail, password: storedPassword, fullName: storedFullName, username: 'N/A' };

      // ── Extract just the TOTP key from the scraped message ──
      const totpKeyOtp = fullCredMessage.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
      const totpKeyOtpVal = totpKeyOtp?.[1] || null;

      await activeSession.browser?.close();
      activeSession.browser = null;
      activeSession.page = null;
      activeSession.proxyInfo = null;

      let setupMsg = '🎉 *Account Created!*\n\n';
      if (totpKeyOtpVal) {
        setupMsg += '🔐 *2FA Setup Key:* Ready — tap the 🔐 2FA Setup button below to reveal it and complete setup.\n\n';
        setupMsg += '📲 *Next step:* Tap the button, add the key to your authenticator app, then send the 6-digit OTP.';
      } else {
        setupMsg += '⚙️ *2FA:* Could not auto-extract the authenticator key.\n';
        setupMsg += 'To get it manually:\n1. Log in → Settings → Account Center\n2. Password and security → Two-factor authentication\n3. Select account → Authentication app → Copy the setup key\n\n';
        setupMsg += `Then send \`/2fa\` to complete setup.`;
      }

      return {
        success: true,
        step: '2fa_setup',
        message: setupMsg,
        _totpKey: totpKeyOtpVal,
      };
    }

    await screenshot(page, 'otp_still_on_signup');
    const igErrOTP = await _scrapeInstagramError(page);
    return {
      success: false,
      message: igErrOTP
        ? `❌ OTP verification failed — still on signup page.\n\nInstagram says: "${igErrOTP}"\n\nCheck the code and try again, or /register to restart.`
        : '❌ OTP verification failed. Check the code and try again, or /register to restart.',
    };

  } catch (error) {
    return {
      success: false,
      message: `❌ Error: ${error?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Complete 2FA authenticator app activation using the OTP from the user's authenticator app.
 *
 * This is called AFTER account registration is complete and the user has:
 * 1. Received the TOTP setup key from the bot
 * 2. Added it to their authenticator app (Google Authenticator, Authy, etc.)
 * 3. Generated an OTP from the authenticator app
 *
 * The bot will:
 * 1. Open a fresh stealth browser with iOS fingerprint
 * 2. Log into Instagram with the account credentials
 * 3. Navigate to 2FA settings → Authentication App
 * 4. Enter the OTP to confirm activation
 * 5. Confirm 2FA is enabled
 *
 * @param {object} creds - { email, password, totpKey (optional if already set) }
 * @param {string} twoFactorOtp - 6-digit OTP from authenticator app
 * @param {string|null} proxyInput - Optional proxy
 * @returns {object} { success, message }
 */
export async function submit2FAOTP(creds, twoFactorOtp, proxyInput = null) {
  const { email, password, totpKey } = creds;
  const cleanOtp = String(twoFactorOtp).replace(/\D/g, '');

  if (!/^\d{6}$/.test(cleanOtp)) {
    return { success: false, message: '2FA OTP must be 6 digits.' };
  }

  if (!email || !password) {
    return { success: false, message: 'Account credentials required. Start /register first.' };
  }

  let browser = null;
  let page = null;

  try {
    // ── Resolve proxy ──
    const proxy = await resolveProxy(proxyInput, { sessionId: email.replace(/[^a-zA-Z0-9]/g, '') });
    const proxyCountry = proxy?.country;
    const proxyServer = proxy?.server;

    // ── Pick an iOS device ──
    const device = randomIOSDevice();
    console.log(`[2FA] Launching iOS browser as ${device.name} for 2FA activation...`);

    // ── Launch stealth browser with iOS fingerprint ──
    puppeteer.use(StealthPlugin());

    // ── Resolve Chromium binary path (same logic as startRegistration) ──
    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    if (executablePath) {
      console.log(`[2FA] Using PUPPETEER_EXECUTABLE_PATH env: ${executablePath}`);
    }

    if (!executablePath) {
      const chromiumPathFile = path.resolve('.chromium-path');
      try {
        if (fs.existsSync(chromiumPathFile)) {
          const cached = fs.readFileSync(chromiumPathFile, 'utf8').trim();
          if (cached && fs.existsSync(cached)) { executablePath = cached; }
        }
      } catch (_) {}
    }

    if (!executablePath) {
      const playwrightCacheDir = path.join(
        process.env.PLAYWRIGHT_BROWSERS_PATH ||
          (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')),
        'ms-playwright'
      );
      try {
        if (fs.existsSync(playwrightCacheDir)) {
          for (const entry of fs.readdirSync(playwrightCacheDir)) {
            if (!entry.startsWith('chromium') || entry.includes('headless')) continue;
            for (const sub of ['chrome-linux64', 'chrome-linux']) {
              const bin = path.join(playwrightCacheDir, entry, sub, 'chrome');
              if (fs.existsSync(bin)) { executablePath = bin; break; }
            }
            if (executablePath) break;
          }
        }
      } catch (e) { console.log(`[2FA] Cache scan failed: ${e.message}`); }
    }

    if (!executablePath) {
      try {
        const pwPath = chromium.executablePath();
        if (pwPath && fs.existsSync(pwPath)) executablePath = pwPath;
      } catch (_) {}
    }

    if (!executablePath) {
      console.log('[2FA] No Playwright chromium found — falling back to Puppeteer auto-discovery');
    } else {
      console.log(`[2FA] Using Chromium at: ${executablePath}`);
    }

    const launchOptions = {
      headless: 'new',
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        `--window-size=${device.viewport.w},${device.viewport.h}`,
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-features=BlockInsecurePrivateNetworkRequests',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
      ],
      ignoreHTTPSErrors: true,
    };

    if (proxyServer) {
      launchOptions.args.push(`--proxy-server=${proxyServer}`);
    }

    browser = await puppeteer.launch(launchOptions);
    page = await browser.newPage();

    // ── Set iOS viewport ──
    await page.setViewport({
      width: device.viewport.w,
      height: device.viewport.h,
      deviceScaleFactor: device.viewport.dpr,
      isMobile: true,
      hasTouch: true,
    });

    // ── Override navigator properties for iOS ──
    await page.setUserAgent(device.ua);
    const { webglVendor, webglRenderer, concurrency, deviceMem, colorDepth, pixelDepth } = device;

    await page.evaluateOnNewDocument(({ webglVendor, webglRenderer, concurrency, deviceMem, colorDepth, pixelDepth, platform }) => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      Object.defineProperty(navigator, 'platform', { get: () => platform, configurable: true });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => concurrency, configurable: true });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => deviceMem, configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });

      try {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => ({
            brands: [
              { brand: 'Google Chrome', version: '131' },
              { brand: 'Chromium', version: '131' },
              { brand: 'Not?A_Brand', version: '24' },
            ],
            mobile: true,
            platform: 'iPhone',
            getHighEntropyValues: async (hints) => {
              const result = {};
              if (hints.includes('platform')) result.platform = 'iPhone';
              if (hints.includes('platformVersion')) result.platformVersion = '17.0';
              if (hints.includes('architecture')) result.architecture = '';
              if (hints.includes('model')) result.model = '';
              if (hints.includes('uaFullVersion')) result.uaFullVersion = '131.0.6778.135';
              if (hints.includes('bitness')) result.bitness = '64';
              if (hints.includes('fullVersionList')) {
                result.fullVersionList = [
                  { brand: 'Google Chrome', version: '131.0.6778.135' },
                  { brand: 'Chromium', version: '131.0.6778.135' },
                  { brand: 'Not?A_Brand', version: '24.0.0.0' },
                ];
              }
              return result;
            },
          }),
          configurable: true,
        });
      } catch (_) {}

      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => { const arr = []; arr.item = () => null; arr.namedItem = () => null; arr.refresh = () => {}; return arr; },
          configurable: true,
        });
        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => { const arr = []; arr.item = () => null; arr.namedItem = () => null; return arr; },
          configurable: true,
        });
      } catch (_) {}

      try {
        const getParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
          if (param === 37445) return webglVendor;
          if (param === 37446) return webglRenderer;
          return getParam.call(this, param);
        };
      } catch (_) {}

      Object.defineProperty(screen, 'colorDepth', { get: () => colorDepth });
      Object.defineProperty(screen, 'pixelDepth', { get: () => pixelDepth });
      Object.defineProperty(window, 'outerWidth', { get: () => screen.width, configurable: true });
      Object.defineProperty(window, 'outerHeight', { get: () => screen.height, configurable: true });

      try {
        navigator.getBattery = () => Promise.resolve({
          charging: true, chargingTime: 0, dischargingTime: Infinity,
          level: 0.7 + Math.random() * 0.25, onchargingchange: null, onchargingtimechange: null,
          ondischargingtimechange: null, onlevelchange: null,
        });
      } catch (_) {}
    }, { webglVendor, webglRenderer, concurrency, deviceMem, colorDepth, pixelDepth, platform: device.platform });

    // ── Proxy auth ──
    if (proxy && proxy.username && proxy.password) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    // ── Navigate to Instagram login ──
    console.log('[2FA] Navigating to Instagram login...');
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await delay(2000 + Math.random() * 2000);

    // ── Login ──
    console.log('[2FA] Logging in...');
    // Fill username
    const usernameInput = await page.$('input[name="username"]');
    if (usernameInput) {
      await usernameInput.click({ clickCount: 3 });
      await usernameInput.type(email, { delay: 80 + Math.random() * 120 });
    }
    // Fill password
    const passwordInput = await page.$('input[name="password"]');
    if (passwordInput) {
      await passwordInput.click({ clickCount: 3 });
      await passwordInput.type(password, { delay: 80 + Math.random() * 120 });
    }
    // Click login button
    const loginBtn = await page.$('button[type="submit"]');
    if (loginBtn) {
      await loginBtn.click();
    }
    await delay(5000 + Math.random() * 3000);

    // ── Check for "Save Login Info" / "Not Now" popup ──
    try {
      const notNowFound = await page.evaluate(() => {
        const btns = document.querySelectorAll('button, span, div[role="button"], a');
        for (const btn of btns) {
          if (/not\s*now/i.test(btn.textContent || '')) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (notNowFound) console.log('[2FA] Dismissed "Not Now" popup');
    } catch {}
    await delay(2000 + Math.random() * 1000);

    // ── Navigate to 2FA settings ──
    console.log('[2FA] Navigating to 2FA authentication app settings...');
    await page.goto('https://www.instagram.com/accounts/two_factor_authentication/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await delay(3000 + Math.random() * 2000);

    // ── Find and click "Authentication App" option ──
    let authAppFound = await page.evaluate(() => {
      const els = document.querySelectorAll('button, span, div[role="button"], a, div');
      for (const el of els) {
        const text = (el.textContent || '').trim();
        if (/authentication\s*app/i.test(text) && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (authAppFound) console.log('[2FA] Clicked Authentication App option');
    await delay(3000 + Math.random() * 2000);

    // ── If not on 2FA page, try alternative URL ──
    if (!authAppFound) {
      console.log('[2FA] Trying alternative: navigating to Account Center...');
      try {
        await page.goto('https://accountscenter.instagram.com/password_and_security/two_factor_authentication/', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        await delay(3000 + Math.random() * 2000);

        // Try clicking authentication app again
        const authAppFound2 = await page.evaluate(() => {
          const els = document.querySelectorAll('button, span, div[role="button"], a, div');
          for (const el of els) {
            const text = (el.textContent || '').trim();
            if (/authentication\s*app/i.test(text) && el.offsetParent !== null) {
              el.click();
              return true;
            }
          }
          return false;
        });
        if (authAppFound2) {
          authAppFound = true;
          console.log('[2FA] Clicked Authentication App option (Account Center)');
        }
        await delay(3000 + Math.random() * 2000);
      } catch {}
    }

    // ── If we still can't find it, try direct URL to 2FA setup ──
    if (!authAppFound) {
      console.log('[2FA] Trying direct 2FA setup URL...');
      await page.goto('https://www.instagram.com/accounts/two_factor_authentication/?next=%2F', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await delay(3000 + Math.random() * 2000);
    }

    // ── Enter OTP from authenticator app ──
    console.log(`[2FA] Entering authenticator OTP: ${cleanOtp}`);
    const allInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
    let otpEntered = false;

    // Try single input first
    for (const inp of allInputs) {
      const box = await inp.boundingBox().catch(() => null);
      if (!box) continue;
      const type = await inp.evaluate(el => el.type || '').catch(() => '');
      if (type === 'tel' || type === 'text' || type === 'number') {
        await inp.click({ clickCount: 3 });
        await inp.type(cleanOtp, { delay: 100 + Math.random() * 150 });
        otpEntered = true;
        console.log('[2FA] Entered OTP into single input');
        break;
      }
    }

    // Fallback: 6 individual digit boxes
    if (!otpEntered) {
      const digitInputs = await page.$$('input[maxlength="1"]');
      if (digitInputs.length >= 6) {
        for (let i = 0; i < 6; i++) {
          await delay(200 + Math.random() * 400);
          await digitInputs[i].click({ clickCount: 3 });
          await digitInputs[i].type(cleanOtp[i], { delay: 100 + Math.random() * 150 });
        }
        otpEntered = true;
        console.log('[2FA] Entered OTP into 6 individual boxes');
      }
    }

    if (!otpEntered) {
      // Try to find and enter the setup key first, then OTP
      console.log('[2FA] No OTP input found. Trying to enter setup key first...');
      if (totpKey) {
        for (const inp of allInputs) {
          const box = await inp.boundingBox().catch(() => null);
          if (!box) continue;
          await inp.click({ clickCount: 3 });
          await inp.type(totpKey, { delay: 80 + Math.random() * 100 });
          console.log('[2FA] Entered TOTP setup key');
          break;
        }
        await delay(2000 + Math.random() * 1000);

        // Click Next/Continue
        const btns = await page.$$('button');
        for (const btn of btns) {
          const text = await page.evaluate(el => el.textContent, btn);
          if (text && /next|continue|confirm|done/i.test(text)) {
            await btn.click();
            console.log('[2FA] Clicked Next/Continue button');
            break;
          }
        }
        await delay(3000 + Math.random() * 2000);

        // Now try entering OTP again
        const freshInputs = await page.$$('input:not([type="hidden"]):not([type="submit"])');
        for (const inp of freshInputs) {
          const box = await inp.boundingBox().catch(() => null);
          if (!box) continue;
          const type = await inp.evaluate(el => el.type || '').catch(() => '');
          if (type === 'tel' || type === 'text' || type === 'number') {
            await inp.click({ clickCount: 3 });
            await inp.type(cleanOtp, { delay: 100 + Math.random() * 150 });
            otpEntered = true;
            console.log('[2FA] Entered OTP after setup key');
            break;
          }
        }
      }

      if (!otpEntered) {
        await browser.close();
        return {
          success: false,
          message: '❌ Could not find OTP input on 2FA page. The account may not have 2FA setup initiated. Try logging in manually and setting up 2FA, then use the authenticator app.',
        };
      }
    }

    await delay(1500 + Math.random() * 1000);

    // ── Click Confirm/Next/Done button ──
    const allBtns = await page.$$('button');
    for (const btn of allBtns) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text && /confirm|next|submit|done|activate|verify|turn on/i.test(text)) {
        await btn.click();
        console.log(`[2FA] Clicked "${text.trim()}" button`);
        break;
      }
    }

    await delay(5000 + Math.random() * 3000);

    // ── Check for success indicators ──
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');

    const successIndicators = [
      /two.factor.*(is on|enabled|active|set up)/i,
      /authentication app.*(is on|enabled|active|set up)/i,
      /2fa.*(is on|enabled|active)/i,
      /two-factor authentication is on/i,
      /you('re|.?re) all set/i,
      /successfully/i,
    ];

    const isSuccess = successIndicators.some(pattern => pattern.test(bodyText));

    await browser.close();

    // ── Build full credential dump on success ──
    const fullCreds = activeSession.acquiredCreds;
    let credBlock = '';
    if (fullCreds && fullCreds.email) {
      credBlock += `\n\n📧 *Login Email:* \`${fullCreds.email}\`\n`;
      credBlock += `🔑 *Password:* \`${fullCreds.password}\`\n`;
      credBlock += `👤 *Name:* \`${fullCreds.fullName}\`\n`;
      credBlock += `🔤 *Username:* \`${fullCreds.username || 'N/A'}\`\n`;
      if (totpKey) {
        credBlock += `🔐 *2FA Key:* \`${totpKey}\`\n`;
      }
      credBlock += `\n🔗 Log in at instagram.com`;
    }

    if (isSuccess) {
      return {
        success: true,
        message: '✅ *2FA Activated!*\n\nYour Instagram account now has two-factor authentication enabled via authenticator app.' + credBlock,
      };
    }

    // Even without explicit success text, if we got this far, it likely worked
    return {
      success: true,
      message: '✅ *2FA Activation Completed*\n\nThe authenticator OTP was submitted. Please verify 2FA is enabled by checking your Instagram security settings.' + credBlock,
    };

  } catch (error) {
    console.error('[2FA] Error:', error?.message || error);
    try { await browser?.close(); } catch {}
    return {
      success: false,
      message: `❌ 2FA activation error: ${error?.message || 'Unknown error'}`,
    };
  }
}

export function getStatus() {
  return activeSession.browser ? 'active' : 'inactive';
}

export function getActiveProxy() {
  return activeSession.proxyInfo;
}

// Simple delay helper (puppeteer doesn't have page.waitForTimeout)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
