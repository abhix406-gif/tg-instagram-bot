# 🤖 TgInsta — Instagram Auto Creator Bot

> **Fast, automated Instagram account creation via Telegram** — powered by Playwright browser automation, smart proxy rotation, and built-in 2FA setup.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![Deploy](https://img.shields.io/badge/Deploy-Render.com-46E3B7)](https://render.com)

---

## ✨ Features

| Feature | Description |
|---|---|
| 📝 **Account Registration** | Full Instagram signup flow — email, password, name, username, OTP |
| ⚡ **Bulk Mode** | Paste all details at once (name, username, password, email) for one-shot creation |
| 🌍 **Smart Proxies** | Multi-provider proxy pool with auto health check, country routing, and lowest-latency selection |
| 🔐 **2FA Setup** | Scrapes the TOTP authenticator key after registration and activates 2FA on the account |
| 📊 **Proxy Dashboard** | Live health status for every proxy provider right from the bot |
| 🚀 **Render-Ready** | Deploy to Render.com free tier with zero manual config — auto-detects webhook mode |

---

## 🚀 Quick Start

```bash
git clone https://github.com/abhix406-gif/tg-instagram-bot.git
cd tg-instagram-bot
npm install
copy .env.example .env
```

Set your Telegram token in `.env`:

```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
```

Then run:

```bash
npm start
```

---

## ☁️ Deploy to Render (Free — No Credit Card)

> ⚠️ **For 24/7 uptime:** Render's free tier sleeps after 15 min of inactivity. Set up [UptimeRobot](https://uptimerobot.com) (free) to ping `https://YOUR-APP.onrender.com/ping` every 5 minutes. See [`DEPLOY.md`](DEPLOY.md) for full step-by-step.

1. Fork/push the repo to GitHub
2. On [Render.com](https://render.com), click **New → Web Service → Connect your repo**
3. Render auto-detects [`render.yaml`](render.yaml) — just add `TELEGRAM_BOT_TOKEN`, `WEBHOOK_BASE_URL` (and optional `PROXY_PROVIDERS`)
4. Deploy! Then set up UptimeRobot to prevent idle sleep.

See [`DEPLOY.md`](DEPLOY.md) for detailed instructions.

---

## 📖 Commands

| Command | Description |
|---|---|
| `/start` | Show welcome screen with keyboard |
| `/register` | Start a new Instagram registration |
| `/2fa` | Complete 2FA authenticator app setup |
| `/proxy US` | Lock proxy to a specific country |
| `/proxystatus` | Check proxy provider health |
| `/noproxy` | Disable proxy |
| `/countries` | List supported proxy countries |
| `/otp` | Enter a 6-digit OTP code |
| `/cancel` | Cancel current operation |
| `/help` | Show full usage guide |

---

## ⚠️ Disclaimer

Only create Instagram accounts that you own or are authorized to manage. Mass account creation violates Instagram's Terms of Service. Use responsibly.

---

## 🛠️ Tech Stack

- **[Telegraf](https://telegraf.js.org/)** — Telegram Bot framework
- **[Playwright](https://playwright.dev/)** — Browser automation for Instagram signup
- **[Express](https://expressjs.com/)** — Webhook server for cloud deployment
- **Node.js 18+** — ES modules throughout