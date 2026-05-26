import 'dotenv/config';

export const config = {
  /** Telegram bot token from @BotFather */
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,

  /** Directory to persist WhatsApp auth sessions */
  authStateDir: process.env.AUTH_STATE_DIR || 'auth_state',

  /** Minimum delay (ms) between pairing-code requests for the same number */
  otpCooldownMs: 60_000,

  /** How long a generated pairing code should stay active */
  pairingTimeoutMs: Number(process.env.PAIRING_TIMEOUT_MS || 120_000),

  /** Registration provider: pairing or meta-cloud */
  whatsappRegistrationProvider: process.env.WHATSAPP_REGISTRATION_PROVIDER || (process.env.META_ACCESS_TOKEN ? 'meta-cloud' : 'pairing'),

  /** Meta WhatsApp Business Cloud API settings */
  metaGraphVersion: process.env.META_GRAPH_VERSION || 'v23.0',
  metaAccessToken: process.env.META_ACCESS_TOKEN,
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID,
  metaWabaId: process.env.META_WABA_ID,
  metaVerifiedName: process.env.META_VERIFIED_NAME,
  metaVerifyLanguage: process.env.META_VERIFY_LANGUAGE || 'en_US',
  metaTwoStepPin: process.env.META_TWO_STEP_PIN,

  /** Baileys browser identification */
  browserDescription: process.env.BROWSER_DESCRIPTION || 'Desktop',

  /** Proxy configuration for Instagram registration */
  proxy: {
    /** Multi-provider list: "TYPE|host:port|user|pass|zone|label" separated by ; */
    providers: process.env.PROXY_PROVIDERS || '',

    /** Legacy single-provider (backward compatible) */
    host: process.env.PROXY_HOST || '',
    port: Number(process.env.PROXY_PORT || 0),
    user: process.env.PROXY_USER || '',
    password: process.env.PROXY_PASS || '',
    zone: process.env.PROXY_ZONE || '',
    defaultCountry: (process.env.PROXY_DEFAULT_COUNTRY || 'us').toLowerCase(),

    /** Proxy rotation mode: random | round-robin | best-latency */
    rotationMode: process.env.PROXY_ROTATION_MODE || 'random',

    /** Enable pre-flight health check before using a proxy */
    preflightCheck: process.env.PROXY_PREFLIGHT_CHECK !== 'false',

    /** Health check timeout in ms */
    healthTimeoutMs: Number(process.env.PROXY_HEALTH_TIMEOUT_MS || 12000),

    /** Max consecutive failures before marking a provider unhealthy */
    maxFailures: Number(process.env.PROXY_MAX_FAILURES || 3),

    /** Maximum acceptable latency (ms) for best-proxy auto-selection */
    bestLatencyThresholdMs: Number(process.env.PROXY_BEST_LATENCY_THRESHOLD_MS || 300),

    /** Timeout per provider during best-proxy live health check */
    bestLatencyTimeoutMs: Number(process.env.PROXY_BEST_LATENCY_TIMEOUT_MS || 10000),
  },
};
