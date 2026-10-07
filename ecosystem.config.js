module.exports = {
  apps: [
    {
      name: 'doctor-automation',
      script: 'bridge.js',
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      merge_logs: true,
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'whisper',
      script: 'src/ai-bot/transcribe-server.py',
     interpreter: '/var/www/WHATSAPP_AI_DOCTOR/venv/bin/python',
      watch: false,
      max_memory_restart: '1G',
      env: {
        WHISPER_MODEL: 'small',
        WHISPER_PORT: 5555,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/whisper-error.log',
      out_file: './logs/whisper-output.log',
      merge_logs: true,
      max_restarts: 5,
      restart_delay: 10000,
      exp_backoff_restart_delay: 500,
    },
  ],
};
