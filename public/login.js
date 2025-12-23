// login.js
(function () {
  // Toast wrapper with graceful fallback
  function notify(msg, type = 'info') {
    if (typeof Toastify !== 'undefined') {
      Toastify({
        text: msg,
        duration: 3500,
        close: true,
        style: { background: type === 'error' ? '#dc3545' : '#0060df' }
      }).showToast();
    } else {
      alert(msg);
    }
  }
  // ---------- Adventz mail check ----------
// const emailRegex = /^[A-Za-z0-9._%+-]+@adventz\.com$/i;


  // If session is valid, redirect to dashboard
  fetch('/api/me').then(r => { if (r.ok) window.location.href = 'dash.html'; });

  // Login submit handler for animated form
  document.getElementById('form-login').addEventListener('submit', async e => {
    e.preventDefault();
    const identifier = document.getElementById('identifier-login').value.trim().toLowerCase();
    const password = document.getElementById('password-login').value;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password })
      });

      if (!res.ok) {
        notify('Invalid credentials', 'error');
        console.error('Login failed', await res.text());
        return;
      }

      // Success → dashboard
      window.location.href = 'dash.html';
    } catch (err) {
      console.error('Network/login error', err);
      notify('Network error', 'error');
    }
  });
  // ——— SIGN‑UP WITH OTP ——————————————————————————
document.getElementById('form-signup').addEventListener('submit', async e => {
  e.preventDefault();
  const email    = document.getElementById('email').value.trim().toLowerCase();
  const pass     = document.getElementById('password-signup').value;
  const confirm  = document.getElementById('password-confirm').value;
  const otpBlock = document.getElementById('otpBlock');
  const otpInput = document.getElementById('otp');

  // Phase 1 – request OTP
  if (otpBlock.classList.contains('d-none')) {
    // if (!emailRegex.test(email)) return notify('Use your @adventz.com mail', 'error');
    if (pass !== confirm)        return notify('Passwords do not match', 'error');

    const r = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass, confirm })
    });
    if (!r.ok) return notify(await r.text(), 'error');

    notify('OTP sent to your email', 'success');
    otpBlock.classList.remove('d-none');
    document.getElementById('signUp').textContent = 'Verify OTP';   // 🟢 UX cue
    return;
  }

  // Phase 2 – verify OTP
  const otp = otpInput.value.trim();
  if (!/^\d{6}$/.test(otp)) return notify('Enter 6‑digit OTP', 'error');

  const vr = await fetch('/api/signup/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, otp })
  });
  if (!vr.ok) return notify(await vr.text(), 'error');

  notify('Account created — log in now', 'success');
  document.getElementById('goLeft').click();   // switches to login pane
});

})();
