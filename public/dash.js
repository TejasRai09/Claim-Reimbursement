// File: public/dash.js
// Dashboard logic: user table, approver queues, master link, logout.

/* ────────────────────────────────────────────────────────── */
/* GLOBALS & UTILITIES                                        */
/* ────────────────────────────────────────────────────────── */

// const DRAFT_KEY = 'approvalDraft';
const spinner   = document.getElementById('spinnerOverlay');
const toast     = (msg, type='info') => Toastify({
  text: msg,
  style: { background: type==='error'? '#dc3545' : type==='success'? '#28a745' : '#0060df' },
  duration: 3500, close: true
}).showToast();
// ---------- ₹ formatter ----------
const formatINR = n => Number(n).toLocaleString('en-IN');
const CAN_CREATE = ['user','approver','master'];
// dd-mm-yyyy
const formatDate = d => {
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2,'0');
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const yyyy = dt.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};
const MAX_PURPOSE = 24;  // used everywhere for purpose truncation

// near the top, after formatDate(...)
let EMAIL_TO_NAME = {};
const DEPT_ABBR = { Finance:'Fin', Sales:'Sales', IT:'IT', HR:'HR', Operations:'Ops' };
// Abbreviations for reimbursement types shown in tables
const TYPE_ABBR = { Mobile:'Mob', Conveyance:'Conv', Travel:'Trav', Imprest:'Impr', Others:'Others' };

async function loadDirectoryMap() {
  try {
    const r = await fetch('/api/approvers');
    if (!r.ok) return;
    const list = await r.json(); // [{label, value}]
    EMAIL_TO_NAME = Object.fromEntries(
      list.map(p => [String(p.value || '').toLowerCase(), p.label])
    );
  } catch {}
}
// Map email -> display name and set header greeting to name
const displayName = (email = '') => {
  const key = String(email || '').toLowerCase();
  return EMAIL_TO_NAME[key] || (email?.split('@')[0] || email);
};
// Hide UI until authenticated (paired with body.preauth in dash.html)
document.body.classList.add('preauth');

async function setWelcomeName() {
  try {
    const r = await fetch('/api/directory/me'); // full profile from directory
    if (!r.ok) return;
    const meDir = await r.json();

    const headerEl = document.getElementById('welcomeTxt');
    if (headerEl && (meDir?.name || meDir?.email)) {
      headerEl.textContent = `Hi, ${meDir.name || displayName(meDir.email)}`;
    }

    // Fill "My Details" card if present
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val || '—';
    };

    set('profEmpCode',      meDir.empCode);
    set('profName',         meDir.name);
    set('profCompany',      meDir.company);
    set('profDesignation',  meDir.designation);
    set('profDept',         meDir.department);
    set('profManagerName',  meDir.managerName);
    set('profEmail',        meDir.email);
    set('profManagerEmail', meDir.managerEmail);
    set('profPhone',        meDir.phone);
  } catch (e) {
    console.error(e);
  }
}


// ---- truncate / toggle helpers -----------------
function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[s]));
}

function shortify(str = '', max = 40) {
  if (str.length <= max) return { short: str, truncated: false };
  return { short: str.slice(0, max - 1) + '…', truncated: true };
}

function badgeClass(status) {
  return `badge-status ${status}`;
}

function wirePurposeToggles(root = document) {
  root.querySelectorAll('.purpose-toggle').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const wrap = link.closest('.purpose-wrap');
      if (!wrap) return;

      const span = wrap.querySelector('.purpose-text');
      const full = wrap.dataset.full || '';
      const max  = parseInt(wrap.dataset.max || String(MAX_PURPOSE), 10);
      const isFull = wrap.dataset.state === 'full';

      if (isFull) {
        // switch to short
        span.textContent = shortify(full, max).short;
        wrap.dataset.state = 'short';
        link.textContent = 'more';
      } else {
        // switch to full
        span.textContent = full;
        wrap.dataset.state = 'full';
        link.textContent = 'less';
      }
    });
  });
}



// ▼ NEW — Excel export helper ---------------------------------
function exportTableToExcel(tableEl, filename = 'export.xlsx') {
  try {
    const wb = XLSX.utils.table_to_book(tableEl, { sheet: 'Sheet1' });
    XLSX.writeFile(wb, filename);
  } catch (e) {
    console.error(e);
    toast('Export failed', 'error');
  }
}
// -------------------------------------------------------------

