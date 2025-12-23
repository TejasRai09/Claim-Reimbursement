// File: public/app.js
// --------------------------------------------------
// Handles NEW request creation (with draft), VIEW (read-only),
// and UPDATE (approver/master) via ?uniqueNumber=... or ?draft=1

/* ---------------- utilities ---------------- */
const qs      = new URLSearchParams(window.location.search);
const idQ     = qs.get('uniqueNumber');
const draftId = qs.get('draftId'); // server-side stored draft

// const isDraft = qs.get('draft') === '1';
const $       = sel => document.querySelector(sel);
const spinner = $('#spinnerOverlay');
const toast   = (msg, type = 'info') => Toastify({
  text: msg,
  style: {
    background:
      type === 'error'   ? '#dc3545' :
      type === 'success' ? '#28a745' :
                          '#0060df'
  },
  duration: 3500,
  close: true
}).showToast();
const showSpin = on => spinner.style.display = on ? 'flex' : 'none';

// ---------- ₹ formatter (lakh / crore commas) ----------
const formatINR = n => Number(n).toLocaleString('en-IN');
// dd-mm-yyyy
const formatDate = d => {
  const dt = new Date(d);
  if (isNaN(dt)) return '-';

  const dd = String(dt.getDate()).padStart(2,'0');
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const yyyy = dt.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};


/* ---------------- constants ---------------- */
let APPROVERS = [];
const DEPT_LIST      = ['Finance','Sales','IT','HR','Operations'];

const HR_APPROVER_EMAIL      = 'hr@adventz.zuarimoney.com';
const FINANCE_APPROVER_EMAIL = 'accounts@adventz.zuarimoney.com';

const FIXED_APPROVER_LIST    = true;   // lock approvers for requesters

// ---- Name mapping helpers (show names instead of emails) ----
let EMAIL_TO_NAME = {};

const displayName = (email = '') => {
  const key = String(email || '').toLowerCase();
  return EMAIL_TO_NAME[key] || (email?.split('@')[0] || email);
};

async function loadDirectoryMap() {
  try {
    // Prefer already-fetched approvers to avoid an extra call
    const list = (Array.isArray(APPROVERS) && APPROVERS.length)
      ? APPROVERS
      : await (await fetch('/api/approvers')).json(); // [{label, value}]
    EMAIL_TO_NAME = Object.fromEntries(
      list.map(p => [String(p.value || '').toLowerCase(), p.label])
    );
  } catch {}
}

async function setWelcomeName() {
  try {
    const r = await fetch('/api/directory/me'); // { name, email, ... }
    if (!r.ok) return;
    const meDir = await r.json();
    myDirectory = meDir; // store full directory profile (for managerEmail, etc.)

    const el = document.getElementById('welcomeTxt');
    if (el && (meDir?.name || meDir?.email)) {
      el.textContent = `Hi, ${meDir.name || displayName(meDir.email)}`;
    }
  } catch {}
}


/* ---------------- globals ---------------- */
let me   = null;               // { username, role }
let mode = idQ ? 'update' : 'create';
let PEOPLE_CACHE = null;
let myDirectory  = null;       // directory profile of logged-in user

/* ---------------- boot ---------------- */
(async function init(){
  try {
    showSpin(true);
    const res = await fetch('/api/me');
    if (!res.ok) throw new Error('Unauthenticated');
    me = await res.json();

    const apListRes = await fetch('/api/approvers');
    if (!apListRes.ok) throw new Error('Approver directory unavailable');
    APPROVERS = await apListRes.json(); // [{label, value}, ...]

    await loadDirectoryMap();
    await setWelcomeName();

    if (!idQ && !draftId) {
      // Brand-new request
      mountCreate();
      return;
    }

    // Either detailed view or draft
    if (draftId) {
      await mountCreateFromDraft(draftId);
      return;
    }

    // Load the approval to decide what to show
    const apRes = await fetch(`/api/approvals/${encodeURIComponent(idQ)}`);
    if (!apRes.ok) throw new Error('Not found');
    const ap = await apRes.json();

    const isMine = ap.createdBy === me.username;
    const canAct = !ap.isDraft && isMyTurnClient(ap, me.username);

    if (isMine) {
      // requester (read-only)
      mountRequesterView(idQ);
    } else if (canAct) {
      // approver can act
      mode = 'update';
      await mountUpdate(idQ);
    } else {
      // just read-only viewer
      mountRequesterView(idQ);
    }

  } catch (err) {
    toast(err.message || 'Session expired', 'error');
    setTimeout(() => window.location.href = 'login.html', 1500);
  } finally {
    showSpin(false);
  }
})();


/* ---------------- fixed approver chain helper ---------------- */
// Manager (from directory) → HR → Finance & Accounts
function getFixedApprovers() {
  const chainEmails = [];

  const managerEmail = (myDirectory?.managerEmail || '').toLowerCase();
  if (managerEmail) chainEmails.push(managerEmail);

  chainEmails.push(HR_APPROVER_EMAIL.toLowerCase());
  chainEmails.push(FINANCE_APPROVER_EMAIL.toLowerCase());

  // dedupe while preserving order
  const seen = new Set();
  const uniqueEmails = [];
  for (const e of chainEmails) {
    if (!e) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    uniqueEmails.push(e);
  }

  return uniqueEmails.map(email => ({
    name:   email,
    status: 'Pending'
  }));
}


