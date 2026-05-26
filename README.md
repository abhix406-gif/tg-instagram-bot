# Telegram Instagram Account Registration Bot

A Telegram bot that creates Instagram accounts using email OTP verification via browser automation (Playwright).

## Disclaimer

Only create Instagram accounts that you own or are authorized to manage. Mass account creation violates Instagram's Terms of Service. Use responsibly.

## Prerequisites

- Node.js 18 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A working email address for OTP verification

## Setup

```bash
npm install
copy .env.example .env
```

Set your Telegram token in `.env`:

```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
```

## How It Works

The bot uses Playwright to automate Instagram's sign-up flow:

1. Send `/register` in Telegram
2. Send your email address
3. The bot opens Instagram signup in a headless browser
4. You receive a verification code at your email
5. Send the 6-digit OTP to the bot
6. The bot submits the OTP and creates the account

## Usage

| Command | Description |
|---|---|
| `/start` | Show the main menu |
| `/register` | Start Instagram registration |
| `/list` | View active registrations |
| `/cancel` | Cancel current operation |
| `/help` | Show help |

## Run

```bash
npm start
```

For development:

```bash
npm run dev
```

## Notes

- Make sure your email can receive Instagram's OTP
- Check your spam folder if OTP doesn't arrive
- After registration, you may need to complete profile setup (username, password, birthday) manually
- Sessions are kept alive in memory while waiting for OTP