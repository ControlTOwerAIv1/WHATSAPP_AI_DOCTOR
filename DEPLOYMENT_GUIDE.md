# WhatsApp ECHO Bridge - Deployment Guide

## For Master PC Setup (Tomorrow)

### Step 1: Install Node.js (One-Time)
1. Download from: https://nodejs.org/
2. Click "Download LTS" (Long Term Support)
3. Run the installer → Next → Next → Finish
4. Restart computer (recommended)

### Step 2: Copy Project to Master PC
Copy entire folder to: `C:\wa_echo`
```
C:\wa_echo\
  ├── START_SERVER.bat    ← Double-click to start
  ├── START_SERVER.exe    ← OR use this (after converting)
  ├── bridge.js
  ├── public/
  ├── src/
  ├── package.json
  └── ...
```

### Step 3A: Start Server (Simple Way)
**Double-click `START_SERVER.bat`**
- Automatically checks Node.js
- Installs dependencies (first run only)
- Starts server on port 3001
- Shows clear status messages
- Shows errors if anything fails

### Step 3B: Start Server (As .exe - Optional)
If you want a single .exe file:

**Option 1 - Online Converter (Easiest):**
1. Go to: https://www.bat2exe.com/
2. Upload `START_SERVER.bat`
3. Download `START_SERVER.exe`
4. Place in `C:\wa_echo\`
5. Double-click the .exe

**Option 2 - AutoHotkey (Free):**
1. Download AutoHotkey from: https://www.autohotkey.com/
2. Install it
3. Right-click `START_SERVER.ahk` → "Compile Script"
4. Creates `START_SERVER.exe`
5. Double-click to run

### Step 4: Authenticate WhatsApp
When you run the launcher:
- Terminal opens with QR code
- Scan with your WhatsApp phone camera
- Wait for "authenticated" message
- Server is now ready!

### Step 5: Access from Worker PCs
Find Master PC's IP address (on Master):
```powershell
ipconfig
```
Look for "IPv4 Address" (e.g., 192.168.1.100)

Workers open browser:
```
http://192.168.1.100:3001
```

### Auto-Start on Boot (Master PC)
**Option A - Batch File:**
1. Press Win + R
2. Type: `shell:startup`
3. Copy `START_SERVER.bat` there
4. Runs automatically each boot

**Option B - .exe File:**
1. Same steps as above
2. Copy `START_SERVER.exe` to startup folder

---

## Troubleshooting

### "Node.js is not installed"
- Install from: https://nodejs.org/
- Restart computer after install
- Try launcher again

### Port 3001 already in use
- Close other applications
- Or edit `START_SERVER.bat`, change `3001` to different port (e.g., `3002`)

### WhatsApp QR not appearing
- Make sure WhatsApp is not already logged in on that PC
- Logout first: WhatsApp Settings → Log Out

### Can't access from worker PCs
- Make sure both PCs are on same WiFi network
- Check firewall: Settings → Firewall → Allow app through firewall
- Add port 3001 to Windows Firewall

---

## File Structure
```
C:\wa_echo\
├── START_SERVER.bat         ← Main launcher
├── START_SERVER.ahk         ← Optional: convert to .exe
├── START_SERVER.exe         ← After conversion (optional)
├── bridge.js                ← Main server file
├── src/                     ← Server code
│   ├── db.js
│   ├── whatsapp.js
│   ├── routes.js
│   └── stores.js
├── public/                  ← Dashboard (HTML/CSS/JS)
├── media/                   ← Auto-created, stores WhatsApp files
├── relay.sqlite             ← Auto-created, stores messages
├── package.json             ← Dependencies list
└── node_modules/            ← Auto-installed, dependencies
```

---

## What Happens When You Click the Launcher

1. ✓ Checks if Node.js installed
2. ✓ Changes to project directory
3. ✓ Checks if dependencies installed
4. 📦 (First run) Installs npm packages
5. ✅ Starts server on port 3001
6. 📱 Waits for WhatsApp authentication
7. 🌐 Ready for worker PCs to connect

---

**Tomorrow: Just copy the folder to Master PC, install Node.js, double-click the launcher. Done!**
