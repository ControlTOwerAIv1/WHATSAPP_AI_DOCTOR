@echo off
cd /d "%~dp0"
echo Stopping services...
node stop_tunnel.js