/* ---------------- create flow w/ draft ---------------- */
function mountCreate() {
  if (!['user','approver','master'].includes(me.role)) {
    toast('You are not allowed to create requests', 'error');
    return window.location.href = 'dash.html';
  }

  // Skip the “Generate Request” splash and open the form instantly
  startForm();

  async function startForm() {
    let uniq;
    if (mountCreate._prefill) {
      // keep the draft’s id
      uniq = mountCreate._prefill.uniqueNumber;
    } else {
      // brand-new request/draft – ask the server
      const r  = await fetch('/api/approvals/next-id');
      const js = await r.json();
      uniq     = js.id;
    }
    $('#uniqueNumber').value = uniq;
    $('#requestContainer').classList.add('d-none');
    $('#approvalForm').classList.remove('d-none');

    CKEDITOR.replace('details', { height: 180 });

    // NOTE: department auto-fill removed — we now use reimbursementType dropdown
    // (the select with id="reimbursementType" is expected in index.html)

    // Reset approvers container
    $('#approversContainer').innerHTML = '';

    // Prefill basic fields from draft if present
    if (mountCreate._prefill) {
      const d = mountCreate._prefill;
      $('#budget').value     = formatINR(d.budget || 0);
      $('#reimbursementType').value = d.reimbursementType || '';
      $('#purpose').value    = d.purpose || '';
      CKEDITOR.instances.details.setData(d.details || '');
    }

    // Build fixed approver chain (manager → HR → F&A)
    const fixedApprovers = getFixedApprovers();
    fixedApprovers.forEach(a => buildApproverRow(a));

    // —— ₹ format for the amount input —————————————
    const budgetInput = $('#budget');
    
    // Strip commas on focus so the user edits a plain number
    budgetInput.addEventListener('focus', () => {
      budgetInput.value = budgetInput.value.replace(/,/g, '');
    });
    
    // Re-format with Indian commas on blur
    budgetInput.addEventListener('blur', () => {
      const raw = budgetInput.value.replace(/,/g, '');
      if (raw && !isNaN(raw)) budgetInput.value = formatINR(raw);
    });

    // Hide/disable “Add Approver” in fixed-chain mode
    const addBtn = $('#addApproverBtn');
    if (addBtn) {
      addBtn.classList.add('d-none');
      addBtn.disabled = true;
    }

    $('#approvalForm').addEventListener('submit', submitCreate);

    const actions = document.querySelector('.d-flex.justify-content-end');
    const draftBtn = document.createElement('button');
    draftBtn.type = 'button';
    draftBtn.id   = 'saveDraftBtn';
    draftBtn.className = 'btn btn-secondary btn-lg';
    draftBtn.textContent = 'Save Draft';
    actions.insertBefore(draftBtn, $('#submitBtn'));
    draftBtn.addEventListener('click', saveDraft);

    refreshApproverSelects();
  }
}

function isMyTurnClient(ap, username) {
  const firstPending = ap.approvers.findIndex(a => a.status === 'Pending');
  const myIdx        = ap.approvers.findIndex(a => a.name === username);
  return firstPending !== -1 && myIdx === firstPending;
}


async function submitCreate(evt) {
  // prevent default if called as form submit handler
  try { if (evt && typeof evt.preventDefault === 'function') evt.preventDefault(); } catch(e){}

  // defensive CKEditor update
  if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances && CKEDITOR.instances.details) {
    try { CKEDITOR.instances.details.updateElement(); } catch (e) { console.warn('CKEDITOR updateElement failed', e); }
  }

  // NOTE: purpose field removed from form by user — no client-side required check here.

  // simple budget validation (allow blank → treated as 0)
  const budgetRaw = String(document.querySelector('#budget')?.value || '').replace(/,/g,'').trim();
  if (budgetRaw && isNaN(budgetRaw)) {
    toast('Please enter a valid numeric Budget (no letters).', 'error');
    document.querySelector('#budget')?.focus();
    return;
  }

  // final duplicate check on visible selects (defensive, though we already dedupe)
  const selected = Array.from(document.querySelectorAll('.approver-row select'))
                    .map(s=>s.value);
  if (new Set(selected).size !== selected.length) {
    toast('Duplicate approvers selected!','error');
    return;
  }

  if (!confirm('Submit request?')) return;

  let payload = collectFormData();

  // if user pressed “Save Draft” before the server gave us an ID
  if (!payload.uniqueNumber) {
    const r  = await fetch('/api/approvals/next-id');
    const js = await r.json();
    $('#uniqueNumber').value = js.id;
    payload = collectFormData();
  }
  const isServerDraft = !!mountCreate._prefill;
  const finalId = isServerDraft
    ? mountCreate._prefill.uniqueNumber
    : payload.uniqueNumber;

  payload.createdBy = me.username;

  try {
    showSpin(true);

    /* 1️⃣  create approval */
    if (isServerDraft) {
      const res = await fetch(`/api/drafts/${encodeURIComponent(finalId)}/submit`, {
        method: 'PATCH'
      });
      if (!res.ok) throw new Error('Failed to submit draft');
    } else {
      const createRes = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });

      if (!createRes.ok) {
        // try parse JSON body first (validation errors)
        const contentType = createRes.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const j = await createRes.json().catch(()=>null);
          if (j && j.errors) {
            // pick first error to show
            const first = Object.entries(j.errors)[0];
            const msg = first ? `${first[0]}: ${first[1]}` : (j.message || 'Create failed');
            throw new Error(msg);
          } else if (j && j.message) {
            throw new Error(j.message);
          } else {
            const text = await createRes.text().catch(()=>'<no body>');
            throw new Error(text || 'Create failed');
          }
        } else {
          const text = await createRes.text().catch(()=>'<no body>');
          throw new Error(text || `Create failed (${createRes.status})`);
        }
      }
      // (no need to read body here on success)
    }
    
    /* 2️⃣  upload files */
    // If it was a draft we already uploaded files when we saved the draft.
    // For a brand-new (non-draft) create, keep the upload block:
    if (!isServerDraft) {
      const files = $('#attachments')?.files || [];
      if (files.length) {
        const fd = new FormData();
        Array.from(files).forEach(f=>fd.append('files',f));
        const upRes = await fetch(
          `/api/approvals/${encodeURIComponent(finalId)}/attachments`,
          { method:'POST', body:fd }
        );
        if (!upRes.ok) {
          const txt = await upRes.text().catch(()=>'<no body>');
          throw new Error(txt || 'Failed to upload attachments');
        }
      }
    }

    toast('Request submitted','success');
    window.location.href = 'dash.html';
  } catch (err) {
    console.error('submitCreate error:', err);
    toast(err.message || 'Error creating request','error');
  } finally {
    showSpin(false);
  }
}