function showSpinner(on=true) {
  if (spinner) {
    spinner.style.display = on ? 'flex' : 'none';
  }
}

async function fetchMe() {
  try {
    showSpinner(true);
    const res = await fetch('/api/me');
    if (!res.ok) throw new Error('Session expired');
    return await res.json();
  } finally {
    showSpinner(false);
  }
}

/* ────────────────────────────────────────────────────────── */
/*  USER DASH — My NFA                                        */
/* ────────────────────────────────────────────────────────── */

// ▼ NEW — keep full list in memory for filtering/export
let USER_APPROVALS = [];

function mount(role, username) {
  // Greeting is already set from /api/directory/me in setWelcomeName()
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }

  // 🔓 Show requester features for approver & master too
  if (CAN_CREATE.includes(role)) {
    document.getElementById('requesterDash').classList.remove('d-none');
    document.getElementById('userRequests').classList.remove('d-none');
    renderUserRequests(username);
  }

    // Show approver queue for approvers *and* HR / Accounts (they act as approvers)
  const APPROVER_LIKE_ROLES = ['approver', 'hr', 'hr-master', 'accounts', 'finance'];

  if (APPROVER_LIKE_ROLES.includes(String(role || '').toLowerCase())) {
    document.getElementById('approverDash').classList.remove('d-none');
    // pass username (same casing as server returns); comparisons server-side are tolerant too
    renderApproverQueues(username);
  }


  if (role === 'master' || role === 'hr' || role === 'hr-master') {

  document.getElementById('masterDash').classList.remove('d-none');
}
}

async function logout() {
  await fetch('/api/logout',{method:'POST'}).catch(()=>{});
  window.location.href = 'login.html';
}

// ——— USER: show my requests —————————————————————————
async function renderUserRequests(username) {
  try {
    showSpinner(true);
    const res = await fetch(`/api/approvals/user/${encodeURIComponent(username)}`);
    if (!res.ok) throw new Error('Could not load your requests');
    USER_APPROVALS = await res.json();          // ← store for filtering

    applyUserFilters();                         // render with filters
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    showSpinner(false);
  }
}

