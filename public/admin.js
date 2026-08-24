/**
 * ECHO Relay Admin Control Center - Tailscale Aesthetic Interface
 */

let adminToken = sessionStorage.getItem('echo_admin_token') || null;
let operatorDevicesData = [];
let bannedDevicesData = [];
let pendingBanItem = null;
let pendingDeleteItem = null;

document.addEventListener('DOMContentLoaded', () => {
  if (adminToken) {
    showDashboard();
  } else {
    showLoginScreen();
  }
});

// ─── Authentication ──────────────────────────────────────────────────────────
async function handleAdminLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  
  const usernameInput = document.getElementById('adminUsername').value.trim();
  const passwordInput = document.getElementById('adminPassword').value.trim();
  const errorAlert = document.getElementById('loginError');
  const submitBtn = document.getElementById('loginSubmitBtn');
  
  errorAlert.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.innerText = 'Verifying...';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameInput, password: passwordInput })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invalid credentials');

    adminToken = data.token;
    sessionStorage.setItem('echo_admin_token', adminToken);
    showToast('Login successful', 'success');
    showDashboard();
  } catch (err) {
    errorAlert.textContent = err.message;
    errorAlert.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = 'Log In to Admin';
  }
}

function handleAdminLogout() {
  adminToken = null;
  sessionStorage.removeItem('echo_admin_token');
  showLoginScreen();
  showToast('Logged out of admin');
}

function showLoginScreen() {
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('dashboardScreen').classList.add('hidden');
}

function showDashboard() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('dashboardScreen').classList.remove('hidden');
  fetchOperatorDevices();
  startAutoRefresh();
}

// ─── Data Fetching & Rendering ────────────────────────────────────────────────
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (adminToken) fetchOperatorDevices(true);
  }, 5000);
}