async function saveDraft() {
  if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances && CKEDITOR.instances.details) {
    try { CKEDITOR.instances.details.updateElement(); } catch(e){ console.warn('CKEDITOR updateElement failed', e); }
  }
  const payload = collectFormData();

  try {
    showSpin(true);

    // 1) save (upsert) the draft
    const r = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(await r.text());
    const { uniqueNumber } = payload; // server saves with this id

    // 2) upload attachments (if any)
    const files = $('#attachments')?.files || [];
    if (files.length) {
      const fd = new FormData();
      Array.from(files).forEach(f => fd.append('files', f));
      const up = await fetch(`/api/drafts/${encodeURIComponent(uniqueNumber)}/attachments`, {
        method: 'POST',
        body: fd
      });
      if (!up.ok) throw new Error(await up.text());
      $('#attachments').value = '';
    }

    toast('Draft saved', 'success');
    // Optional: redirect user back to dash
    // window.location.href = 'dash.html';
  } catch (e) {
    toast(e.message || 'Error saving draft', 'error');
  } finally {
    showSpin(false);
  }
}

async function loadPeople() {
  if (PEOPLE_CACHE) return PEOPLE_CACHE;
  try {
    const r = await fetch('/api/approvers');
    if (!r.ok) throw new Error('Failed to load directory');
    const list = await r.json(); // [{label, value}]
    // normalize / add search fields
    PEOPLE_CACHE = list.map(p => ({
      label: p.label,
      value: (p.value || '').toLowerCase(),
      labelLc: (p.label || '').toLowerCase()
    }));
  } catch {
    PEOPLE_CACHE = [];
  }
  return PEOPLE_CACHE;
}
function filterPeople(query='') {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  // startsWith on any word of name OR on email
  return (PEOPLE_CACHE || []).filter(p => {
    const nameWords = p.labelLc.split(/\s+/);
    const nameHit = nameWords.some(w => w.startsWith(q));
    const emailHit = p.value.startsWith(q);
    return nameHit || emailHit;
  }).slice(0, 12); // limit to 12
}


/* ---------------- approver rows helpers ---------------- */
function refreshApproverSelects() {
  const rows    = Array.from(document.querySelectorAll('.approver-row'));
  const chosen  = rows.map(r=> r.querySelector('select').value);

  rows.forEach(r => {
    const sel = r.querySelector('select');
    APPROVERS.forEach(ap => {
      const opt = sel.querySelector(`option[value="${ap.value}"]`);
      if (opt) opt.disabled = chosen.includes(ap.value) && sel.value !== ap.value;
    });
  });

  const addBtn = $('#addApproverBtn');
  if (addBtn) {
    if (FIXED_APPROVER_LIST && mode === 'create') {
      addBtn.disabled = true;
    } else {
      addBtn.disabled = chosen.length >= APPROVERS.length;
    }
  }
}

