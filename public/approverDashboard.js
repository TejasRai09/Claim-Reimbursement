/* -------------------------------------------------------------
   Approver Dashboard logic  → filter, search, export added
   ------------------------------------------------------------- */
const spin   = id('spinnerOverlay');
const toast  = (m, t = 'info') =>
  Toastify({ text: m, duration: 3500, close: true,
             style: { background: t === 'error' ? '#dc3545' : '#0060df' } }).showToast();
const show   = s => spin && (spin.style.display = s ? 'flex' : 'none');
function id(x) { return document.getElementById(x); }            // shortcut

const formatINR  = n => Number(n || 0).toLocaleString('en-IN');
const DATE_OPTS  = { day:'2-digit', month:'2-digit', year:'numeric',
                     hour:'2-digit', minute:'2-digit' };

/* ---------- Name-mapping helpers ---------- */
let EMAIL_TO_NAME = {};
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, s =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[s]));
}
async function loadDirectoryMap() {
  try {
    const r = await fetch('/api/approvers');
    if (!r.ok) return;
    const list = await r.json();                         // [{ label, value }]
    EMAIL_TO_NAME = Object.fromEntries(
      list.map(p => [String(p.value || '').toLowerCase(), p.label]));
  } catch {}
}
const displayName = email => {
  const key = String(email || '').toLowerCase();
  return EMAIL_TO_NAME[key] || (email ? email.split('@')[0] : '');
};
async function setWelcomeName() {
  try {
    const r = await fetch('/api/directory/me');
    if (!r.ok) return;
    const meDir = await r.json();
    if (meDir && id('welcomeTxt')) id('welcomeTxt').textContent =
      `Hi, ${meDir.name || displayName(meDir.email)}`;
  } catch {}
}

/* ---------- Globals for filtering/export ---------- */
let ALL_QUEUE    = [];      // full list (my-turn items)
let FILTERED     = [];      // after search/filter
const tbody      = id('approverTblBody');
const searchEl   = id('searchInput');
/* NOTE: ensure your HTML has an element with id="typeFilter" */
const typeSel    = id('typeFilter');

/* ---------- small helpers ---------- */
function getMyStatus(ap) {
  if (!ap || !Array.isArray(ap.approvers)) return '(unknown)';
  const me = ap._me || '';
  const rec = ap.approvers.find(a => String(a.name || '').toLowerCase() === String(me).toLowerCase());
  return (rec && rec.status) ? rec.status : '(unknown)';
}

/* ---------- Render helpers ---------- */
function renderRows(list) {
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!list.length) id('emptyMsg')?.classList.remove('d-none');
  else              id('emptyMsg')?.classList.add   ('d-none');

  list.forEach(ap => {
    const myStatus = getMyStatus(ap);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="index.html?uniqueNumber=${encodeURIComponent(ap.uniqueNumber || '')}">
            ${escapeHtml(ap.uniqueNumber || '—')}</a></td>
      <td>₹ ${formatINR(ap.budget)}</td>
      <td>${escapeHtml(ap.purpose || '')}</td>
      <td>${escapeHtml(displayName(ap.createdBy || ''))}</td>
      <td>${ap.createdAt ? new Date(ap.createdAt).toLocaleString(undefined, DATE_OPTS) : '—'}</td>
      <td>${escapeHtml(myStatus)}</td>
      <td><a class="btn btn-sm btn-outline-primary"
             href="index.html?uniqueNumber=${encodeURIComponent(ap.uniqueNumber || '')}">
             Open</a></td>`;
    tbody.appendChild(tr);
  });
}

/* ---------- Apply search + type filters ---------- */
function applyFilters() {
  if (!Array.isArray(ALL_QUEUE)) { FILTERED = []; renderRows(FILTERED); return; }
  const q   = (searchEl?.value || '').toLowerCase().trim();
  const type = (typeSel?.value || '').trim();

  FILTERED = ALL_QUEUE.filter(ap => {
    const txt = `${ap.uniqueNumber || ''} ${ap.purpose || ''} ${ap.createdBy || ''}`.toLowerCase();
    const matchesSearch = !q || txt.includes(q);
    const matchesType   = !type || String(ap.reimbursementType || '').toLowerCase() === type.toLowerCase();
    return matchesSearch && matchesType;
  });
  renderRows(FILTERED);
}

/* ---------- Export visible table to Excel ---------- */
function exportVisible() {
  if (!FILTERED.length) { toast('Nothing to export', 'error'); return; }

  // make a lean array for SheetJS
  const data = FILTERED.map(ap => ({
    'Unique #':  ap.uniqueNumber,
    'Budget ₹':  formatINR(ap.budget),
    Purpose:     ap.purpose,
    'Reimbursement Type':  ap.reimbursementType || '',
    'Created By':displayName(ap.createdBy || ''),
    Created:     ap.createdAt ? new Date(ap.createdAt).toLocaleString(undefined, DATE_OPTS) : '',
    Status:      getMyStatus(ap)
  }));
  const ws  = XLSX.utils.json_to_sheet(data);
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pending');
  XLSX.writeFile(wb, `ApproverQueue_${new Date().toISOString().slice(0,10)}.xlsx`);
}

/* ---------- Main boot ---------- */
(async () => {
  try {
    show(true);

    /* ---- auth ---- */
    const uRes = await fetch('/api/me');
    if (!uRes.ok) throw new Error('Unauthenticated');
    const me = await uRes.json();
    if (String(me.role).toLowerCase() !== 'approver') {
      toast('Access denied', 'error');
      return window.location.href = 'dash.html';
    }

    /* ---- directory for names + header ---- */
    await loadDirectoryMap();
    await setWelcomeName();

    /* ---- load approvals ---- */
    const res = await fetch(`/api/approvals/for-approver-all/${encodeURIComponent(me.username)}`);
    if (!res.ok) throw new Error('Fetch failed');
    const apps = await res.json();

    // keep only items that are *my turn* and not drafts
    ALL_QUEUE = apps.filter(ap => {
      if (!ap?.approvers || !Array.isArray(ap.approvers)) return false;
      const myIdx        = ap.approvers.findIndex(a => String(a.name || '').toLowerCase() === String(me.username).toLowerCase());
      const firstPending = ap.approvers.findIndex(a => a.status === 'Pending');
      return myIdx !== -1 && myIdx === firstPending && !ap.isDraft;
    }).map(ap => ({ ...ap, _me: me.username }));      // stash for quick status

    applyFilters();                                   // first render
  } catch (e) {
    toast(e.message || 'Error', 'error');
    setTimeout(() => window.location.href = 'login.html', 1500);
  } finally {
    show(false);
  }
})();

/* ---------- UI event wiring ---------- */
if (searchEl) searchEl.addEventListener('input',  applyFilters);
if (typeSel)  typeSel.addEventListener('change', applyFilters);
id('refreshBtn')?.addEventListener('click', () => location.reload());
id('exportBtn')?.addEventListener('click', exportVisible);

/* ---------- Logout ---------- */
id('logoutBtn')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  window.location.href = 'login.html';
});