// ▼ NEW — apply filters + re-render
function applyUserFilters() {
  const tbody = document.querySelector('#userReqTbl tbody');
  const noMsg = document.getElementById('noUserReqMsg');
  if (!tbody) return;

  const search  = (document.getElementById('tblSearch')?.value || '').trim().toLowerCase();
  const fStatus = document.getElementById('statusFilter')?.value || '';
  const fType   = document.getElementById('typeFilter')?.value || '';

  const rows = USER_APPROVALS.filter(ap => {
    // status calculation same as before
    let status = ap.isDraft ? 'Draft' : 'Pending';
    if (ap.approvers.every(a => a.status === 'Accepted')) status = 'Approved';
    else if (ap.approvers.some(a => a.status === 'Rejected')) status = 'Rejected';

    const typeOk   = !fType   || ap.reimbursementType === fType;
    const statusOk = !fStatus || status === fStatus;

    // search against several fields
    const text = [
      ap.uniqueNumber,
      ap.purpose,
      ap.reimbursementType,
      ...ap.approvers.map(a => a.name),
      status
    ].join(' ').toLowerCase();

    const searchOk = !search || text.includes(search);
    return typeOk && statusOk && searchOk;
  });

  tbody.innerHTML = '';
  if (!rows.length) {
    noMsg?.classList.remove('d-none');
    $('#userReqTbl').trigger('update');
    return;
  }
  noMsg?.classList.add('d-none');

  rows.forEach(ap => {
    let status = ap.isDraft ? 'Draft' : 'Pending';
    if (ap.approvers.every(a => a.status === 'Accepted')) status = 'Approved';
    else if (ap.approvers.some(a => a.status === 'Rejected')) status = 'Rejected';

    const link = ap.isDraft
      ? `index.html?draftId=${encodeURIComponent(ap.uniqueNumber)}`
      : `index.html?uniqueNumber=${encodeURIComponent(ap.uniqueNumber)}`;

    const fullPurpose = ap.purpose || '';
    const isTrunc = fullPurpose.length > MAX_PURPOSE;
    const purposeCell = isTrunc
      ? `<span class="purpose-wrap" data-full="${escapeHtml(fullPurpose)}" data-state="short" data-max="${MAX_PURPOSE}">
           <span class="purpose-text">${escapeHtml(shortify(fullPurpose, MAX_PURPOSE).short)}</span>
           <a href="#" class="purpose-toggle">more</a>
         </span>`
      : `<span class="purpose-wrap" data-full="${escapeHtml(fullPurpose)}" data-state="full">
           <span class="purpose-text">${escapeHtml(fullPurpose)}</span>
         </span>`;

    const approverLines = ap.approvers.map(a => {
      const key = (a.name || '').toLowerCase();
      const display = EMAIL_TO_NAME[key] || (a.name?.split('@')[0] || a.name || '');
      return `<div class="appr-line"><strong>${escapeHtml(display)}</strong>
                <span class="${badgeClass(a.status)}">${a.status}</span>
              </div>`;
    }).join('');

    const statusClass =
      status === 'Approved' ? 'status-approved' :
      status === 'Rejected' ? 'status-rejected' : 'status-pending';

    const typeShort = TYPE_ABBR[ap.reimbursementType] || ap.reimbursementType;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="lalign"><a href="${link}">${ap.uniqueNumber}</a></td>
      <td>₹ ${formatINR(ap.budget)}</td>
      <td class="purpose-cell" title="${escapeHtml(ap.purpose || '')}">${purposeCell}</td>
      <td class="approver-list">${approverLines}</td>
      <td class="dept-cell" title="${escapeHtml(ap.reimbursementType || '')}">${escapeHtml(typeShort || '')}</td>
      <td>${formatDate(ap.createdAt)}</td>
      <td class="${statusClass}">${status}</td>
    `;
    tbody.appendChild(tr);
  });

  wirePurposeToggles(tbody);
  $('#userReqTbl').trigger('update');
}

/* ────────────────────────────────────────────────────────── */
/*  APPROVER DASH                                             */
/* ────────────────────────────────────────────────────────── */

// ▼ NEW — cached lists for filters/exports
let PENDING_LIST = [], APPROVED_LIST = [], REJECT_LIST = [];

async function renderApproverQueues(username) {
  try {
    showSpinner(true);
    const res = await fetch(`/api/approvals/for-approver-all/${encodeURIComponent(username)}`);
    if (!res.ok) throw new Error('Could not load approvals');
    const all = await res.json();
    console.info('renderApproverQueues(): server returned', all.length, 'items for', username);


    // use a lowercased, tolerant match for the approver identity
    const myName = String(username || '').toLowerCase();

    PENDING_LIST = all.filter(ap => {
      if (ap.approvers.some(a => a.status === 'Rejected')) return false;

      // find my index tolerant to case differences
      const myIdx = ap.approvers.findIndex(a => String(a.name || '').toLowerCase() === myName);
      if (myIdx === -1) return false;

      const firstPending = ap.approvers.findIndex(a => a.status === 'Pending');
      return firstPending === myIdx;
    });

    APPROVED_LIST = all.filter(ap =>
      ap.approvers.some(a => String(a.name || '').toLowerCase() === myName && a.status === 'Accepted')
    );

    REJECT_LIST = all.filter(ap =>
      ap.approvers.some(a => String(a.name || '').toLowerCase() === myName && a.status === 'Rejected')
    );

    applyApproverFilters();       // initial render
    updateApproverBadges();
    wireApproverSectionToggles();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    showSpinner(false);
  }
}

// ▼ NEW — helpers -------------------------------------------
function updateApproverBadges() {
  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setTxt('pendingCount',   PENDING_LIST.length);
  setTxt('approvedCount',  APPROVED_LIST.length);
  setTxt('approvedCount2', APPROVED_LIST.length);
  setTxt('rejectedCount',  REJECT_LIST.length);
  setTxt('rejectedCount2', REJECT_LIST.length);
}

function wireApproverSectionToggles() {
  const showApprovedBtn = document.getElementById('showApprovedBtn');
  if (showApprovedBtn) {
    showApprovedBtn.addEventListener('click', () =>
      document.getElementById('approvedSection').classList.toggle('d-none')
    );
  }
  const showRejectedBtn = document.getElementById('showRejectedBtn');
  if (showRejectedBtn) {
    showRejectedBtn.addEventListener('click', () =>
      document.getElementById('rejectedSection').classList.toggle('d-none')
    );
  }
}
// -----------------------------------------------------------

function applyApproverFilters() {
  // Pending
  filterAndRenderApproverTable({
    list:   PENDING_LIST,
    search: document.getElementById('pendSearch')?.value || '',
    type:   document.getElementById('pendType')?.value  || '',
    tbodySel: '#approverPendingTbl tbody'
  });

  // Approved
  filterAndRenderApproverTable({
    list:   APPROVED_LIST,
    search: document.getElementById('appSearch')?.value  || '',
    tbodySel: '#approverApprovedTbl tbody'
  });

  // Rejected
  filterAndRenderApproverTable({
    list:   REJECT_LIST,
    search: document.getElementById('rejSearch')?.value  || '',
    tbodySel: '#approverRejectedTbl tbody'
  });
}

function filterAndRenderApproverTable({ list, search, type = '', tbodySel }) {
  const tbody = document.querySelector(tbodySel);
  if (!tbody) return;
  tbody.innerHTML = '';

  const q = search.trim().toLowerCase();
  const rows = list.filter(ap => {
    const typeOk = !type || ap.reimbursementType === type;
    const hit = !q || (
      ap.uniqueNumber.toLowerCase().includes(q) ||
      (ap.purpose || '').toLowerCase().includes(q) ||
      (ap.reimbursementType || '').toLowerCase().includes(q) ||
      ap.createdBy.toLowerCase().includes(q)
    );
    return typeOk && hit;
  });

  rows.forEach(ap => {
    const fullPurpose = ap.purpose || '';
    const isTrunc = fullPurpose.length > MAX_PURPOSE;
    const purposeCell = isTrunc
      ? `<span class="purpose-wrap" data-full="${escapeHtml(fullPurpose)}" data-state="short" data-max="${MAX_PURPOSE}">
           <span class="purpose-text">${escapeHtml(shortify(fullPurpose, MAX_PURPOSE).short)}</span>
           <a href="#" class="purpose-toggle">more</a>
         </span>`
      : `<span class="purpose-wrap" data-full="${escapeHtml(fullPurpose)}" data-state="full">
           <span class="purpose-text">${escapeHtml(fullPurpose)}</span>
         </span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="index.html?uniqueNumber=${encodeURIComponent(ap.uniqueNumber)}">${ap.uniqueNumber}</a></td>
      <td>₹ ${formatINR(ap.budget)}</td>
      <td>${purposeCell}</td>
      <td>${escapeHtml(ap.reimbursementType || '')}</td>
      <td>${escapeHtml(displayName(ap.createdBy))}</td>
      <td>${formatDate(ap.createdAt)}</td>
    `;
    tbody.appendChild(tr);
  });

  wirePurposeToggles(tbody);
  $(tbody.closest('table')).trigger('update');
}

/* ────────────────────────────────────────────────────────── */
/* EVENT WIRING (filters & export buttons)                    */
/* ────────────────────────────────────────────────────────── */

function wireUserDashboardControls() {
  const selSearch  = document.getElementById('tblSearch');
  const selStatus  = document.getElementById('statusFilter');
  const selType    = document.getElementById('typeFilter');
  const btnExport  = document.getElementById('exportBtn');

  [selSearch, selStatus, selType].forEach(el => {
    if (el) el.addEventListener('input', applyUserFilters);
  });
  btnExport?.addEventListener('click', () =>
    exportTableToExcel(document.getElementById('userReqTbl'), 'My_NFA.xlsx')
  );
}

function wireApproverDashboardControls() {
  // Pending
  ['pendSearch','pendType'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('input', applyApproverFilters);
  });
  document.getElementById('pendExport')?.addEventListener('click', () =>
    exportTableToExcel(document.getElementById('approverPendingTbl'), 'Pending.xlsx')
  );

  // Approved
  document.getElementById('appSearch')?.addEventListener('input', applyApproverFilters);
  document.getElementById('appExport')?.addEventListener('click', () =>
    exportTableToExcel(document.getElementById('approverApprovedTbl'), 'Approved.xlsx')
  );

  // Rejected
  document.getElementById('rejSearch')?.addEventListener('input', applyApproverFilters);
  document.getElementById('rejExport')?.addEventListener('click', () =>
    exportTableToExcel(document.getElementById('approverRejectedTbl'), 'Rejected.xlsx')
  );
}

/* ────────────────────────────────────────────────────────── */
/* BOOTSTRAP                                                  */
/* ────────────────────────────────────────────────────────── */

const ALL_SECTIONS = ['requesterDash', 'userRequests', 'approverDash', 'expertDash', 'masterDash'];

function showSection(id) {
  ALL_SECTIONS.forEach(secId => {
    const el = document.getElementById(secId);
    if (!el) return;
    el.classList.toggle('d-none', secId !== id);
  });

  // highlight active link
  const miniNavLinks = document.querySelectorAll('#miniNav .mini-link');
  miniNavLinks.forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + id);
  });
}

function initMiniNav(role) {
  const links = document.querySelectorAll('#miniNav .mini-link');
  if (links.length === 0) return; // Exit if no navigation links found
  
  links.forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const targetId = a.getAttribute('href').slice(1);
      showSection(targetId);

      // Load Expert Advice when that tab is opened
      if (targetId === 'expertDash') {
        loadExpertAdvice();
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // default landing tab:
      // default landing tab:
  const APPROVER_LIKE_ROLES = ['approver', 'hr', 'hr-master', 'accounts', 'finance'];
  const r = String(role || '').toLowerCase();
  const defaultId = (APPROVER_LIKE_ROLES.includes(r) || r === 'master')
    ? 'approverDash'
    : 'userRequests';





  setTimeout(() => showSection(defaultId), 0);
}

// -------- BOOTSTRAP --------
// -------- BOOTSTRAP --------
fetchMe()
  .then(async ({ username, role }) => {
    await loadDirectoryMap();

    // If server returned role 'user' but the username is a known approver email,
    // treat the user as approver-like on the client so the approver panel is visible.
    // This is a minimal safety-first workaround; server-side role fix is recommended.
    const lowerUser = String(username || '').toLowerCase();
    const HR_EMAIL = 'hr@adventz.zuarimoney.com';
    const ACC_EMAILS = ['accounts@adventz.zuarimoney.com', 'accounts.team@adventz.com'];

    let effectiveRole = role;
    if (lowerUser === HR_EMAIL) effectiveRole = 'hr-master';

    else if (ACC_EMAILS.includes(lowerUser)) effectiveRole = 'accounts';

    // mount UI using the effective role
    mount(effectiveRole, username);
    await setWelcomeName();
    initMiniNav(effectiveRole);
    wireUserDashboardControls();
    wireApproverDashboardControls();

    // Ensure approver queue tries to load once we have username (safe no-op otherwise)
    try { renderApproverQueues(username); } catch(e) { /* ignore */ }

    // ✅ Auth OK — reveal the app
    document.body.classList.remove('preauth');
  })
  .catch(() => {
    // ❌ Not authenticated — go to login immediately (no UI flash)
    window.location.replace('login.html');
  });


/* ────────────────────────────────────────────────────────── */
/* EXPERT ADVICE                                              */
/* ────────────────────────────────────────────────────────── */

async function loadExpertAdvice() {
  try {
    const r = await fetch('/api/approvals/expert');
    if (!r.ok) throw new Error('Failed to load expert items');
    const list = await r.json(); // array of approvals

    const container = document.getElementById('expertList'); // create this div in dash.html
    if (!container) return;

    container.innerHTML = list.length
      ? list.map(ap => `
          <div class="card mb-2 p-3">
            <div class="d-flex justify-content-between align-items-center">
              <div>
                <div><strong>${ap.uniqueNumber}</strong></div>
                <div class="text-muted small">₹ ${Number(ap.budget).toLocaleString('en-IN')} · ${escapeHtml(ap.reimbursementType || '')}</div>
                <div class="small">${ap.purpose || ''}</div>
              </div>
              <a class="btn btn-sm btn-outline-primary"
                 href="index.html?uniqueNumber=${encodeURIComponent(ap.uniqueNumber)}"
                 title="Open read-only view with chat">Open</a>
            </div>
          </div>
        `).join('')
      : `<div class="text-muted">Nothing yet. You’ll see requests here when someone @mentions you in chat.</div>`;
  } catch (e) {
    console.error(e);
    toast('Unable to load Expert Advice', 'error');
  }
}