function buildApproverRow(obj={name:'',status:'Pending'}) {
  const row = document.createElement('div');
  row.className = 'approver-row d-flex align-items-center gap-3 flex-wrap';

  /* select */
  const sel = document.createElement('select');
  sel.className = 'form-select';

  // show last action date (if any)
  const dateTag = document.createElement('small');
  dateTag.className = 'text-muted ms-1';
  if (obj.updatedAt) dateTag.textContent = ` (${formatDate(obj.updatedAt)})`;

  APPROVERS.forEach(ap => {
    const opt = document.createElement('option');
    opt.value = ap.value;        // stored e-mail
    opt.textContent = ap.label;  // display name
    if (ap.value === obj.name) opt.selected = true;
    sel.appendChild(opt);
  });

  // If the approver e-mail is not in APPROVERS list (e.g. HR / F&A hardcoded),
  // add a synthetic option so the UI still shows the correct email.
  if (obj.name && !sel.querySelector(`option[value="${obj.name}"]`)) {
    const extra = document.createElement('option');
    extra.value = obj.name;
    extra.textContent = obj.name;
    extra.selected = true;
    sel.appendChild(extra);
  }

  // In create mode with fixed chain, requester cannot change approvers
  if (mode === 'create' && FIXED_APPROVER_LIST) {
    sel.disabled = true;
  }

  /* approve / reject buttons (disabled in create mode) */
  const btnApprove = document.createElement('button');
  btnApprove.type  = 'button';
  btnApprove.textContent = 'Approve';
  btnApprove.className   = 'btn btn-sm btn-outline-success';
  btnApprove.disabled    = true;
  btnApprove.classList.add('no-pdf');

  const btnReject = document.createElement('button');
  btnReject.type  = 'button';
  btnReject.textContent = 'Reject';
  btnReject.className   = 'btn btn-sm btn-outline-danger';
  btnReject.disabled    = true;
  btnReject.classList.add('no-pdf');

  // ----- Comment input (only relevant in update mode) -----
  let inputComment = null;
  if (mode === 'update') {                           // 👈 requester never sees it
    inputComment = document.createElement('input');
    inputComment.type  = 'text';
    inputComment.placeholder = 'Comment';
    inputComment.className   = 'form-control form-control-sm flex-grow-1';

    if (obj.comment) inputComment.value = obj.comment;
    inputComment.readOnly = true;
    inputComment.classList.add('no-pdf');                    // default lock
  }

  /* delete-row button kept only while creating (and when list is not fixed) */
  let btnDel = null;
  if (mode === 'create' && !FIXED_APPROVER_LIST) {
    btnDel = document.createElement('button');
    btnDel.type  = 'button';
    btnDel.title = 'Remove';
    btnDel.innerHTML = '🗑';
    btnDel.className = 'btn btn-sm btn-outline-danger';
    btnDel.addEventListener('click', ()=>{
      row.remove();
      refreshApproverSelects();
    });
  }

  sel.addEventListener('change', refreshApproverSelects);

  row.append(sel, dateTag);
  if (inputComment) row.append(inputComment);        // only in update mode
  row.append(btnApprove, btnReject);
  if (btnDel) row.append(btnDel);

  $('#approversContainer').appendChild(row);
  return { sel, btnApprove, btnReject, inputComment };
}

/* ---------------- helpers used by chat & print ---------------- */
function escapeHtml(str=''){
  return str.replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s]));
}
// highlight @mentions in a message (UI only)
function highlightMentions(text=''){
  return escapeHtml(text).replace(/@(\S+)/g, (_m, u) => {
    const user = u.replace(/[),.;:!?]+$/, ''); // mirror server trimming
    return `<span class="chat-mention">@${user}</span>`;
  });
}

/* ✅ Moved here: top-level so injectPdfButton can call it */
async function buildPrintableTranscript(uniq) {
  try {
    const r = await fetch(`/api/approvals/${encodeURIComponent(uniq)}/chat`);
    if (!r.ok) throw new Error('Chat fetch failed');
    const msgs = await r.json(); // [{ author, text, createdAt }]

    const wrap = document.createElement('div');
    wrap.className = 'print-transcript';

    const header = document.createElement('h3');
    header.textContent = 'Conversation';
    wrap.appendChild(header);

    if (!msgs.length) {
      const none = document.createElement('div');
      none.className = 'text-muted';
      none.textContent = 'No messages yet.';
      wrap.appendChild(none);
      return wrap;
    }

    msgs.forEach(m => {
      const msg = document.createElement('div');
      msg.className = 'print-msg';

      const meta = document.createElement('div');
      meta.className = 'print-meta';
      const when = new Date(m.createdAt).toLocaleString();
      meta.textContent = `${displayName(m.author)} · ${when}`;
      const body = document.createElement('div');
      body.className = 'wrap-anywhere';
      // reuse your mention highlighter; it returns HTML
      body.innerHTML = highlightMentions(m.text || '');

      msg.appendChild(meta);
      msg.appendChild(body);
      wrap.appendChild(msg);
    });

    return wrap;
  } catch {
    const err = document.createElement('div');
    err.className = 'print-transcript text-danger';
    err.textContent = 'Unable to load conversation.';
    return err;
  }
}

