# 🚀 Deploy Instagram Bot 24/7 — FREE (No Credit Card!)

---

## Option 1: Render.com (RECOMMENDED — No Credit Card!)

Render offers a **free web service tier**: 512 MB RAM, 100 GB/month bandwidth, auto-deploys from GitHub. Zero cost, zero credit card required.

> ⚠️ **Note:** 512 MB RAM may be tight for Puppeteer. If registration fails due to memory, upgrade to the **Starter** plan ($7/month) or use a VPS (Option 3).

### Step 1: Push Your Code to GitHub

1. Create a new **private** repository on GitHub (keep your `.env` secrets safe!)
2. Push the bot code (this whole folder) to the repo:

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Step 2: One-Click Deploy on Render

1. Go to https://dashboard.render.com → Sign up with GitHub (no credit card)
2. Click **New +** → **Blueprint**
3. Connect your GitHub repo
4. Render reads `render.yaml` and auto-creates:
   - A **Web Service** on port 3000
   - Build: `npm install` + `playwright install chromium` + `puppeteer browsers install chrome`
   - Start: `node src/index.js`

### Step 3: Set Environment Variables

After deployment, go to your service → **Environment** and add:

| Key | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | `8834226477:...` (your bot token) |
| `WEBHOOK_BASE_URL` | `https://tg-instagram-bot.onrender.com` (your Render URL) |
| `PROXY_PROVIDERS` | (your proxy provider string, if any) |

> The `WEBHOOK_BASE_URL` comes from your Render URL — it looks like `https://YOUR-SERVICE-NAME.onrender.com`. Copy it from the top of your service's page.

### Step 4: Verify

1. Check logs: **Logs** tab on your Render dashboard
2. You should see: `✅ Webhook registered — bot is LIVE`
3. Open Telegram and send `/start` to your bot — it should respond!

### ⚠️ Free Tier Limits

- **Memory:** 512 MB (Puppeteer + Chromium may use ~300-400 MB during registration)
- **Bandwidth:** 100 GB/month
- **Sleeps** after 15 minutes of inactivity (wakes on next webhook from Telegram)
- Each message from Telegram wakes it up automatically

### Render Outbound IPs (whitelist these on proxy providers)
- `74.220.48.0/24`
- `74.220.56.0/24`

---

## Option 2: Oracle Cloud Always Free Tier (Credit Card Required)

Oracle gives **4 ARM cores, 24 GB RAM, 200 GB storage** — completely free forever.
Much more powerful than Render, but requires credit card verification.

See the `deploy.sh` script for automated setup on Ubuntu.

---

## Option 3: Keep on Your PC (Windows) with Auto-Start

Use PM2 on Windows to keep the bot alive:

```powershell
# Install PM2
npm install -g pm2

# Start the bot
pm2 start ecosystem.config.cjs

# Auto-start on Windows boot
pm2 save
npm install -g pm2-windows-startup
pm2-startup install

# Check status
pm2 status
```

---

## PM2 Cheat Sheet

| Command | What it does |
|---------|-------------|
| `pm2 status` | See all running apps |
| `pm2 logs tg-instagram-bot` | View live logs |
| `pm2 restart tg-instagram-bot` | Restart the bot |
| `pm2 stop tg-instagram-bot` | Stop the bot |
| `pm2 delete tg-instagram-bot` | Remove from PM2 |
| `pm2 save` | Save current process list |
| `pm2 monit` | Real-time dashboard |