async function fetchOperatorDevices(silent = false) {
  if (!adminToken) return;

  try {
    const res = await fetch('/api/admin/operators', {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.status === 401) {
      handleAdminLogout();
      return;
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load operators');

    operatorDevicesData = data.operators || [];
    bannedDevicesData = data.bannedDevices || [];
    
    updateMetrics(data.stats || {});
    renderDeviceTable();
  } catch (err) {
    if (!silent) showToast(err.message, 'error');
  }
}

function updateMetrics(stats) {
  document.getElementById('metricTotalDevices').textContent = stats.totalOperators || 0;
  document.getElementById('metricOnlineOperators').textContent = stats.onlineOperators || 0;
  document.getElementById('metricOfflineOperators').textContent = (stats.totalOperators || 0) - (stats.onlineOperators || 0);
  document.getElementById('metricBannedDevices').textContent = stats.bannedDevices || 0;
  document.getElementById('metricActiveClaims').textContent = stats.activeClaims || 0;
}

function renderDeviceTable() {
  const tbody = document.getElementById('deviceTableBody');
  const search = document.getElementById('deviceSearchInput').value.toLowerCase().trim();
  const filter = document.getElementById('statusFilterSelect').value;

  const filtered = operatorDevicesData.filter(op => {
    const textMatch = !search || 
      (op.operatorName && op.operatorName.toLowerCase().includes(search)) ||
      (op.operatorId && op.operatorId.toLowerCase().includes(search)) ||
      (op.deviceId && op.deviceId.toLowerCase().includes(search)) ||
      (op.ipAddress && op.ipAddress.toLowerCase().includes(search));

    if (!textMatch) return false;

    if (filter === 'online') return op.isOnline && !op.isBanned;
    if (filter === 'offline') return !op.isOnline && !op.isBanned;
    if (filter === 'banned') return op.isBanned;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted);">
          No operator devices match the selected filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(op => {
    let statusBadge = '';
    if (op.isBanned) {
      statusBadge = `<span class="badge-status badge-banned"><span class="status-dot"></span> Banned</span>`;
    } else if (op.isOnline) {
      statusBadge = `<span class="badge-status badge-online"><span class="status-dot"></span> Online</span>`;
    } else {
      statusBadge = `<span class="badge-status badge-offline"><span class="status-dot"></span> Offline</span>`;
    }

    const lastSeenText = op.isOnline ? 'Active now' : formatDate(op.lastSeen);

    return `
      <tr>
        <td>
          <div class="device-name-wrap">
            <span class="op-name">${escapeHtml(op.operatorName || op.operatorId)}</span>
            <span class="op-id">${escapeHtml(op.operatorId)}</span>
          </div>
        </td>
        <td>
          <span class="mac-code">${escapeHtml(op.deviceId || 'N/A')}</span>
        </td>
        <td>${statusBadge}</td>
        <td><span class="ip-text">${escapeHtml(op.ipAddress || '127.0.0.1')}</span></td>
        <td><span class="ua-text" title="${escapeHtml(op.userAgent)}">${escapeHtml(op.userAgent || 'Unknown')}</span></td>
        <td><strong>${op.claimsCount || 0}</strong></td>
        <td style="color:var(--text-muted);font-size:12px;">${lastSeenText}</td>
        <td>
          <div class="actions-cell">
            ${op.isBanned ? `
              <button class="btn btn-secondary btn-sm" onclick="handleUnbanDevice('${escapeHtml(op.deviceId)}')">Unban</button>
            ` : `
              <button class="btn btn-danger btn-sm" onclick="openBanModal('${escapeHtml(op.deviceId)}', '${escapeHtml(op.operatorId)}', '${escapeHtml(op.operatorName)}')">Ban</button>
            `}
            <button class="btn btn-ghost btn-sm" onclick="openDeleteModal('${escapeHtml(op.operatorId)}', '${escapeHtml(op.operatorName)}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ─── Ban & Unban Actions ──────────────────────────────────────────────────────
function openBanModal(deviceId, operatorId, operatorName) {
  pendingBanItem = { deviceId, operatorId, operatorName };
  document.getElementById('banModalDeviceId').textContent = `${operatorName} (${deviceId})`;
  document.getElementById('banReasonInput').value = '';
  document.getElementById('banModal').classList.remove('hidden');
}

function closeBanModal() {
  pendingBanItem = null;
  document.getElementById('banModal').classList.add('hidden');
}

async function confirmBanDevice() {
  if (!pendingBanItem) return;
  const reason = document.getElementById('banReasonInput').value.trim() || 'Banned by admin';

  try {
    const res = await fetch('/api/admin/ban', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        deviceId: pendingBanItem.deviceId,
        operatorId: pendingBanItem.operatorId,
        operatorName: pendingBanItem.operatorName,
        reason
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to ban device');

    showToast(`Device ${pendingBanItem.deviceId} banned successfully`, 'success');
    closeBanModal();
    fetchOperatorDevices();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleUnbanDevice(deviceId) {
  if (!deviceId) return;

  try {
    const res = await fetch('/api/admin/unban', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ deviceId })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to unban device');

    showToast(`Device ${deviceId} unbanned`, 'success');
    fetchOperatorDevices();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Delete Actions ────────────────────────────────────────────────────────────
function openDeleteModal(operatorId, operatorName) {
  pendingDeleteItem = { operatorId, operatorName };
  document.getElementById('deleteModalOperatorName').textContent = `${operatorName} (${operatorId})`;
  document.getElementById('deleteModal').classList.remove('hidden');
}

function closeDeleteModal() {
  pendingDeleteItem = null;
  document.getElementById('deleteModal').classList.add('hidden');
}

async function confirmDeleteOperator() {
  if (!pendingDeleteItem) return;

  try {
    const res = await fetch(`/api/admin/operators/${encodeURIComponent(pendingDeleteItem.operatorId)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete operator');

    showToast(`Operator ${pendingDeleteItem.operatorName} deleted`, 'success');
    closeDeleteModal();
    fetchOperatorDevices();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatDate(ts) {
  if (!ts) return 'Never';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'Never';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[m]);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type === 'success' ? 'toast-success' : (type === 'error' ? 'toast-error' : '')}`;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}