/* ---------------- chat ---------------- */
function startChat(uniq, meName){
  const panel   = $('#chatPanel');
  const listEl  = $('#chatMessages');
  const inputEl = $('#chatText');
  const sendBtn = $('#sendChatBtn');

  if (!panel || !listEl || !inputEl || !sendBtn) return;
  panel.classList.remove('d-none');

  // @mention — elements & state
  const mentionUl = document.getElementById('mentionList');
  let mentionOpen = false;
  let mentionIdx  = -1;
  let mentionList = [];

  // @mention — render/toggle
  function renderMentionList(items) {
    if (!items.length) {
      mentionUl?.classList.add('d-none');
      if (mentionUl) mentionUl.innerHTML = '';
      mentionOpen = false;
      mentionIdx = -1;
      return;
    }
    if (mentionUl) {
      mentionUl.innerHTML = items.map((p,i)=>`
        <li class="mention-item ${i===mentionIdx?'active':''}" data-i="${i}">
          <strong>${escapeHtml(p.label)}</strong>
          <small>${escapeHtml(p.value)}</small>
        </li>`).join('');
      mentionUl.classList.remove('d-none');
    }
    mentionOpen = true;
  }
  function closeMention() { renderMentionList([]); }

  // Insert the picked @mention into the textarea
  function pickMention(i) {
    if (i < 0 || i >= mentionList.length) return;
    const picked = mentionList[i];               // {label, value}
    const { start, end } = getMentionTokenRange();
    const before = inputEl.value.slice(0, start);
    const after  = inputEl.value.slice(end);
    const insert = '@' + picked.value + ' ';     // insert @email
    inputEl.value = before + insert + after;
    const pos = (before + insert).length;
    inputEl.setSelectionRange(pos, pos);
    closeMention();
  }

  // Find the current @token (start..end) around caret
  function getMentionTokenRange() {
    const pos  = inputEl.selectionStart;
    const text = inputEl.value;

    // scan backwards from caret to the start of the current word
    let i = pos - 1;
    while (i >= 0 && !/\s/.test(text[i])) i--;
    const tokenStart = i + 1;

    // if this word doesn't start with '@', there is no mention token
    if (text[tokenStart] !== '@') {
      return { start: pos, end: pos, token: null };
    }

    // scan forward to the end of the token (space or punctuation)
    let j = tokenStart + 1;
    while (j < text.length && !/[\s,;:!?.]/.test(text[j])) j++;

    return { start: tokenStart, end: j, token: text.slice(tokenStart + 1, j) };
  }

  // @mention — click to select
  mentionUl?.addEventListener('click', (e) => {
    const li = e.target.closest('.mention-item');
    if (!li) return;
    pickMention(parseInt(li.dataset.i, 10));
    inputEl.focus();
  });

  // Load directory once for mentions
  (async () => { try { await loadPeople(); } catch {} })();

  let polling = null;
  let lastCount = -1;
  
  async function loadMessages(){
    try{
      const r = await fetch(`/api/approvals/${encodeURIComponent(uniq)}/chat`);
      if(!r.ok) return; // silent
      const msgs = await r.json();

      // re-render only if changed
      if (msgs.length === lastCount) return;
      lastCount = msgs.length;

      listEl.innerHTML = msgs.map(m => {
        const when = new Date(m.createdAt).toLocaleString();
        const who  = escapeHtml(displayName(m.author));
        const body = highlightMentions(m.text || '');
        return `
          <div class="chat-msg">
            <div class="chat-meta"><strong>${who}</strong> · ${when}</div>
            <div class="chat-text">${body}</div>
          </div>`;
      }).join('');

      // scroll to bottom
      listEl.scrollTop = listEl.scrollHeight;
    }catch{}
  }

  async function sendMessage(){
    // If mention list is open, Enter should pick suggestion (not send)
    if (mentionOpen && mentionIdx >= 0) {
      pickMention(mentionIdx);
      return;
    }

    const txt = inputEl.value.trim();
    if(!txt) return;
    sendBtn.disabled = true;
    try{
      const r = await fetch(`/api/approvals/${encodeURIComponent(uniq)}/chat`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text: txt })
      });
      if(!r.ok){
        toast('Failed to send', 'error');
        return;
      }
      inputEl.value = '';
      await loadMessages();
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  // send on click
  sendBtn.addEventListener('click', sendMessage);

  // Enter to send; Shift+Enter for newline (now aware of mention state)
  inputEl.addEventListener('keydown', e => {
    // @mention — navigation in list
    if (mentionOpen && ['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'ArrowDown') { mentionIdx = (mentionIdx + 1) % mentionList.length; renderMentionList(mentionList); }
      if (e.key === 'ArrowUp')   { mentionIdx = (mentionIdx - 1 + mentionList.length) % mentionList.length; renderMentionList(mentionList); }
      if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mentionIdx < 0 ? 0 : mentionIdx); }
      if (e.key === 'Escape') { closeMention(); }
      return;
    }
    // your existing send behavior
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // @mention — detect @token as user types
  inputEl.addEventListener('input', () => {
    const { token } = (function getMentionTokenRangeLocal() {
      const pos  = inputEl.selectionStart;
      const text = inputEl.value;
      let i = pos - 1;
      while (i >= 0 && !/\s/.test(text[i])) i--;
      const tokenStart = i + 1;
      if (text[tokenStart] !== '@') return { start: pos, end: pos, token: null };
      let j = tokenStart + 1;
      while (j < text.length && !/[\s,;:!?.]/.test(text[j])) j++;
      return { start: tokenStart, end: j, token: text.slice(tokenStart + 1, j) };
    })();

    // Only show suggestions when we're inside an @mention token
    if (token === null) {
      closeMention();
      return;
    }

    if (token.length === 0) {
      // Just typed "@": show a short list of people
      mentionList = (PEOPLE_CACHE || []).slice(0, 12);
      mentionIdx = 0;
      renderMentionList(mentionList);
    } else {
      // Filter as user types after "@"
      mentionList = filterPeople(token);
      mentionIdx = 0;
      renderMentionList(mentionList);
    }
  });

  // initial + poll
  loadMessages();
  polling = setInterval(loadMessages, 3000);

  // optional: stop polling if we ever hide the panel
  panel.addEventListener('DOMNodeRemovedFromDocument', () => clearInterval(polling));
}

