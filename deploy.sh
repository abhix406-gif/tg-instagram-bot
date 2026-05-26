#!/bin/bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Instagram Bot — Free VPS Deployment Script
#  Works on: Ubuntu 22.04+ (Oracle Cloud, AWS, any VPS)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📸 Instagram Bot — Server Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Install system packages ──
echo ""
echo "📦 Installing system dependencies..."
sudo apt-get update -y
sudo apt-get install -y curl wget git unzip ca-certificates fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
  libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libu2f-udev \
  libxcomposite1 libxdamage1 libxkbcommon0 libxrandr2 xdg-utils

# ── 2. Install Node.js 20 (LTS) ──
echo ""
echo "📦 Installing Node.js 20 LTS..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "   Node: $(node -v)"
echo "   npm:  $(npm -v)"

# ── 3. Install PM2 globally ──
echo ""
echo "📦 Installing PM2 process manager..."
sudo npm install -g pm2

# ── 4. Install project dependencies ──
echo ""
echo "📦 Installing npm packages..."
npm install

# ── 5. Install Chromium for Playwright/Puppeteer ──
echo ""
echo "📦 Installing Chromium browser..."
npx playwright install chromium
npx playwright install-deps chromium

# ── 6. Create .env from example if not exists ──
echo ""
if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️  .env created from .env.example"
  echo "   EDIT .env NOW and set your TELEGRAM_BOT_TOKEN!"
  echo "   Run: nano .env"
else
  echo "✅ .env already exists"
fi

# ── 7. Start with PM2 ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🚀 Starting the bot..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u $USER --hp $HOME

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Bot is running 24/7!"
echo ""
echo "  Useful commands:"
echo "    pm2 status          — check if bot is online"
echo "    pm2 logs tg-instagram-bot  — view live logs"
echo "    pm2 restart tg-instagram-bot — restart bot"
echo "    pm2 stop tg-instagram-bot    — stop bot"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"