@echo off
cd /d "%~dp0"
echo Starting WhatsApp Bridge and Cloudflare Tunnel...
node start_tunnel.js