/* ---------------- read-only requester view ---------------- */
async function mountRequesterView(uniq) {
  try {
    showSpin(true);
    const res = await fetch(`/api/approvals/${encodeURIComponent(uniq)}`);
    if (!res.ok) throw new Error('Not found');
    const ap = await res.json();

    // target ONLY the left column so the chat column remains in DOM
    const leftCol = document.getElementById('formCol');   // ← matches your new index.html
    if (!leftCol) throw new Error('Layout missing left column');

    leftCol.innerHTML = `
      <div class="card shadow-sm p-4">
        <h3 class="mb-3">Request Details</h3>
        <p><strong>Created on:</strong> ${formatDate(ap.createdAt)}</p>
        <p><strong>Created by:</strong> ${escapeHtml(displayName(ap.createdBy))}</p>
        <p><strong>Unique Number:</strong> ${ap.uniqueNumber}</p>
        <p><strong>Budget:</strong> ₹ ${formatINR(ap.budget)}</p>
        <p><strong>Reimbursement Type:</strong> ${escapeHtml(ap.reimbursementType || '-')}</p>
        <p><strong>Purpose:</strong> ${ap.purpose}</p>
        <p><strong>Details:</strong></p>
        <div class="border p-2 mb-3">${ap.details || '<em>No details</em>'}</div>
        ${ap.attachments?.length ? `
          <h5>Attachments</h5>
          <ul>${ap.attachments.map(a => `
            <li><a href="/uploads/${a.filename}" download="${a.originalName}" target="_blank">${a.originalName}</a></li>`).join('')}
          </ul>` : ''}
        <h5>Approvers</h5>
        <ul>${ap.approvers.map(a =>
  `<li>${escapeHtml(displayName(a.name))}: ${a.status}${a.updatedAt ? ` (${formatDate(a.updatedAt)})` : ''}${a.comment ? ` – "${escapeHtml(a.comment)}"` : ''}</li>`
).join('')}</ul>


        <a href="dash.html" class="btn btn-primary mt-3 no-pdf">Back</a>
      </div>
    `;

    // keep PDF button working on the new card
    injectPdfButton(leftCol.querySelector('.card'), ap.uniqueNumber);

    // ✅ chat panel still exists on the right, so this will show it
    startChat(uniq, me.username);

  } catch (err) {
    toast(err.message, 'error');
    setTimeout(() => window.location.href = 'dash.html', 1500);
  } finally {
    showSpin(false);
  }
}


/* ---------------- update flow (approver/master) ---------------- */
/* ---------------- update flow (approver/master) — REPLACE ENTIRE FUNCTION ---------------- */
async function mountUpdate(uniq) {
  try {
    showSpin(true);
    const res = await fetch(`/api/approvals/${encodeURIComponent(uniq)}`);
    if (!res.ok) throw new Error('Not found');
    const ap = await res.json();

    // 🔒 Hide the editable form for approvers/master — read-only card instead
    const formEl = $('#approvalForm');
    if (formEl) formEl.classList.add('d-none');

    const leftCol = document.getElementById('formCol');
    if (!leftCol) throw new Error('Layout missing left column');

    // Is it my turn?
    const meLc = (me.username || '').toLowerCase();
    const firstPendingIdx = ap.approvers.findIndex(a => a.status === 'Pending');
    const myIdx = ap.approvers.findIndex(a => (a.name || '').toLowerCase() === meLc);
    const itsMyTurn = myIdx !== -1 && myIdx === firstPendingIdx && !ap.isDraft;

    // helpers
    const inr = n => Number(n || 0).toLocaleString('en-IN');
    const fmt = d => {
      const dt = new Date(d); if (isNaN(dt)) return '-';
      return `${String(dt.getDate()).padStart(2,'0')}-${String(dt.getMonth()+1).padStart(2,'0')}-${dt.getFullYear()}`;
    };

    // approver list (read-only)
    const approverList = ap.approvers.map(a =>
  `<li>${escapeHtml(displayName(a.name))}: ${escapeHtml(a.status)}${a.updatedAt ? ` (${fmt(a.updatedAt)})` : ''}${a.comment ? ` – "${escapeHtml(a.comment)}"` : ''}</li>`
).join('');


    // attachments list (read-only)
    const attachmentsBlock = (ap.attachments?.length)
      ? `<h5>Attachments</h5>
         <ul>${ap.attachments.map(a =>
           `<li><a href="/uploads/${a.filename}" download="${escapeHtml(a.originalName)}" target="_blank">${escapeHtml(a.originalName)}</a></li>`
         ).join('')}</ul>`
      : '';

    // Render the same card the requester gets, with an ACTION panel on top
    leftCol.innerHTML = `
      <div class="card shadow-sm p-4">
        <div class="d-flex align-items-start gap-2 p-3 mb-3 border rounded bg-light no-pdf">
          <div class="flex-grow-1">
            <label for="actionComment" class="form-label mb-1">Comment (optional)</label>
            <input id="actionComment" class="form-control" placeholder="Add a note for the requester">
            <small class="text-muted d-block mt-1">
              ${itsMyTurn ? 'You are the current approver.' : 'Waiting for the previous approver — actions are disabled.'}
            </small>
          </div>
          <div class="d-flex flex-column gap-2 ms-2">
            <button id="btnApprove" class="btn btn-success">Approve</button>
            <button id="btnReject"  class="btn btn-outline-danger">Reject</button>
          </div>
        </div>

        <h3 class="mb-3">Request Details</h3>
        <p><strong>Created on:</strong> ${fmt(ap.createdAt)}</p>
<p><strong>Created by:</strong> ${escapeHtml(displayName(ap.createdBy))}</p>
<p><strong>Unique Number:</strong> ${escapeHtml(ap.uniqueNumber)}</p>

        <p><strong>Budget:</strong> ₹ ${inr(ap.budget)}</p>
        <p><strong>Reimbursement Type:</strong> ${escapeHtml(ap.reimbursementType || '-')}</p>
        <p><strong>Purpose:</strong> ${escapeHtml(ap.purpose || '-')}</p>

        <p><strong>Details:</strong></p>
        <div class="border p-2 mb-3">${ap.details || '<em>No details</em>'}</div>

        ${attachmentsBlock}

        <h5 class="mt-3">Approvers</h5>
        <ul>${approverList}</ul>

        <a href="dash.html" class="btn btn-primary mt-3 no-pdf">Back</a>
      </div>
    `;

    // PDF button for this card
    injectPdfButton(leftCol.querySelector('.card'), ap.uniqueNumber);

    // Wire action buttons
    const btnApprove     = leftCol.querySelector('#btnApprove');
    const btnReject      = leftCol.querySelector('#btnReject');
    const inputCommentEl = leftCol.querySelector('#actionComment');

    // enable/disable by turn
    [btnApprove, btnReject, inputCommentEl].forEach(el => { if (el) el.disabled = !itsMyTurn; });

    if (itsMyTurn) {
      btnApprove.addEventListener('click', () =>
        handleApproverAction(
          ap.uniqueNumber,
          me.username,
          'Accepted',
          (inputCommentEl?.value || '').trim(),
          btnApprove,
          btnReject
        )
      );
      btnReject.addEventListener('click', () =>
        handleApproverAction(
          ap.uniqueNumber,
          me.username,
          'Rejected',
          (inputCommentEl?.value || '').trim(),
          btnApprove,
          btnReject
        )
      );
    }

    // keep chat visible on the right
    startChat(uniq, me.username);
  } catch (err) {
    toast(err.message, 'error');
    setTimeout(() => window.location.href = 'dash.html', 1500);
  } finally {
    showSpin(false);
  }
}


