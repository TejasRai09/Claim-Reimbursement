// File: public/pendingRequests.js
// --------------------------------------------------
const spinner = document.getElementById('spinnerOverlay');
const toast   = (msg, type='info')=> Toastify({text:msg,duration:3500,close:true,style:{background:type==='error'?'#dc3545':'#0060df'}}).showToast();
const showSpin = on => spinner.style.display = on?'flex':'none';
// ---- Name-mapping helpers ----
let EMAIL_TO_NAME = {};
function escapeHtml(str=''){return str.replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s]));}

async function loadDirectoryMap() {
  try {
    const r = await fetch('/api/approvers');
    if (!r.ok) return;
    const list = await r.json(); // [{label,value}]
    EMAIL_TO_NAME = Object.fromEntries(
      list.map(p => [String(p.value || '').toLowerCase(), p.label])
    );
  } catch {}
}
const displayName = (email='') => {
  const key = String(email || '').toLowerCase();
  return EMAIL_TO_NAME[key] || (email?.split('@')[0] || email);
};
async function setWelcomeName() {
  try {
    const r = await fetch('/api/directory/me'); // { name, email, ... }
    if (!r.ok) return;
    const meDir = await r.json();
    const el = document.getElementById('welcomeTxt');
    if (el && (meDir?.name || meDir?.email)) {
      el.textContent = `Hi, ${meDir.name || displayName(meDir.email)}`;
    }
  } catch {}
}


(async function init(){
  try{
    showSpin(true);
    // who am i?
    const meRes = await fetch('/api/me');
    if(!meRes.ok) throw new Error('Unauthenticated');
    const me = await meRes.json();
    if(me.role!=='user'){
      toast('Only requesters can view this page','error');
      return window.location.href='dash.html';
    }
    await loadDirectoryMap();
    await setWelcomeName();


    // fetch my approvals
    const res = await fetch(`/api/approvals/user/${encodeURIComponent(me.username)}`);
    if(!res.ok) throw new Error('Fetch error');
    const approvals = await res.json();

    const pending = approvals.filter(ap=> ap.approvers.some(a=> a.status==='Pending'));

    const tbody = document.querySelector('#pendingTbl tbody');
    if(pending.length===0){ document.getElementById('emptyMsg').classList.remove('d-none'); }
    pending.forEach(ap=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
  <td><a href="index.html?uniqueNumber=${encodeURIComponent(ap.uniqueNumber)}">${ap.uniqueNumber}</a></td>
  <td>₹ ${Number(ap.budget||0).toLocaleString('en-IN')}</td>
  <td>${escapeHtml(ap.purpose || '')}</td>
  <td>${
    ap.approvers.map(a =>
      `${escapeHtml(displayName(a.name))} (${escapeHtml(a.status)}${a.comment ? ': ' + escapeHtml(a.comment) : ''})`
    ).join('<br>')
  }</td>
  <td>${new Date(ap.createdAt).toLocaleString()}</td>
`;

      tbody.appendChild(tr);
    });
  }catch(err){
    toast(err.message,'error');
    setTimeout(()=>window.location.href='login.html',1500);
  }finally{ showSpin(false); }
})();

// logout
document.getElementById('logoutBtn').addEventListener('click',async()=>{
  await fetch('/api/logout',{method:'POST'});
  window.location.href='login.html';
});
