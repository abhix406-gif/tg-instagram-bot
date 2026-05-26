// PM2 process manager config — keeps the bot alive 24/7 with auto-restart
// Install: npm install -g pm2
// Start:   pm2 start ecosystem.config.cjs
// Save:    pm2 save && pm2 startup
module.exports = {
  apps: [{
    name: 'tg-instagram-bot',
    script: 'src/index.js',
    interpreter: 'node',
    // Auto-restart if it crashes
    autorestart: true,
    // Max memory before restart (1 GB)
    max_memory_restart: '1G',
    // Restart delay on crash
    restart_delay: 5000,
    // Logs
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    // Environment (reads from .env)
    env: {
      NODE_ENV: 'production',
    },
    // Watch for .env changes and restart
    watch: ['.env'],
    watch_delay: 5000,
    ignore_watch: ['node_modules', 'logs', 'auth_state', '*.log'],
  }],
};