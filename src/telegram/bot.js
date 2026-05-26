import { Telegraf, session, Markup } from 'telegraf';
import { startRegistration, submitOTP, submitEmailCode, submitPassword, submitNameAndFinish, submitUsername, submit2FAOTP } from '../instagram/registration.js';
import { SUPPORTED_COUNTRIES, normalizeCountry, HAS_PROXY, getProxySummary, healthCheckAll, getBestProxy } from '../instagram/proxy.js';

export async function createBot() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in .env file');
  }

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: 300_000 });
  bot.use(session());

  bot.use((ctx, next) => {
    if (!ctx.session) {
      ctx.session = {
        step: 'idle',
        fullName: null,
        email: null,
        password: null,
        proxy: null,
        bulkMode: false,
        username: null,
        creds: null, // { email, password, totpKey } for /2fa flow
      };
    }
    return next();
  });

  // ── Persistent reply keyboard (always visible at bottom of chat) ──
  const mainKeyboard = [
    ['📝 Register', '🔐 2FA Setup'],
    ['🌍 Proxy', '📊 Proxy Status'],
    ['🌐 Countries', '❓ Help'],
    ['❌ Cancel'],
  ];

  // Helper: reply with text + persistent keyboard
  function replyWithKeyboard(ctx, text, extra = {}) {
    return ctx.reply(text, { ...Markup.keyboard(mainKeyboard).resize(), ...extra });
  }

  // Start
  bot.start(async (ctx) => {
    ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: null };
    await replyWithKeyboard(ctx,
      '📸 *Instagram Auto Creator*\n\n' +
      'Tap a button below or send /register to create an account.\n\n' +
      '🔹 *Bulk mode* — send all details at once:\n' +
      '`First name: David`\n' +
      '`Login: david_2024`\n' +
      '`Password: Str0ngP@ss`\n' +
      '`Email: test@gmail.com`\n\n' +
      '🔹 *Step-by-step* — send just an email and follow prompts.\n\n' +
      'Optional: `/proxy US` for a country-based proxy.',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Shared command handler functions (used by both /commands and keyboard buttons) ──

  async function handleRegister(ctx) {
    ctx.session.step = 'waiting_details';
    const countries = SUPPORTED_COUNTRIES.slice(0, 12).join(', ').toUpperCase();
    await ctx.reply(
      '📧 *Send your account details*\n\n' +
      '🔹 *Bulk* — paste all details together:\n' +
      '`First name: YourName`\n' +
      '`Login: your_username`\n' +
      '`Password: YourP@ss123`\n' +
      '`Email: your@email.com`\n\n' +
      '🔹 *Quick* — just the email:\n' +
      '`test@gmail.com`\n' +
      '`test@gmail.com|us`\n\n' +
      `🌍 Countries: ${countries}...\n` +
      '(/countries for full list)',
      { parse_mode: 'Markdown' }
    );
  }

  async function handleCountries(ctx) {
    const all = SUPPORTED_COUNTRIES.map(c => `\`${c.toUpperCase()}\``).join(', ');
    await ctx.reply(`🌍 *Supported proxy countries:*\n\n${all}\n\nUse any in: \`name|email|password|country\``, { parse_mode: 'Markdown' });
  }

  // Helper: convert country code to flag emoji
  function countryFlag(cc) {
    if (!cc || cc.length !== 2) return '';
    const code = cc.toUpperCase();
    return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  }

  // Keyboard button labels that trigger handleProxy (used to detect button taps)
  const proxyButtonLabels = ['🌍 Proxy', '📡 Proxy'];

  async function handleProxy(ctx) {
    const rawText = ctx.message.text.trim();
    // If triggered via keyboard button (text IS the button label), toggle: enable ↔ disable
    const isButtonTap = proxyButtonLabels.includes(rawText);

    const arg = isButtonTap ? '' : rawText.split(/\s+/).slice(1).join(' ').trim();

    // Button tap → toggle: if proxy is already active, disable it; otherwise enable auto
    if (isButtonTap) {
      if (ctx.session.proxy) {
        // Proxy is active → disable it
        ctx.session.proxy = null;
        ctx.session.step = ctx.session.step === 'waiting_proxy' ? 'idle' : ctx.session.step;
        await ctx.reply('🔓 *Proxy Disabled*\n\nRegistration will now use your own IP address.', { parse_mode: 'Markdown' });
        return;
      }

      // Proxy is not active → enable auto best-proxy mode
      ctx.session.proxy = 'auto';
      ctx.session.step = ctx.session.step === 'waiting_proxy' ? 'idle' : ctx.session.step;

      if (HAS_PROXY) {
        await ctx.reply('🔍 *Scanning proxies for best IP...*', { parse_mode: 'Markdown' });
        try {
          const best = await getBestProxy();
          if (best) {
            const flag = countryFlag(best.country);
            let msg = `🚀 *Auto-Proxy Mode Enabled*\n\n`;
            msg += `🌍 Currently using: ${flag} *${best.country?.toUpperCase()}*\n`;
            msg += `⚡ Latency: \`${best._liveLatencyMs ?? 'N/A'}ms\`\n`;
            msg += `🏷 Provider: \`${best.providerLabel}\`\n\n`;
            msg += 'The bot will dynamically re-pick the *healthiest, lowest-latency* proxy for every registration.\n\n' +
              '💡 Tap 🌍 Proxy again to disable.\n' +
              '💡 Type `/proxy US` to lock to a specific country instead.';
            await ctx.reply(msg, { parse_mode: 'Markdown' });
            return;
          }
        } catch (e) {
          console.error('[proxy] Failed to resolve best proxy:', e.message);
        }
      }

      let msg = '🚀 *Auto-Proxy Mode Enabled*\n\n' +
        'The bot will dynamically pick the *healthiest, lowest-latency* proxy for every registration.\n\n' +
        '✅ No country locking — best IP wins every time.\n\n' +
        '💡 Tap 🌍 Proxy again to disable.\n' +
        '💡 Type `/proxy US` to lock to a specific country instead.';

      if (HAS_PROXY) {
        msg += '\n\n' + getProxySummary();
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      return;
    }

    // ── /proxy (slash command) — always enable auto mode ──
    // No argument → enable "auto" best-proxy mode
    if (!arg || arg.length === 0) {
      ctx.session.proxy = 'auto';
      ctx.session.step = ctx.session.step === 'waiting_proxy' ? 'idle' : ctx.session.step;

      if (HAS_PROXY) {
        await ctx.reply('🔍 *Scanning proxies for best IP...*', { parse_mode: 'Markdown' });
        try {
          const best = await getBestProxy();
          if (best) {
            const flag = countryFlag(best.country);
            let msg = `🚀 *Auto-Proxy Mode Enabled*\n\n`;
            msg += `🌍 Currently using: ${flag} *${best.country?.toUpperCase()}*\n`;
            msg += `⚡ Latency: \`${best._liveLatencyMs ?? 'N/A'}ms\`\n`;
            msg += `🏷 Provider: \`${best.providerLabel}\`\n\n`;
            msg += 'The bot will dynamically re-pick the *healthiest, lowest-latency* proxy for every registration.\n\n' +
              '💡 Tap 🌍 Proxy again to disable.\n' +
              '💡 Type `/proxy US` to lock to a specific country instead.';
            await ctx.reply(msg, { parse_mode: 'Markdown' });
            return;
          }
        } catch (e) {
          console.error('[proxy] Failed to resolve best proxy:', e.message);
        }
      }

      let msg = '🚀 *Auto-Proxy Mode Enabled*\n\n' +
        'The bot will dynamically pick the *healthiest, lowest-latency* proxy for every registration.\n\n' +
        '✅ No country locking — best IP wins every time.\n\n' +
        '💡 Tap 🌍 Proxy again to disable.\n' +
        '💡 Type `/proxy US` to lock to a specific country instead.';

      if (HAS_PROXY) {
        msg += '\n\n' + getProxySummary();
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      return;
    }

    // Country argument passed (e.g., /proxy US)
    const cc = normalizeCountry(arg);
    if (SUPPORTED_COUNTRIES.includes(cc)) {
      ctx.session.proxy = cc.toUpperCase();
      ctx.session.step = ctx.session.step === 'waiting_proxy' ? 'idle' : ctx.session.step;
      await ctx.reply(`✅ Proxy country set: *${cc.toUpperCase()}*\n\nYour registrations will use a ${cc.toUpperCase()} IP.`, { parse_mode: 'Markdown' });
      return;
    }

    // Unknown country — prompt with available list
    const sample = SUPPORTED_COUNTRIES.slice(0, 8).join(', ').toUpperCase();
    let msg = '📡 *Set Proxy Country*\n\n' +
      'Send a country code (2 letters):\n\n' +
      `Examples: \`US\`, \`IN\`, \`GB\`, \`DE\`\n` +
      `Available: ${sample}...\n\n` +
      'This country will be used for all registrations unless you override it in the details format.\n\n' +
      '💡 Tip: `/proxy US` to set directly.\n' +
      '🚀 Tip: `/proxy` (no country) for auto best-IP mode (or just tap the 🌍 Proxy button).';

    if (HAS_PROXY) {
      msg += '\n\n' + getProxySummary();
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
    ctx.session.step = 'waiting_proxy';
  }

  async function handleProxyStatus(ctx) {
    await ctx.reply('🔍 *Checking proxy health...*', { parse_mode: 'Markdown' });
    try {
      const results = await healthCheckAll();
      let msg = `📊 *Proxy Health Report*\n\n`;
      msg += `✅ ${results.okCount} / ${results.total} healthy\n\n`;
      for (const r of results.results) {
        const icon = r.ok ? '✅' : '❌';
        msg += `${icon} *${r.label}*`;
        if (r.ok) {
          msg += ` — IP: \`${r.ip}\` | ${r.latencyMs}ms | ${r.country?.toUpperCase()}`;
        } else {
          msg += ` — ${r.error}`;
        }
        msg += '\n';
      }
      if (!HAS_PROXY) {
        msg += '\n⚠️ No proxy providers configured.';
      }
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Health check failed: ${err.message}`);
    }
  }

  async function handleCancel(ctx) {
    ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: null };
    await replyWithKeyboard(ctx, '❌ Cancelled. Tap a button below or send /register to start.');
  }

  async function handleHelp(ctx) {
    await replyWithKeyboard(ctx,
      '📸 *Help*\n\n' +
      '🔹 *Bulk registration (fastest)*:\n' +
      'Send /register then paste all fields:\n' +
      '`First name: David`\n' +
      '`Login: david_2024`\n' +
      '`Password: Str0ngP@ss`\n' +
      '`Email: test@gmail.com`\n' +
      '→ Bot auto-fills everything after email code!\n\n' +
      '🔹 *Step-by-step registration*:\n' +
      '1. Send /register + your email\n' +
      '2. Bot fills email → sends confirmation code\n' +
      '3. Send the 6-digit code from your inbox\n' +
      '4. Send a password\n' +
      '5. Send your full name\n' +
      '6. Send your username\n' +
      '7. Done! 🎉\n\n' +
      '🔹 *2FA Authenticator Setup*:\n' +
      'After registration, bot scrapes a TOTP key.\n' +
      '1. Add key to Google Authenticator / Authy\n' +
      '2. Send /2fa → enter the 6-digit OTP\n' +
      '3. Bot activates 2FA on your Instagram\n\n' +
      'Commands:\n' +
      '/register - Start new registration\n' +
      '/2fa - Complete authenticator app 2FA setup\n' +
      '/proxy - Set a country for future registrations\n' +
      '/proxystatus - Check health of all proxy providers\n' +
      '/noproxy - Disable proxy\n' +
      '/countries - See all supported proxy countries\n' +
      '/otp - Prompt to enter OTP\n' +
      '/cancel - Cancel current registration',
      { parse_mode: 'Markdown' }
    );
  }

  async function handle2fa(ctx) {
    if (!ctx.session.creds || !ctx.session.creds.email) {
      await ctx.reply(
        '🔐 *2FA Authenticator Setup*\n\n' +
        'No active account credentials found. 2FA setup is available after a successful registration.\n\n' +
        'How it works:\n' +
        '1. After registration, the bot provides a 2FA setup key\n' +
        '2. Add the key to your authenticator app (Google Authenticator, Authy, etc.)\n' +
        '3. Your app generates a 6-digit OTP\n' +
        '4. Send `/2fa` and then enter the 6-digit OTP\n' +
        '5. The bot logs into Instagram and activates 2FA\n\n' +
        '⚠️ Register an account first with /register',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    ctx.session.step = 'waiting_2fa_otp';
    let authMsg = '🔐 *2FA Authenticator Setup*\n\n';
    authMsg += `👤 Account: \`${ctx.session.creds.email}\`\n`;
    if (ctx.session.creds.totpKey) {
      authMsg += `🔑 Key: \`${ctx.session.creds.totpKey}\`\n`;
    }
    authMsg += '\nSend the 6-digit OTP from your authenticator app to activate 2FA on this Instagram account.';
    await ctx.reply(authMsg, { parse_mode: 'Markdown' });
  }

  // ── Register slash-commands ──
  bot.command('register', handleRegister);
  bot.command('countries', handleCountries);
  bot.command('proxy', handleProxy);
  bot.command('proxystatus', handleProxyStatus);
  bot.command('cancel', handleCancel);
  bot.command('help', handleHelp);
  bot.command('2fa', handle2fa);

  // ── Register keyboard button handlers (same functions as commands) ──
  bot.hears('📝 Register', handleRegister);
  bot.hears('🌐 Countries', handleCountries);
  bot.hears('🌍 Proxy', handleProxy);
  bot.hears('📊 Proxy Status', handleProxyStatus);
  bot.hears('❌ Cancel', handleCancel);
  bot.hears('❓ Help', handleHelp);
  bot.hears('🔐 2FA Setup', handle2fa);

  // No proxy command (slash only, no keyboard button)
  bot.command('noproxy', async (ctx) => {
    ctx.session.proxy = null;
    ctx.session.step = ctx.session.step === 'waiting_proxy' ? 'idle' : ctx.session.step;
    await ctx.reply('🔓 Proxy disabled. Registration will use your own IP.');
  });

  // OTP (slash only, no keyboard button)
  bot.command('otp', async (ctx) => {
    if (ctx.session.step === 'idle') {
      await ctx.reply('No active session. Send /register first.');
    } else {
      ctx.session.step = 'waiting_otp';
      await ctx.reply('🔐 Send me your 6-digit OTP.');
    }
  });

  // ── Bulk auto-fill: chains password → name → username after email code is accepted ──
  async function chainBulkAutoFill(ctx) {
    await ctx.reply('🔑 *Auto-filling password...*', { parse_mode: 'Markdown' });
    const passResult = await submitPassword(ctx.session.password);
    await ctx.reply(passResult.message, passResult.success ? { parse_mode: 'Markdown' } : undefined);

    if (!passResult.success) {
      ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: null };
      await ctx.reply('❌ Bulk auto-fill stopped — password rejected.');
      return;
    }

    if (passResult.step === 'name_required') {
      await ctx.reply('👤 *Auto-filling name...*', { parse_mode: 'Markdown' });
      const nameResult = await submitNameAndFinish(ctx.session.fullName);
      await ctx.reply(nameResult.message, nameResult.success ? { parse_mode: 'Markdown' } : undefined);

      if (!nameResult.success) {
        ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: null };
        await ctx.reply('❌ Bulk auto-fill stopped — name rejected.');
        return;
      }

      if (nameResult.step === 'username_required') {
        await ctx.reply('🔤 *Auto-filling username...*', { parse_mode: 'Markdown' });
        await ctx.reply('⏳ _Typing username, detecting birthday fields, and submitting to Instagram. This may take up to 2 minutes._', { parse_mode: 'Markdown' });
        const userResult = await submitUsername(ctx.session.username);
        await ctx.reply(userResult.message, userResult.success ? { parse_mode: 'Markdown' } : undefined);

        if (userResult.success && userResult.step === 'otp_required') {
          ctx.session.step = 'waiting_otp';
        } else if (userResult.success && (userResult.step === 'complete' || userResult.step === '2fa_setup')) {
          const tfm = userResult.message.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
          ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email: ctx.session.email, password: ctx.session.password, totpKey: tfm?.[1] || userResult._totpKey || null } };
          if (userResult.step === '2fa_setup' && (tfm?.[1] || userResult._totpKey)) {
            ctx.session.step = 'waiting_2fa_otp';
          }
        } else {
          ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: null };
        }
      } else if (nameResult.step === 'otp_required') {
        ctx.session.step = 'waiting_otp';
      } else if (nameResult.step === 'complete' || nameResult.step === '2fa_setup') {
        const tfm2 = nameResult.message.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
        ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email: ctx.session.email, password: ctx.session.password, totpKey: tfm2?.[1] || nameResult._totpKey || null } };
        if (nameResult.step === '2fa_setup' && (tfm2?.[1] || nameResult._totpKey)) {
          ctx.session.step = 'waiting_2fa_otp';
        }
      }
    } else if (passResult.step === 'otp_required') {
      ctx.session.step = 'waiting_otp';
    } else if (passResult.step === 'complete' || passResult.step === '2fa_setup') {
      const tfm3 = passResult.message.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
      ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email: ctx.session.email, password: ctx.session.password, totpKey: tfm3?.[1] || passResult._totpKey || null } };
      if (passResult.step === '2fa_setup' && (tfm3?.[1] || passResult._totpKey)) {
        ctx.session.step = 'waiting_2fa_otp';
      }
    }
  }

  // Handle text
  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    
    if (text.startsWith('/')) return;

    // Proxy input – accept country codes, country names, or "proxy"/"auto" keyword
    if (ctx.session.step === 'waiting_proxy') {
      const countryInput = text.replace(/[^a-zA-Z\s]/g, '').trim();
      // "proxy" or "auto" keyword → auto best-proxy mode
      if (/^(proxy|auto)$/i.test(countryInput)) {
        ctx.session.proxy = 'auto';
        ctx.session.step = 'idle';
        await ctx.reply('🚀 *Auto-Proxy Mode Enabled*\n\nThe bot will pick the healthiest, lowest-latency proxy for every registration.\n\n💡 Tip: send a country code (e.g., `US`) to lock to that country.', { parse_mode: 'Markdown' });
        return;
      }
      if (!countryInput || countryInput.length < 2) {
        await ctx.reply('Please send a valid country code (e.g., `US`, `IN`), country name (e.g., `India`, `Germany`), or `proxy` for auto best-proxy mode.');
        return;
      }
      const cc = normalizeCountry(countryInput);
      if (!SUPPORTED_COUNTRIES.includes(cc)) {
        await ctx.reply(`❌ Country "${countryInput}" not supported. Use /countries to see the full list.\n\n💡 Or type \`proxy\` for auto best-proxy mode.`, { parse_mode: 'Markdown' });
        return;
      }
      ctx.session.proxy = cc.toUpperCase();
      ctx.session.step = 'idle';
      await ctx.reply(`✅ Proxy country set: *${cc.toUpperCase()}*\n\nYour registrations will use a ${cc.toUpperCase()} IP.\n\n💡 For auto best-IP: send \`proxy\` instead of a country.`, { parse_mode: 'Markdown' });
      return;
    }

    // Waiting for details (email step)
    if (ctx.session.step === 'waiting_details') {
      // ── Detect bulk format: multi-line "First name:", "Login:", "Password:", "Email:" ──
      const bulkPattern = /^(first\s*name|full\s*name|name)\s*:\s*(.+)$/im;
      const isBulk = bulkPattern.test(text) && /(?:login|username)\s*:\s*(.+)/im.test(text);

      if (isBulk) {
        // Parse bulk format
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let parsedName = null;
        let parsedLogin = null;
        let parsedPassword = null;
        let parsedEmail = null;
        let parsedCountry = null;

        for (const line of lines) {
          const kvMatch = line.match(/^(first\s*name|full\s*name|name|login|username|password|email|country|proxy)\s*:\s*(.+)$/i);
          if (kvMatch) {
            const key = kvMatch[1].toLowerCase().replace(/\s+/g, '');
            const val = kvMatch[2].trim();
            if (key === 'firstname' || key === 'fullname' || key === 'name') {
              parsedName = val;
            } else if (key === 'login' || key === 'username') {
              parsedLogin = val;
            } else if (key === 'password') {
              parsedPassword = val;
            } else if (key === 'email') {
              // Strip |proxy, |auto, or |XX country suffix from email value
              const emailSuffixMatch = val.match(/^(.+?)\s*\|\s*([a-zA-Z]{2,6})\s*$/);
              if (emailSuffixMatch) {
                parsedEmail = emailSuffixMatch[1].trim();
                const suffix = emailSuffixMatch[2].toLowerCase();
                if (suffix === 'proxy' || suffix === 'auto') {
                  parsedCountry = 'auto';
                } else {
                  parsedCountry = suffix;
                }
              } else {
                parsedEmail = val;
              }
            } else if (key === 'country' || key === 'proxy') {
              parsedCountry = val;
            }
          }
        }

        // Validate required fields
        if (!parsedEmail || !parsedEmail.includes('@')) {
          await ctx.reply('❌ Bulk format requires a valid email.\n\nSend all 4 fields:\n`First name: David`\n`Login: david_2024`\n`Password: Str0ngP@ss`\n`Email: test@gmail.com`', { parse_mode: 'Markdown' });
          return;
        }
        if (!parsedName || parsedName.length < 2) {
          await ctx.reply('❌ Bulk format requires a name (at least 2 characters).\n\nSend:\n`First name: David`', { parse_mode: 'Markdown' });
          return;
        }
        if (!parsedPassword || parsedPassword.length < 6) {
          await ctx.reply('❌ Bulk format requires a password (at least 6 characters).\n\nSend:\n`Password: Str0ngP@ss`', { parse_mode: 'Markdown' });
          return;
        }
        if (!parsedLogin || parsedLogin.length < 1) {
          await ctx.reply('❌ Bulk format requires a username/login.\n\nSend:\n`Login: my_user123`', { parse_mode: 'Markdown' });
          return;
        }

        // Store all fields in session for later auto-fill
        ctx.session.email = parsedEmail;
        ctx.session.fullName = parsedName;
        ctx.session.password = parsedPassword;
        ctx.session.username = parsedLogin;
        ctx.session.bulkMode = true;

        // Resolve proxy country — "proxy"/"auto" = auto best-proxy
        let proxyCountry = ctx.session.proxy;
        if (parsedCountry) {
          const raw = parsedCountry.replace(/[^a-zA-Z]/g, '').toLowerCase();
          if (raw === 'proxy' || raw === 'auto') {
            proxyCountry = 'auto';
          } else if (raw.length >= 2) {
            const cc = normalizeCountry(raw);
            if (SUPPORTED_COUNTRIES.includes(cc)) {
              proxyCountry = cc;
            }
          }
        }
        ctx.session.proxy = proxyCountry;
        ctx.session.step = 'registering';

        const proxyText = proxyCountry === 'auto'
          ? '\n🚀 Auto best-proxy (lowest latency)'
          : proxyCountry
            ? `\n🌍 Using ${proxyCountry.toUpperCase()} proxy`
            : '\n🔓 No proxy (your IP)';
        const loadingMsg = await ctx.reply(
          '📋 *Bulk registration started*\n\n' +
          `👤 Name: \`${parsedName}\`\n` +
          `🔤 Username: \`${parsedLogin}\`\n` +
          `📧 Email: \`${parsedEmail}\`\n` +
          `🔑 Password: \`${parsedPassword}\`\n` +
          proxyText + '\n\n' +
          '🚀 Filling email on Instagram...',
          { parse_mode: 'Markdown' }
        );

        const result = await startRegistration({
          fullName: parsedName,
          email: parsedEmail,
          password: parsedPassword,
        }, proxyCountry);

        if (!result.success && result.screenshot) {
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id, loadingMsg.message_id, undefined,
              '❌ ' + result.message, { parse_mode: 'Markdown' }
            );
            await ctx.replyWithPhoto({ source: result.screenshot });
          } catch {
            await ctx.telegram.editMessageText(
              ctx.chat.id, loadingMsg.message_id, undefined, result.message, undefined
            );
          }
        } else if (!result.success) {
          await ctx.telegram.editMessageText(
            ctx.chat.id, loadingMsg.message_id, undefined,
            '❌ ' + result.message, { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.telegram.editMessageText(
            ctx.chat.id, loadingMsg.message_id, undefined,
            result.message, { parse_mode: 'Markdown' }
          );
        }

        if (result.success && result.step === 'email_code_required') {
          ctx.session.step = 'waiting_email_code';
          return;
        }
        if (result.success && result.step === 'complete') {
          const tfmBulkReg = result.message.match(/2FA.*Key:.*?`([A-Z2-7]{16,52})`/);
          ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email: parsedEmail, password: parsedPassword, totpKey: tfmBulkReg?.[1] || null } };
        } else if (result.success) {
          ctx.session.step = 'waiting_otp';
        } else {
          ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: null };
        }
        return;
      }

      // ── Regular mode: just email or email|country ──
      const parts = text.split('|').map(p => p.trim());
      const email = parts[0];
      
      if (!email || !email.includes('@')) {
        await ctx.reply('Please send a valid email.\n\nFormat: `email` or `email|country`\n\nOr use bulk format:\n`First name: David`\n`Login: david_2024`\n`Password: Str0ngP@ss`\n`Email: test@gmail.com`', { parse_mode: 'Markdown' });
        return;
      }

      ctx.session.email = email;

      // Parse 2nd field as country code for proxy, or "proxy"/"auto" keyword
      let proxyCountry = ctx.session.proxy;
      if (parts[1]) {
        const raw = parts[1].replace(/[^a-zA-Z]/g, '').toLowerCase();
        if (raw === 'proxy' || raw === 'auto') {
          proxyCountry = 'auto';
        } else if (raw.length >= 2) {
          const cc = normalizeCountry(raw);
          if (SUPPORTED_COUNTRIES.includes(cc)) {
            proxyCountry = cc;
          } else {
            await ctx.reply(`❌ Unknown country: "${parts[1]}".\nUse /countries to see supported countries.\n\nProceeding without proxy...`);
            proxyCountry = null;
          }
        }
      }
      ctx.session.proxy = proxyCountry;
      ctx.session.step = 'registering';

      const proxyText2 = proxyCountry === 'auto'
        ? '\n🚀 Auto best-proxy (lowest latency)'
        : proxyCountry
          ? `\n🌍 Using ${proxyCountry.toUpperCase()} proxy`
          : '\n🔓 No proxy (your IP)';
      const loadingMsg2 = await ctx.reply(
        '🚀 *Processing...*\n\n' +
        'Filling email on Instagram.\n' +
        'Please wait 15-30 seconds...' + proxyText2,
        { parse_mode: 'Markdown' }
      );

      const result2 = await startRegistration({
        fullName: 'Pending',
        email: email,
        password: 'Pending',
      }, proxyCountry);

      if (!result2.success && result2.screenshot) {
        try {
          await ctx.replyWithPhoto({ source: result2.screenshot }, { caption: result2.message });
        } catch {
          await ctx.telegram.editMessageText(
            ctx.chat.id, loadingMsg2.message_id, undefined, result2.message, undefined
          );
        }
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id, loadingMsg2.message_id, undefined, result2.message,
          result2.success ? { parse_mode: 'Markdown' } : undefined
        );
      }

      if (result2.success && result2.step === 'email_code_required') {
        ctx.session.step = 'waiting_email_code';
        return;
      }
      if (result2.success && (result2.step === 'complete' || result2.step === '2fa_setup')) {
        const tfmStepReg = result2.message.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
        ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email, password: 'Pending', totpKey: tfmStepReg?.[1] || result2._totpKey || null } };
        if (result2.step === '2fa_setup' && (tfmStepReg?.[1] || result2._totpKey)) {
          ctx.session.step = 'waiting_2fa_otp';
        }
      } else if (result2.success) {
        ctx.session.step = 'waiting_otp';
      } else {
        ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: null };
      }
      return;
    }

    // Waiting for email confirmation code (iOS mobile wizard)
    if (ctx.session.step === 'waiting_email_code') {
      const code = text.replace(/\D/g, '');

      if (!/^\d{6}$/.test(code)) {
        await ctx.reply('Code must be 6 digits. Check your email inbox and spam folder.');
        return;
      }

      await ctx.reply('⏳ *Submitting confirmation code...*', { parse_mode: 'Markdown' });
      const result = await submitEmailCode(code);
      await ctx.reply(result.message, result.success ? { parse_mode: 'Markdown' } : undefined);

      if (result.success && result.step === 'password_required') {
        // Bulk mode: auto-fill remaining fields (password → name → username)
        if (ctx.session.bulkMode && ctx.session.password && ctx.session.fullName && ctx.session.username) {
          await ctx.reply('⚡ *Bulk mode* — auto-filling remaining fields...', { parse_mode: 'Markdown' });
          await chainBulkAutoFill(ctx);
          return;
        }
        ctx.session.step = 'waiting_password';
      } else if (result.success && result.step === 'otp_required') {
        ctx.session.step = 'waiting_otp';
      } else if (result.success && (result.step === 'complete' || result.step === '2fa_setup')) {
        const tfmEC = result.message.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
        ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email: ctx.session.email, password: ctx.session.password, totpKey: tfmEC?.[1] || result._totpKey || null } };
        if (result.step === '2fa_setup' && (tfmEC?.[1] || result._totpKey)) {
          ctx.session.step = 'waiting_2fa_otp';
        }
      }
      // On error, keep session so user can retry entering the code
      // Only reset on complete or if session truly expired
      return;
    }

    // Waiting for password (after email code accepted)
    if (ctx.session.step === 'waiting_password') {
      const password = text.trim();
      
      if (password.length < 6) {
        await ctx.reply('Password must be at least 6 characters. Try a stronger password.');
        return;
      }

      await ctx.reply('⏳ *Setting password...*', { parse_mode: 'Markdown' });
      const result = await submitPassword(password);
      await ctx.reply(result.message, result.success ? { parse_mode: 'Markdown' } : undefined);

      if (result.success && result.step === 'name_required') {
        ctx.session.step = 'waiting_name';
      }
      // On error, keep session so user can retry with a stronger password
      return;
    }

    // Waiting for full name (via submitNameAndFinish — now returns username_required)
    if (ctx.session.step === 'waiting_name') {
      const fullName = text.trim();
      
      if (fullName.length < 2) {
        await ctx.reply('Name must be at least 2 characters.');
        return;
      }

      await ctx.reply('⏳ *Filling name...*', { parse_mode: 'Markdown' });
      const result = await submitNameAndFinish(fullName);
      await ctx.reply(result.message, result.success ? { parse_mode: 'Markdown' } : undefined);

      if (result.success && result.step === 'username_required') {
        ctx.session.step = 'waiting_username';
      } else if (result.success && result.step === 'otp_required') {
        ctx.session.step = 'waiting_otp';
      } else if (result.success && (result.step === 'complete' || result.step === '2fa_setup')) {
        const tfmName = result.message.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
        ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email: ctx.session.email, password: ctx.session.password, totpKey: tfmName?.[1] || result._totpKey || null } };
        if (result.step === '2fa_setup' && (tfmName?.[1] || result._totpKey)) {
          ctx.session.step = 'waiting_2fa_otp';
        }
      }
      // On error, keep session so user can retry with a different name
      return;
    }

    // Waiting for username (final step — submits via submitUsername)
    if (ctx.session.step === 'waiting_username') {
      const username = text.trim();

      if (username.length < 1 || username.length > 30) {
        await ctx.reply('Username must be 1–30 characters. Letters, numbers, underscores, and periods only.');
        return;
      }

      await ctx.reply('⏳ *Submitting profile...*', { parse_mode: 'Markdown' });
      const result = await submitUsername(username);
      await ctx.reply(result.message, result.success ? { parse_mode: 'Markdown' } : undefined);

      if (result.success && result.step === 'otp_required') {
        ctx.session.step = 'waiting_otp';
      } else if (result.success && (result.step === 'complete' || result.step === '2fa_setup')) {
        const tfmUser = result.message.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
        ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email: ctx.session.email, password: ctx.session.password, totpKey: tfmUser?.[1] || result._totpKey || null } };
        if (result.step === '2fa_setup' && (tfmUser?.[1] || result._totpKey)) {
          ctx.session.step = 'waiting_2fa_otp';
        }
      }
      // On error, keep session so user can retry with a different username
      return;
    }

    // Waiting for OTP
    if (ctx.session.step === 'waiting_otp') {
      const otp = text.replace(/\D/g, '');
      
      if (!/^\d{6}$/.test(otp)) {
        await ctx.reply('OTP must be 6 digits. Check spam folder.');
        return;
      }

      const result = await submitOTP(otp);
      await ctx.reply(result.message);

      if (result.success && (result.step === 'complete' || result.step === '2fa_setup')) {
        const tfmOtp = result.message.match(/2FA.*(?:Key|Authenticator|Setup).*?`([A-Z2-7]{16,52})`/i);
        ctx.session = { step: 'idle', fullName: null, email: null, password: null, proxy: null, bulkMode: false, username: null, creds: { email: ctx.session.email, password: ctx.session.password, totpKey: tfmOtp?.[1] || result._totpKey || null } };
        if (result.step === '2fa_setup' && (tfmOtp?.[1] || result._totpKey)) {
          ctx.session.step = 'waiting_2fa_otp';
        }
      }
      return;
    }

    // Waiting for 2FA OTP (authenticator app setup)
    if (ctx.session.step === 'waiting_2fa_otp') {
      const otp2fa = text.replace(/\D/g, '');

      if (!/^\d{6}$/.test(otp2fa)) {
        await ctx.reply('2FA OTP must be 6 digits. Open your authenticator app and copy the 6-digit code for this account.');
        return;
      }

      if (!ctx.session.creds || !ctx.session.creds.email) {
        await ctx.reply('❌ No account session. Register an account first with /register.');
        ctx.session.step = 'idle';
        return;
      }

      await ctx.reply('🔐 *Activating 2FA...*\n\nLogging into Instagram and completing authenticator app setup. Please wait 30-60 seconds...', { parse_mode: 'Markdown' });

      const result = await submit2FAOTP(ctx.session.creds, otp2fa, ctx.session.proxy);
      await ctx.reply(result.message, result.success ? { parse_mode: 'Markdown' } : undefined);

      ctx.session.step = 'idle';
      return;
    }

    await replyWithKeyboard(ctx, 'I didn\'t understand that. Tap a button below or send /register to start.');
  });

  // ── Register bot commands in Telegram's menu (the "/" dropdown) ──
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'register', description: 'Create a new Instagram account' },
    { command: '2fa', description: 'Complete 2FA authenticator app setup' },
    { command: 'proxy', description: 'Set proxy country (e.g., /proxy US)' },
    { command: 'proxystatus', description: 'Check health of all proxy providers' },
    { command: 'noproxy', description: 'Disable proxy, use your own IP' },
    { command: 'countries', description: 'See all supported proxy countries' },
    { command: 'otp', description: 'Enter a 6-digit OTP code' },
    { command: 'cancel', description: 'Cancel current registration' },
    { command: 'help', description: 'Show help and usage guide' },
  ]);

  return bot;
}