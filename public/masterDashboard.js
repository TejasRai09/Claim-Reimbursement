// public/masterDashboard.js
// Master dashboard bootstrap + robust approvals loader with detailed error reporting

const HR_EMAILS = ['hr@adventz.zuarimoney.com']; // adjust if needed
const ALLOWED_ROLES = ['master', 'hr', 'hr-master', 'admin'];

function showSpinner(on = true) {
  const s = document.getElementById('spinnerOverlay');
  if (!s) return;
  s.style.display = on ? 'flex' : 'none';
}

function toast(msg, type = 'info') {
  try {
    Toastify({
      text: msg,
      duration: 4500,
      style: { background: type === 'error' ? '#dc3545' : '#0060df' }
    }).showToast();
  } catch (e) {
    // fallback to alert if Toastify missing
    if (type === 'error') console.error(msg);
    else console.log(msg);
  }
}

async function getMe() {
  try {
    showSpinner(true);
    const res = await fetch('/api/me');
    if (!res.ok) throw new Error(`GET /api/me returned ${res.status}`);
    return await res.json();
  } finally {
    showSpinner(false);
  }
}

async function ensureAllowed() {
  try {
    const me = await getMe();
    const role = String(me.role || '').toLowerCase();
    const username = String(me.username || '').toLowerCase();

    const allowedByRole = ALLOWED_ROLES.includes(role);
    const allowedByEmail = HR_EMAILS.includes(username);

    if (!allowedByRole && !allowedByEmail) {
      console.warn('masterDashboard: user not allowed', { role, username });
      // nicer UX: show toast explaining lack of permission then redirect
      toast('Access denied — this page is for HR users only.', 'error');
      setTimeout(() => window.location.replace('dash.html'), 900);
      return null;
    }

    const welcome = document.getElementById('welcomeTxt');
    if (welcome) welcome.textContent = `Hi, ${me.name || me.username || username}`;

    return me;
  } catch (err) {
    console.error('Authorization check failed:', err);
    // If token/session problem: go to login
    if (err && String(err).includes('401')) {
      window.location.replace('login.html');
    } else {
      window.location.replace('dash.html');
    }
    return null;
  }
}


/**
 * Try multiple endpoints to fetch master approvals.
 * Returns array of approvals on success or throws an Error with details.
 */
async function fetchApprovalsBestEffort() {
  const candidates = [
    '/api/approvals/all',
    '/api/approvals',
    // fallback to a route that might exist on some installs — non-destructive attempt
    '/api/approvals/list'
  ];

  let lastErr = null;
  for (const url of candidates) {
    try {
      console.info('masterDashboard: attempting', url);
      const res = await fetch(url);
      const bodyText = await res.text().catch(()=>null);
      // Try to interpret body as JSON if content-type available
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok) {
        lastErr = new Error(`Request ${url} failed: ${res.status} ${res.statusText} — ${bodyText}`);
        console.warn(lastErr.message);
        continue; // try next candidate
      }

      // parse JSON if possible
      let json;
      try {
        if (ct.includes('application/json')) {
          json = JSON.parse(bodyText);
        } else {
          // attempt to parse even if content-type absent
          json = JSON.parse(bodyText);
        }
      } catch (parseErr) {
        // Not JSON? If bodyText looks like array/object in text try eval? No — fail with details.
        lastErr = new Error(`Response from ${url} is not valid JSON. Response body: ${bodyText}`);
        console.error(lastErr.message);
        continue;
      }

      // success
      console.info('masterDashboard: fetched approvals from', url, 'count=', (Array.isArray(json) ? json.length : 'unknown'));
      return json;
    } catch (err) {
      lastErr = err;
      console.error('masterDashboard fetch attempt error for candidate:', url, err);
      // continue to next candidate
    }
  }

  // All candidates failed
  throw lastErr || new Error('No candidate endpoints succeeded');
}

function renderApprovalsList(list) {
  const tbody = document.querySelector('#masterTbl tbody');
  if (!tbody) {
    console.error('masterDashboard: #masterTbl tbody not found in DOM');
    return;
  }
  tbody.innerHTML = '';

  if (!Array.isArray(list) || list.length === 0) {
    const trEmpty = document.createElement('tr');
    trEmpty.innerHTML = `<td colspan="8" class="text-muted">No approvals found.</td>`;
    tbody.appendChild(trEmpty);
    return;
  }

  list.forEach(ap => {
    const approversHtml = (ap.approvers || []).map(a => {
      const n = a.name || a.email || '—';
      const s = a.status || '—';
      return `${escapeHtml(n)} <small class="text-muted">(${escapeHtml(s)})</small>`;
    }).join('<br>');

    const status = ap.isDraft ? 'Draft'
                 : (ap.approvers && ap.approvers.every(a => a.status === 'Accepted') ? 'Approved'
                 : (ap.approvers && ap.approvers.some(a => a.status === 'Rejected') ? 'Rejected' : 'Pending'));

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="index.html?uniqueNumber=${encodeURIComponent(ap.uniqueNumber || '')}">${escapeHtml(ap.uniqueNumber || '—')}</a></td>
      <td>₹ ${Number(ap.budget || 0).toLocaleString('en-IN')}</td>
      <td>${escapeHtml(ap.purpose || '')}</td>
      <td>${approversHtml}</td>
      <td>${escapeHtml(ap.createdBy || '')}</td>
      <td>${escapeHtml(ap.createdAt ? new Date(ap.createdAt).toLocaleDateString() : '')}</td>
      <td>${escapeHtml(status)}</td>
      <td><!-- actions placeholder --></td>
    `;
    tbody.appendChild(tr);
  });
}

// Safe client-side HTML escape
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[s]));
}

async function loadAllApprovalsAndRender() {
  try {
    showSpinner(true);
    const list = await fetchApprovalsBestEffort();
    renderApprovalsList(list);
    toast('Loaded approvals (' + (Array.isArray(list) ? list.length : 'unknown') + ')', 'info');
  } catch (err) {
    console.error('masterDashboard: failed to load approvals:', err);
    // Show the most actionable error to user
    const msg = (err && err.message) ? err.message : 'Unable to load master approvals';
    toast('Unable to load master approvals — see console for details', 'error');

    // Also put a descriptive row in the table so user sees something
    const tbody = document.querySelector('#masterTbl tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-danger small">Failed to load approvals: ${escapeHtml(msg)}</td></tr>`;
    }
  } finally {
    showSpinner(false);
  }
}

async function init() {
  // Wire feather icons if present
  try { if (typeof feather !== 'undefined') feather.replace(); } catch(e){}

  const me = await ensureAllowed();
  if (!me) return; // redirected

  // Wire logout button
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' }).catch(()=>{});
      window.location.href = 'login.html';
    });
  }

  // Try to load approvals
  await loadAllApprovalsAndRender();
}

document.addEventListener('DOMContentLoaded', init);