/* ---------------- approver PATCH (unchanged) ---------------- */
async function handleApproverAction(uniq, approverName, choice, comment, btnA, btnR) {
  try {
    showSpin(true);
    const r = await fetch(`/api/approvals/${encodeURIComponent(uniq)}/approver`,{
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ approverName, status:choice, ...(comment && { comment }) })
    });
    if(!r.ok) throw new Error('Update failed');
    toast(`Request ${choice.toLowerCase()}`,'success');
    btnA.disabled = btnR.disabled = true;
    btnA.textContent = btnR.textContent = choice;
  } catch { toast('Error updating','error'); }
  finally { showSpin(false); }
}

/* ---------------- helpers ---------------- */
// Robust replacement for collectFormData()
// replace existing collectFormData() implementation with this
function collectFormData() {
  try {
    // helper to safely read an element's value
    const safeVal = (sel, defaultVal = '') => {
      const el = document.querySelector(sel);
      if (!el) return defaultVal;
      // for select/input/textarea
      if ('value' in el) return String(el.value || '').trim();
      return el.textContent ? String(el.textContent).trim() : defaultVal;
    };

    // uniqueNumber might be absent in rare race; return empty string then submitCreate will fetch next-id
    const uniqueNumber = safeVal('#uniqueNumber', '');

    // budget: remove commas, parse to number, default 0
    const rawBudget = safeVal('#budget', '').replace(/,/g, '').trim();
    const budget = rawBudget && !isNaN(rawBudget) ? Number(rawBudget) : 0;

    // <-- HERE: read reimbursementType instead of department -->
    const reimbursementType = safeVal('#reimbursementType', '');
    const purpose    = safeVal('#purpose', '');
    const details    = (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances && CKEDITOR.instances.details)
                       ? (CKEDITOR.instances.details.getData ? CKEDITOR.instances.details.getData() : safeVal('#details',''))
                       : safeVal('#details', '');

    // Collect approvers from DOM if present, otherwise fallback to fixed chain
    const rows = Array.from(document.querySelectorAll('.approver-row'));
    let approvers = [];

    if (rows.length) {
      approvers = rows.map(r => {
        const sel = r.querySelector('select');
        const name = sel ? String(sel.value || '').trim().toLowerCase() : '';
        return { name, status: 'Pending' };
      }).filter(a => a.name); // drop empty
    }

    if (!approvers.length) {
      // fallback: use server/client-defined fixed chain
      if (typeof getFixedApprovers === 'function') {
        approvers = getFixedApprovers();
      } else {
        console.warn('[collectFormData] getFixedApprovers() missing — approvers list empty');
        approvers = [];
      }
    }

    const payload = {
      uniqueNumber,
      budget,
      reimbursementType,   // <-- send this
      purpose,
      details,
      approvers
    };

    // debug log helpful while developing
    console.debug('[collectFormData] payload ready', payload);

    return payload;
  } catch (err) {
    console.error('[collectFormData] unexpected error', err);
    // graceful fallback — minimal payload so server can still validate/offer next-id
    return {
      uniqueNumber: '',
      budget: 0,
      reimbursementType: '',
      purpose: '',
      details: '',
      approvers: []
    };
  }
}


/* ---------------- logout ---------------- */
$('#logoutBtn').addEventListener('click', async ()=>{
  await fetch('/api/logout',{method:'POST'}).catch(()=>{});
  window.location.href = 'login.html';
});

/* =========================================================
   PDF / Print helper (adds the button) – NEW
   ========================================================= */
/* =========================================================
   Full-length PDF / Print helper (replace the old version)
   ========================================================= */
function injectPdfButton(targetElement, uniqueNumber) {
  if (!targetElement || typeof html2pdf === 'undefined') return;

  // avoid adding the same button twice
  if (document.getElementById('downloadPdfBtn')) return;

  const btn = document.createElement('button');
  btn.id = 'downloadPdfBtn';
  btn.className = 'btn btn-outline-primary mb-3 no-pdf';
  btn.innerHTML = '<i data-feather="printer"></i>&nbsp;Download PDF';

  btn.onclick = async () => {
    // --- Build a printable chat transcript (simple, readable) ---
    async function buildTranscript(uniq) {
      try {
        const r = await fetch(`/api/approvals/${encodeURIComponent(uniq)}/chat`);
        if (!r.ok) throw new Error('Chat fetch failed');
        const msgs = await r.json(); // [{ author, text, createdAt }]

        const wrap = document.createElement('div');
        wrap.className = 'print-transcript';
        // minimal inline styles in case your page CSS is not loaded in the clone
        wrap.style.background = '#fff';
        wrap.style.border = '1px solid #dee3ea';
        wrap.style.borderRadius = '12px';
        wrap.style.padding = '16px';
        wrap.style.marginTop = '16px';

        const header = document.createElement('h3');
        header.textContent = 'Conversation';
        header.style.margin = '0 0 12px 0';
        header.style.fontSize = '1.1rem';
        wrap.appendChild(header);

        if (!msgs.length) {
          const none = document.createElement('div');
          none.style.color = '#6b7b93';
          none.textContent = 'No messages yet.';
          wrap.appendChild(none);
          return wrap;
        }

        msgs.forEach(m => {
          const msg = document.createElement('div');
          msg.style.marginBottom = '12px';

          const meta = document.createElement('div');
          meta.style.fontSize = '.85rem';
          meta.style.color = '#6b7b93';
          meta.style.marginBottom = '4px';
          const when = new Date(m.createdAt).toLocaleString();
          meta.textContent = `${displayName(m.author)} · ${when}`;

          const body = document.createElement('div');
          // Safe wrapping for long tokens; reuse your mention highlighter
          body.style.whiteSpace = 'pre-wrap';
          body.style.wordBreak = 'break-word';
          body.style.overflowWrap = 'anywhere';
          body.innerHTML = (typeof highlightMentions === 'function')
            ? highlightMentions(m.text || '')
            : (m.text || '');

          msg.appendChild(meta);
          msg.appendChild(body);
          wrap.appendChild(msg);
        });

        return wrap;
      } catch {
        const err = document.createElement('div');
        err.style.color = '#dc3545';
        err.style.marginTop = '16px';
        err.textContent = 'Unable to load conversation.';
        return err;
      }
    }

    // --- Build a temporary bundle: form clone + transcript stacked vertically ---
    const bundle = document.createElement('div');
    // keep things simple: center it and let it be as wide as your card
    bundle.style.background = '#fff';
    bundle.style.padding = '8px';
    bundle.style.margin = '0 auto';
    bundle.style.maxWidth = (targetElement.offsetWidth ? targetElement.offsetWidth + 'px' : '900px');
    bundle.style.boxSizing = 'border-box';

    // 1) Deep-clone the details card (your original target)
    const detailsClone = targetElement.cloneNode(true);
    detailsClone.style.width = '100%';
    bundle.appendChild(detailsClone);

    // 2) Append printable transcript
    const transcript = await buildTranscript(uniqueNumber);
    bundle.appendChild(transcript);

    // 3) Render with the same options you already had
    document.body.appendChild(bundle);

    const options = {
      margin: 10,
      filename: `${uniqueNumber}.pdf`,
      image:     { type: 'jpeg', quality: 0.98 },
      html2canvas: {
        scale: 2,             // sharper text
        scrollY: 0,           // capture full height regardless of scroll
        useCORS: true,
        ignoreElements: (el) => el.classList?.contains('no-pdf')
      },
      jsPDF:   { unit: 'pt', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] } // multi-page support
    };

    try {
      await html2pdf().set(options).from(bundle).save();
    } finally {
      bundle.remove();
    }
  };

  // insert button right before the element we’ll capture
  targetElement.parentElement.insertBefore(btn, targetElement);
  if (typeof feather !== 'undefined') feather.replace();
}




async function mountCreateFromDraft(uniq) {
  try {
    showSpin(true);
    const res = await fetch(`/api/approvals/${encodeURIComponent(uniq)}`);
    if (!res.ok) throw new Error('Draft not found');
    const ap = await res.json();
    if (!ap.isDraft) throw new Error('Not a draft anymore');

    // open the form
    mountCreate._prefill = ap; // stash so mountCreate can use it
    mountCreate();            // will call startForm() inside and use _prefill
  } catch (e) {
    toast(e.message, 'error');
    setTimeout(()=>location.href='dash.html', 1500);
  } finally {
    showSpin(false);
  }
}
