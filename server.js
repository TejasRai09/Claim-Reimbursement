// File: server.js
require('dotenv').config();
const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const mongoose     = require('mongoose');
const cookieParser = require('cookie-parser');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const nodemailer   = require('nodemailer');
const crypto       = require('crypto');
const bcrypt       = require('bcrypt');

/* ─────────────────────────────────────────
   Basic setup
   ───────────────────────────────────────── */
const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MONGO_URI  = process.env.MONGO_URI  || 'mongodb://localhost:27017/approvaldb';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const { sendApprovalEmail } = require('./emailHelper');
// FIXED APPROVAL CHAIN for all approvals
const HR_EMAIL = "hr@adventz.zuarimoney.com";
const ACCOUNTS_EMAIL = "accounts.team@adventz.com";

/* ───────────────  OTP mailer (Outlook SMTP) ─────────────── */
const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.OUTLOOK_USER || 'YOUR_OUTLOOK_ADDRESS',
    pass: process.env.OUTLOOK_PASS || 'YOUR_OUTLOOK_PASSWORD'
  }
});

// from here only i recieve the mails
const NOTIFY_OVERRIDE_EMAIL = process.env.NOTIFY_OVERRIDE_EMAIL || '';
function buildFixedApprovalChain(managerEmail) {
  return [
    { name: managerEmail.toLowerCase(), status: "Pending", comment: "", updatedAt: null },
    { name: HR_EMAIL.toLowerCase(),     status: "Pending", comment: "", updatedAt: null },
    { name: ACCOUNTS_EMAIL.toLowerCase(), status: "Pending", comment: "", updatedAt: null }
  ];
}
async function sendMailSafe({ to, subject, text, html, attachments }) {
  const finalTo = NOTIFY_OVERRIDE_EMAIL || to;
  const finalSubject = NOTIFY_OVERRIDE_EMAIL
    ? `[OVERRIDDEN to ${finalTo}] ${subject} (orig: ${to})`
    : subject;

  return transporter.sendMail({
    from: `"Approval Bot" <${process.env.OUTLOOK_USER}>`,
    to: finalTo,
    subject: finalSubject,
    text,
    html,
    ...(attachments ? { attachments } : {})
  });
}

function escapeHtml(s=''){ return s.replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

const pendingOTP = new Map();  // email → { otp, hash, expires }

/* ensure uploads dir exists */
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

/* multer storage – keep extension */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext    = path.extname(file.originalname);         // e.g. ".pdf"
    cb(null, unique + ext);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ← for comment form
app.use(cookieParser());

// Serve uploaded files
app.use('/uploads', express.static(UPLOAD_DIR));

/* ─────────────────────────────────────────
   Auth helpers
   ───────────────────────────────────────── */
const sign        = p => jwt.sign(p, JWT_SECRET, { expiresIn:'8h' });
const verifyToken = t => new Promise((res,rej)=>
  jwt.verify(t, JWT_SECRET, (e,d)=> e ? rej(e) : res(d)));

function isPageNavigation(req) {
  const mode   = req.headers['sec-fetch-mode'];
  const dest   = req.headers['sec-fetch-dest'];
  const accept = req.headers.accept || '';

  // Only treat as a real browser navigation to an HTML document
  return req.method === 'GET' && (
    dest === 'document' ||
    mode === 'navigate' ||
    (accept.includes('text/html') && (req.path === '/' || req.path.endsWith('.html')))
  );
}

function requireAuth() {
  return async (req, res, next) => {
    try {
      const token = req.cookies.token;
      if (!token) throw new Error('Missing token');
      const user = await verifyToken(token);
      req.user = user;
      next();
    } catch (e) {
      res.clearCookie('token');
      // Redirect ONLY for real HTML page navigations; return JSON for fetch/XHR
      if (isPageNavigation(req)) {
        return res.redirect('/login.html');
      }
      return res.status(401).json({ message: 'Unauthenticated' });
    }
  };
}

// helper (role gate) — accept one or many roles:
// Usage: requireRole('master')  OR  requireRole('master','hr')
function requireRole(...allowedRoles){
  return (req, res, next) => {
    const role = String(req.user?.role || '').toLowerCase();
    // normalize allowed roles to lowercase
    const allowed = allowedRoles.map(r => String(r || '').toLowerCase());
    if (allowed.includes(role)) return next();
    return res.status(403).json({ message: 'Forbidden' });
  };
}

/* ─────────────────────────────────────────
   Protected HTML pages (must be before static)
   ───────────────────────────────────────── */
app.get('/dash.html', requireAuth(), (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dash.html'))
);
app.get('/index.html', requireAuth(), (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);
// Only HR role (server-side enforcement)
app.get('/masterDashboard.html', requireAuth(), requireRole('hr'), (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'masterDashboard.html'))
);


/* ─────────────────────────────────────────
   Static assets (after protected HTML routes)
   ───────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public')));

/* Optional explicit login route (static could serve it too) */
app.get('/login.html', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
);

/* ─────────────────────────────────────────
   SIGN-UP WITH OTP
   ───────────────────────────────────────── */
const OTP_TTL_MS = 5 * 60 * 1000; // 5 min

app.post('/api/signup', async (req, res) => {
  const { email, password, confirm } = req.body;
  // if (!email?.endsWith('@adventz.com')) return res.status(400).json({ message:'Invalid company email' });
  if (password !== confirm)           return res.status(400).json({ message:'Passwords do not match' });
  if (await User.findOne({ email }))  return res.status(400).json({ message:'User exists' });

  // generate & store OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const hash = await bcrypt.hash(password, 10);
  const emailLc = (email || '').toLowerCase();
  pendingOTP.set(emailLc, { otp, hash, expires: Date.now() + OTP_TTL_MS });

  // send
  await sendMailSafe({
    to: email,
    subject: 'Your Adventz OTP',
    text: `Your OTP is ${otp}. It expires in 5 minutes.`
  });
  res.json({ message:'OTP sent' });
});

app.post('/api/signup/verify', async (req, res) => {
  const { email, otp } = req.body;
  const emailLc = (email || '').toLowerCase();
  const entry = pendingOTP.get(emailLc);
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ message:'OTP expired' });
  if (entry.otp !== otp)                    return res.status(400).json({ message:'Incorrect OTP' });

  const inDir = await Directory.findOne({ email: emailLc });
  await new User({ email: emailLc, password: entry.hash, role: inDir ? 'approver' : 'user' }).save();
  pendingOTP.delete(emailLc);
  res.json({ message:'User created' });
});

// Approver list for the form (everyone from directory)
app.get('/api/approvers', requireAuth(), async (_req, res) => {
  const list = await Directory.find({}, { _id: 0, name: 1, email: 1 }).sort({ name: 1 }).lean();
  res.json(list.map(p => ({ label: p.name, value: p.email })));
});

// Current user's directory profile with fallback name
// Current user's directory profile with fallback name
app.get('/api/directory/me', requireAuth(), async (req, res) => {
  try {
    const email = String(req.user.username || '').toLowerCase();
    const me = await Directory.findOne({ email }).lean();

    const fallbackName = email
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    if (!me) {
      // At least return something usable
      return res.json({
        name: fallbackName,
        email,
      });
    }

    // Return full profile from directory
    return res.json({
      empCode:      me.empCode || '',
      name:         me.name || fallbackName,
      email:        me.email || email,
      designation:  me.designation || '',
      department:   me.department || '',
      managerName:  me.managerName || '',
      managerEmail: me.managerEmail || '',
      company:      me.company || '',
      phone:        me.phone || ''
    });
  } catch (e) {
    console.error('directory lookup failed', e);
    res.status(500).json({ message: 'directory lookup failed' });
  }
});


/* ===== PDF + mail helpers ===== */
const puppeteer = require('puppeteer');
const BASE_URL  = process.env.BASE_URL || `http://localhost:${PORT}`;

// Render a clean HTML (no external assets) for the PDF
function renderApprovalHtml(ap) {
  const inr = n => Number(n || 0).toLocaleString('en-IN');
  const fmt = d => {
    const dt = new Date(d); if (isNaN(dt)) return '-';
    return `${String(dt.getDate()).padStart(2,'0')}-${String(dt.getMonth()+1).padStart(2,'0')}-${dt.getFullYear()}`;
  };
  const approverRows = (ap.approvers||[]).map(a => `
    <tr>
      <td>${a.name}</td>
      <td>${a.status}</td>
      <td>${a.comment ? a.comment : ''}</td>
      <td>${a.updatedAt ? fmt(a.updatedAt) : '-'}</td>
    </tr>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8">
  <title>Claim ${ap.uniqueNumber}</title>
  <style>
    body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#222; }
    .card{ border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin:8px 0; }
    h1{ font-size:20px; margin:0 0 8px; color:#1f2937; }
    h2{ font-size:16px; margin:16px 0 8px; color:#374151; }
    table{ width:100%; border-collapse:collapse; }
    th,td{ border:1px solid #e5e7eb; padding:8px; font-size:12px; text-align:left; vertical-align:top; }
    .muted{ color:#6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Claim ${ap.uniqueNumber}</h1>
    <div class="muted">Created: ${fmt(ap.createdAt)} · Requester: ${ap.createdBy}</div>
  </div>
  <div class="card">
    <h2>Summary</h2>
    <table>
      <tr><th>Unique #</th><td>${ap.uniqueNumber}</td></tr>
      <tr><th>Budget</th><td>₹ ${inr(ap.budget)}</td></tr>
      <tr><th>Reimbursement Type</th><td>${escapeHtml(ap.reimbursementType || '-')}</td></tr>
      <tr><th>Purpose</th><td>${ap.purpose || '-'}</td></tr>
    </table>
  </div>
  <div class="card">
    <h2>Details</h2>
    <div>${ap.details || '<em class="muted">No details</em>'}</div>
  </div>
  <div class="card">
    <h2>Approvers</h2>
    <table>
      <thead><tr><th>Email</th><th>Status</th><th>Comment</th><th>Updated</th></tr></thead>
      <tbody>${approverRows}</tbody>
    </table>
  </div>
</body></html>`;
}

async function generateApprovalPdf(ap) {
  const html = renderApprovalHtml(ap);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();
  return pdfBuffer;
}

/* ───────── One-click mail token helpers ───────── */
function makeOneClickToken({ uniqueNumber, approver, action }) {
  const jti = crypto.randomBytes(12).toString('hex');
  return jwt.sign(
    { kind: 'mail-oneclick', jti, uniqueNumber, approver: String(approver||'').toLowerCase(), action },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}
function verifyAnyMailToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/* Build a consistent email (returns { subject, html, attachments }) */
async function buildMailForApproval({ ap, to, title, introHtml, extraHtml, includeActionButtons }) {
  const inr  = n => Number(n || 0).toLocaleString('en-IN');
  const link = `${BASE_URL}/index.html?uniqueNumber=${encodeURIComponent(ap.uniqueNumber)}`;

  // Optional one-click buttons for the approver whose turn it is
  let actionsBlock = '';
  const toLc = String(to || '').toLowerCase();
  const isApprover = ap.approvers?.some(a => String(a.name||'').toLowerCase() === toLc);
  const isTurn = isApprover && isMyTurn(ap, toLc);

  if (includeActionButtons && isTurn) {
    const tokApprove = makeOneClickToken({ uniqueNumber: ap.uniqueNumber, approver: toLc, action: 'Accepted' });
    const tokReject  = makeOneClickToken({ uniqueNumber: ap.uniqueNumber, approver: toLc, action: 'Rejected' });
    const urlApprove = `${BASE_URL}/mail-oneclick/${tokApprove}`;
    const urlReject  = `${BASE_URL}/mail-oneclick/${tokReject}`;
    const urlComment = `${BASE_URL}/mail-action/${tokApprove}`; // optional comment page

    actionsBlock = `
      <div style="margin:16px 0 8px;">
        <a href="${urlApprove}" style="display:inline-block; padding:10px 14px; background:#16a34a; color:#fff; border-radius:8px; text-decoration:none; font-weight:600; margin-right:8px;">Approve</a>
        <a href="${urlReject}"  style="display:inline-block; padding:10px 14px; background:#dc2626; color:#fff; border-radius:8px; text-decoration:none; font-weight:600;">Reject</a>
      </div>
      <div style="margin-top:6px;">
        <a href="${urlComment}" style="font-size:12px; color:#2563eb; text-decoration:none;">Add a comment (optional)</a>
      </div>
      <p style="font-size:12px; color:#6b7280; margin:6px 0 0;">Approve/Reject is one-click. Comments open a small page.</p>`;
  }

  // --- replace existing `const html = `...` with the block below ---
  const html = `
  <div style="font-family:Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#0f172a; line-height:1.45; max-width:700px; margin:0 auto; padding:18px;">
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
      <div style="width:48px; height:48px; border-radius:8px; background:#2563eb; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:700;">CE</div>
      <div>
        <div style="font-size:16px; font-weight:700; color:#0b3a8c;">${title}</div>
        <div style="font-size:12px; color:#64748b; margin-top:4px;">A PDF copy of this Claim is attached.</div>
      </div>
    </div>

    <div style="background:#fff; border:1px solid #e6edf8; border-radius:10px; padding:12px; margin-bottom:14px;">
      <p style="margin:0 0 8px; color:#0b2946;">${introHtml}</p>

      <table style="width:100%; border-collapse:collapse; margin-top:10px; font-size:14px;">
        <tr>
          <td style="padding:8px 10px; border:1px solid #eef6ff; width:28%; font-weight:600; background:#fbfdff;">Unique #</td>
          <td style="padding:8px 10px; border:1px solid #eef6ff;">${escapeHtml(ap.uniqueNumber)}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px; border:1px solid #eef6ff; font-weight:600; background:#fbfdff;">Budget</td>
          <td style="padding:8px 10px; border:1px solid #eef6ff;">₹ ${Number(ap.budget||0).toLocaleString('en-IN')}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px; border:1px solid #eef6ff; font-weight:600; background:#fbfdff;">Reimbursement Type</td>
          <td style="padding:8px 10px; border:1px solid #eef6ff;">${escapeHtml(ap.reimbursementType || '-')}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px; border:1px solid #eef6ff; font-weight:600; background:#fbfdff;">Purpose</td>
          <td style="padding:8px 10px; border:1px solid #eef6ff;">${escapeHtml(ap.purpose || '-')}</td>
        </tr>
      </table>
    </div>

    ${actionsBlock ? `
      <div style="margin:8px 0 12px;">
        ${actionsBlock}
      </div>` : ''}

    <div style="margin-top:12px; display:flex; gap:10px; align-items:center;">
      <a href="${link}" style="display:inline-block; padding:10px 14px; background:#2563eb; color:#fff; text-decoration:none; border-radius:8px; font-weight:600;">Open in browser</a>
      <span style="color:#64748b; font-size:13px;">Or review the attached PDF: <strong>${escapeHtml(ap.uniqueNumber)}.pdf</strong></span>
    </div>

    <hr style="border:none; border-top:1px solid #eef2f7; margin:16px 0;">

    <div style="font-size:13px; color:#475569;">
      <p style="margin:6px 0;">If you have questions about this request, reply to this message or open the Claim in the browser.</p>
      <p style="margin:8px 0 0;">Warm regards,<br/><strong>ZFL ClaimEase</strong><br/></p>
    </div>

    <div style="font-size:11px; color:#94a3b8; margin-top:12px;">
      <p style="margin:6px 0;">This is an automated message. Please do not reply if this inbox is not monitored for replies.</p>
    </div>
  </div>
  `;

  const pdf = await generateApprovalPdf(ap);
  return {
    subject: title,
    html,
    attachments: [{ filename: `${ap.uniqueNumber}.pdf`, content: pdf }]
  };
}

// Thin wrapper to send approval mail
async function mailApproval({ to, ap, title, introHtml, extraHtml, includeActionButtons = false }) {
  const { subject, html, attachments } = await buildMailForApproval({
    ap, to, title, introHtml, extraHtml, includeActionButtons
  });
  await sendMailSafe({ to, subject, html, text: `${title}\n\n${ap.uniqueNumber}`, attachments });
}

/* ─────────────────────────────────────────
   MongoDB
   ───────────────────────────────────────── */
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB ✓'))
  .catch(err => { console.error('MongoDB ✗', err); process.exit(1); });

const userSchema = new mongoose.Schema({
  email:     { type: String, unique: true },
  password:  String,          // hashed
  role:      { type: String, default: 'user' }
});
const User = mongoose.model('User', userSchema);

const approvalSchema = new mongoose.Schema({
  uniqueNumber: { type: String, required: true, unique: true },
  isDraft:      { type: Boolean, default: false },
  budget:       { type: Number, required: true },
  purpose: { type: String, required: false, default: '' },
  reimbursementType:   { type: String, required: true },
  details:      { type: String },
  approvers: [{
    name:      { type: String, required: true },
    status:    { type: String, enum:['Pending','Accepted','Rejected'], default:'Pending' },
    comment:   { type: String },
    updatedAt: { type: Date }
  }],
  attachments: [{
    originalName: String,
    filename:     String,
    mimeType:     String,
    size:         Number
  }],
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: String, required: true }
});
const Approval = mongoose.model('Approval', approvalSchema);

// ---------------------- helper: resolve approver identity ----------------------
// Ensure approver identity is stored as email (lowercased). If the client passed a
// display name (no @) try to resolve to an email using the Directory collection.
// If no mapping found, keep the original value lowercased.
async function resolveApproverToEmail(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.includes('@')) return s.toLowerCase();
  // try to match by display name (case-insensitive). Directory stores `name`.
  const found = await Directory.findOne({ name: new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }, { email: 1 }).lean();
  return found && found.email ? String(found.email).toLowerCase() : s.toLowerCase();
}

// tolerant identity normalization
function normalizeSimple(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')       // remove spaces
    .replace(/[._-]/g, '');   // remove dots/underscores/hyphens
}

// isMyTurn accepts approvers array or full approval doc and a username (email lowercased)
function isMyTurn(ap, username) {
  const me = String(username || '').toLowerCase();
  const meSimple = normalizeSimple(me.split('@')[0] || me);

  const firstPending = (ap.approvers || []).findIndex(a => a.status === 'Pending');
  // find index of me using several normalized comparisons
  const myIdx = (ap.approvers || []).findIndex(a => {
    const n = String(a.name || '').toLowerCase();
    if (!n) return false;
    if (n === me) return true;                        // exact email match
    if (n.includes('@') && me.includes('@') && n === me) return true;
    if (n === me.split('@')[0]) return true;          // sometimes stored without domain
    if (normalizeSimple(n) === meSimple) return true; // simple normalized comparison
    return false;
  });

  return firstPending !== -1 && myIdx === firstPending;
}


// ───────── Chat message model ─────────
const chatMessageSchema = new mongoose.Schema({
  approvalId: { type: String, index: true },     // uniqueNumber
  author:     { type: String, required: true },  // req.user.username (for now)
  text:       { type: String, required: true },
  mentions:   [String],                          // parsed from @mentions
  createdAt:  { type: Date, default: Date.now }
});
chatMessageSchema.index({ approvalId: 1, mentions: 1, createdAt: -1 });
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

// ───────── Used mail tokens (prevent double click; TTL) ─────────
const usedTokenSchema = new mongoose.Schema({
  jti:       { type: String, unique: true, index: true },
  usedAt:    { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30*24*60*60*1000), expires: '30d' },
  meta:      { type: Object }
});
const UsedMailToken = mongoose.model('UsedMailToken', usedTokenSchema);

const directorySchema = new mongoose.Schema({
  empCode:      String,                                      // Employee Number
  name:         String,                                      // Employee Name
  email:        { type: String, unique: true, index: true }, // Email
  designation:  String,                                      // Curr.Designation
  department:   String,                                      // Curr.Department
  managerName:  String,                                      // Manager Name (display)
  managerEmail: String,                                      // derived from manager row
  company:      String,                                      // Curr.Company
  phone:        String                                       // Phone
});
const Directory = mongoose.model('Directory', directorySchema);

/* ─────────────────────────────────────────
   Front-end entry
   ───────────────────────────────────────── */
app.get('/', async (req, res) => {
  const token = req.cookies.token;
  if (token) {
    try {
      await verifyToken(token);
      return res.redirect('/dash.html');
    } catch {
      res.clearCookie('token');
    }
  }
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* ─────────────────────────────────────────
   Auth routes
   ───────────────────────────────────────── */
app.post('/api/login', async (req, res) => {
  const identifierRaw = (req.body.identifier || req.body.email || '').trim();
  const { password } = req.body;
  if (!identifierRaw.includes('@')) return res.status(401).json({ message: 'Invalid credentials' });

  const email = identifierRaw.toLowerCase();
  const user  = await User.findOne({ email });
  if (!user) return res.status(401).json({ message: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

  res.cookie('token', sign({ username: email, role: user.role }), { httpOnly: true, sameSite: 'lax' });
  res.json({ role: user.role });
});

app.post('/api/logout', (_req,res)=>{ res.clearCookie('token'); res.json({ message:'Logged out' }); });
app.get('/api/me', requireAuth(), (req,res)=> res.json(req.user));

/* ─────────────────────────────────────────
   Approval CRUD
   ───────────────────────────────────────── */

// ---------- Next auto Unique Number: ZILYYYYNN ----------
app.get('/api/approvals/next-id', requireAuth(), async (req, res) => {
  const year   = new Date().getFullYear();
  const prefix = `ZFL${year}`;
  const last = await Approval.findOne({
    uniqueNumber: new RegExp(`^${prefix}\\d{2}$`)
  }).sort({ uniqueNumber: -1 }).lean();

  let seq = 1;
  if (last) {
    seq = parseInt(last.uniqueNumber.slice(prefix.length), 10) + 1;
  }
  const id = `${prefix}${String(seq).padStart(2, '0')}`;
  res.json({ id });
});

// ───────── Chat APIs ─────────
app.get('/api/approvals/:uniqueNumber/chat', requireAuth(), async (req, res) => {
  const msgs = await ChatMessage
    .find({ approvalId: req.params.uniqueNumber })
    .sort({ createdAt: 1 })
    .limit(500);
  res.json(msgs);
});

app.post('/api/approvals/:uniqueNumber/chat', requireAuth(), async (req, res) => {
  try {
    const { text = '' } = req.body;
    const cleaned = String(text || '').trim();
    if (!cleaned) return res.status(400).json({ message: 'Empty message' });

    const rawTokens = Array.from(cleaned.matchAll(/@(\S+)/g)).map(m => m[1]);
    const mentions = [...new Set(
      rawTokens.map(t => t.replace(/[),.;:!?]+$/, '')).map(t => t.toLowerCase()).filter(Boolean)
    )];

    const msg = await ChatMessage.create({
      approvalId: req.params.uniqueNumber,
      author: req.user.username,
      text: cleaned,
      mentions
    });

    // ---- Notify mentioned users (excluding the author) ----
    if (mentions.length) {
      const ap = await Approval.findOne({ uniqueNumber: req.params.uniqueNumber }).lean();
      if (ap) {
        const recipients = mentions.filter(m => m && m !== req.user.username);
        for (const to of recipients) {
          await mailApproval({
            to,
            ap,
            title: `You were mentioned on Claim ${ap.uniqueNumber}`,
            introHtml: `<strong>${req.user.username}</strong> mentioned you in the request chat:<br><blockquote style="border-left:3px solid #e5e7eb; margin:8px 0; padding:6px 10px;">${escapeHtml(cleaned)}</blockquote>`
          });
        }
      }
    }

    res.status(201).json(msg);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Chat post error' });
  }
});

/* ─────────────── DRAFT APIs ─────────────── */

// Create or update a draft
app.post('/api/drafts', requireAuth(), async (req, res) => {
  try {
    const {
      uniqueNumber, budget, purpose, details, department, approvers
    } = req.body;

    // map and resolve approvers for drafts
    const draftApprovers = [];
    for (const a of (approvers || [])) {
      const emailOrName = await resolveApproverToEmail(a.name || '');
      draftApprovers.push({
        name: String(emailOrName).toLowerCase(),
        status: a.status || 'Pending',
        comment: a.comment || '',
        updatedAt: new Date()
      });
    }

    const doc = await Approval.findOneAndUpdate(
      { uniqueNumber },
      {
        $set: {
          uniqueNumber,
          isDraft: true,
          budget, purpose, details, department,
          approvers: draftApprovers,
          createdBy: String(req.user.username || '').toLowerCase()
        }
      },
      { upsert: true, new: true, runValidators: false }
    );

    res.json({ message: 'Draft saved', uniqueNumber: doc.uniqueNumber });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// Upload attachments for a draft
app.post('/api/drafts/:uniqueNumber/attachments',
  requireAuth(),
  upload.array('files', 10),
  async (req, res) => {
    try {
      const ap = await Approval.findOne({ uniqueNumber: req.params.uniqueNumber, isDraft: true });
      if (!ap) return res.status(404).json({ message: 'Draft not found' });
      if (ap.createdBy !== req.user.username)
        return res.status(403).json({ message: 'Forbidden' });

      ap.attachments.push(...req.files.map(f => ({
        originalName: f.originalname,
        filename:     f.filename,
        mimeType:     f.mimetype,
        size:         f.size
      })));

      await ap.save();
      res.json({ message: 'Draft attachments uploaded' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Upload error' });
    }
  }
);

// List drafts of current requester
app.get('/api/drafts/user/:username', requireAuth(),
  async (req, res) => {
    if (req.user.role === 'user' && req.user.username !== req.params.username)
      return res.status(403).json({ message: 'Forbidden' });

    const drafts = await Approval
      .find({ createdBy: req.params.username, isDraft: true })
      .sort({ createdAt: -1 });
    res.json(drafts);
  }
);

// Approvals where I'm @mentioned (but I'm NOT the requester and NOT an approver)
app.get('/api/approvals/expert', requireAuth(), async (req, res) => {
  const me = (req.user.username || '').toLowerCase();

  // Find approvalIds where I was mentioned
  const hits = await ChatMessage.aggregate([
    { $match: { mentions: me } },
    { $group: { _id: '$approvalId', lastAt: { $max: '$createdAt' } } },
    { $sort: { lastAt: -1 } },
    { $limit: 300 }
  ]);

  const ids = hits.map(h => h._id);

  // Fetch those approvals, excluding ones where I'm requester or approver
  const approvals = await Approval.find({
    uniqueNumber: { $in: ids },
    createdBy: { $ne: me },
    'approvers.name': { $ne: me }
  }).sort({ createdAt: -1 }).lean();

  res.json(approvals);
});

// Submit a draft -> becomes a normal approval
app.patch('/api/drafts/:uniqueNumber/submit', requireAuth(), async (req, res) => {
  const ap = await Approval.findOne({ uniqueNumber: req.params.uniqueNumber, isDraft: true });
  if (!ap) return res.status(404).json({ message: 'Draft not found' });
  if (req.user.role === 'user' && ap.createdBy !== req.user.username)
    return res.status(403).json({ message: 'Forbidden' });

  ap.isDraft = false;
  await ap.save();

  // Notify first approver
  // FIXED CHAIN ENFORCEMENT
let managerEmail = "";
if (ap.approvers && ap.approvers.length > 0) {
  managerEmail = await resolveApproverToEmail(ap.approvers[0].name);
}

if (!managerEmail) {
  return res.status(400).json({ message: "Draft missing manager email" });
}

// Replace existing approvers with fixed chain
ap.approvers = buildFixedApprovalChain(managerEmail);
await ap.save();

const first = ap.approvers[0].name;
await mailApproval({
  to: first,
  ap,
  title: `Claim ${ap.uniqueNumber} needs your approval`,
  introHtml: `A draft Claim was submitted by <strong>${ap.createdBy}</strong> and is awaiting your action.`,
  includeActionButtons: true
});

  res.json({ message: 'Draft submitted' });
});

// Create a new approval (non-draft)
// --- inside server.js ---
app.post('/api/approvals', requireAuth(), async (req, res) => {
  try {
    // 1) debug log: what arrives (remove when fixed)
    console.log('[DEBUG] POST /api/approvals body =', JSON.stringify(req.body));

    // 2) destructure expected fields (use reimbursementType)
    const {
      uniqueNumber = '',
      budget = 0,
      reimbursementType, // <- we expect this from frontend
      purpose = '',
      details = '',
      approvers = []
    } = req.body || {};

    // 3) simple server-side validation with helpful messages
    if (!reimbursementType || !String(reimbursementType).trim()) {
      return res.status(400).json({ message: 'reimbursementType is required' });
    }
    if (!Array.isArray(approvers) || !approvers.length) {
      return res.status(400).json({ message: 'approvers list is required' });
    }

    // ... your existing logic to resolve approvers, set createdBy, etc.
    // For example:
    const createdBy = String(req.user.username || '').toLowerCase();

    const newAp = new Approval({
      uniqueNumber,
      budget,
      reimbursementType,
      purpose,
      details,
      approvers,        // or resolvedApprovers if you resolve emails -> names
      createdBy,
      createdAt: new Date()
    });

    const saved = await newAp.save();
    // --- notify first approver (after save) ---
try {
  // determine first approver email (resolve display name to email if needed)
  let firstApprover = (saved.approvers && saved.approvers[0] && saved.approvers[0].name) ? String(saved.approvers[0].name).toLowerCase() : null;
  if (firstApprover) {
    // if the client sent a display-name (no @), try to resolve to an email
    if (!firstApprover.includes('@')) {
      firstApprover = await resolveApproverToEmail(firstApprover);
    }

    // send the mail (one-click buttons are useful when it's their turn)
    await mailApproval({
      to: firstApprover,
      ap: saved,
      title: `Claim ${saved.uniqueNumber} needs your approval`,
      introHtml: `A Claim was submitted by <strong>${saved.createdBy}</strong> and is awaiting your action.`,
      includeActionButtons: true
    });

    console.info(`[MAIL] Notified first approver: ${firstApprover} for ${saved.uniqueNumber}`);
  } else {
    console.warn(`[MAIL] No first approver found to notify for ${saved.uniqueNumber}`);
  }
} catch (mailErr) {
  // log but do not fail the request creation
  console.error('[MAIL ERROR] failed to send notification for approval', saved.uniqueNumber, mailErr && mailErr.message ? mailErr.message : mailErr);
}

    return res.json({ ok: true, approval: saved });
  } catch (err) {
    // Better error handling: show validation messages when available
    console.warn('[ERROR] create approval failed:', err && err.message);
    if (err && err.name === 'ValidationError') {
      // collect per-field messages
      const details = Object.entries(err.errors || {}).reduce((acc, [k, v]) => {
        acc[k] = v.message || String(v);
        return acc;
      }, {});
      return res.status(400).json({ message: 'Validation failed', details });
    }
    // fallback
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});


/* master data (master only) */
app.get('/api/approvals', requireAuth(), requireRole('master','hr'),
  async (_q,res)=> res.json(await Approval.find().sort({ createdAt:-1 })));

app.get('/api/approvals/user/:username', requireAuth(),
  async (req,res)=>{
    if (req.user.role==='user' && req.user.username !== req.params.username)
      return res.status(403).json({ message:'Forbidden' });
    const u = String(req.params.username || '').toLowerCase();
    res.json(await Approval.find({ createdBy: u }).sort({ createdAt:-1 }));
  });

app.get('/api/approvals/:uniqueNumber', requireAuth(),
  async (req,res)=>{
    const ap = await Approval.findOne({ uniqueNumber:req.params.uniqueNumber });
    if (!ap) return res.status(404).json({ message:'Not found' });

    const me = (req.user.username || '').toLowerCase();
    const isCreator  = ap.createdBy.toLowerCase() === me;
    const isApprover = ap.approvers.some(a => (a.name || '').toLowerCase() === me);

    if (isCreator || isApprover) {
      return res.json(ap); // allowed
    }

    // Expert if @mentioned, but not the requester and not an approver
    const expertHit = await ChatMessage.exists({
      approvalId: req.params.uniqueNumber,
      mentions: me
    });

    if (expertHit) {
      return res.json(ap); // allowed read-only
    }

    // fallback: block basic users
    if (req.user.role === 'user') {
      return res.status(403).json({ message:'Forbidden' });
    }

    // non-user roles (e.g., master/hr) can still see
    return res.json(ap);
  });

app.get('/api/approvals/for-approver-all/:username', requireAuth(), async (req, res) => {
  const u = (req.params.username || '').toLowerCase();
  const list = await Approval.find({ 'approvers.name': u }).sort({ createdAt: -1 });
  res.json(list);
});

app.post('/api/approvals/:uniqueNumber/attachments',
  requireAuth(),
  upload.array('files',10),
  async (req,res)=>{
    try {
      const ap = await Approval.findOne({ uniqueNumber:req.params.uniqueNumber });
      if (!ap) return res.status(404).json({ message:'Not found' });
      if (req.user.role==='user' && ap.createdBy!==req.user.username)
        return res.status(403).json({ message:'Forbidden' });

      ap.attachments.push(...req.files.map(f=>({
        originalName: f.originalname,
        filename:     f.filename,
        mimeType:     f.mimetype,
        size:         f.size
      })));
      await ap.save();
      res.json({ message:'Attachments uploaded' });
    } catch(e){ console.error(e); res.status(500).json({ message:'Upload error' }); }
});

/* ─────────────────────────────────────────
   Approver action (in-app)
   ───────────────────────────────────────── */
app.patch('/api/approvals/:uniqueNumber/approver', requireAuth(), async (req, res) => {
  const { approverName, status, comment } = req.body;
  const me = String(req.user.username || '').toLowerCase();
  const approverNameLc = String(approverName || '').toLowerCase();
  if (!['Accepted', 'Rejected'].includes(status))
    return res.status(400).json({ message: 'Invalid status' });

  const ap = await Approval.findOne({ uniqueNumber: req.params.uniqueNumber });
  if (!ap) return res.status(404).json({ message: 'Not found' });

  const idx = ap.approvers.findIndex(a => String(a.name || '').toLowerCase() === approverNameLc);
  if (idx === -1 || approverNameLc !== me)
    return res.status(403).json({ message: 'Not your approval to act on' });

  if (!isMyTurn(ap, me))
    return res.status(400).json({ message: 'Not your turn' });

  ap.approvers[idx].status    = status;
  ap.approvers[idx].comment   = comment || '';
  ap.approvers[idx].updatedAt = new Date();
  await ap.save();

  // ---- Notifications ----
  if (status === 'Rejected') {
    // Notify requester
    await mailApproval({
      to: ap.createdBy,
      ap,
      title: `Claim ${ap.uniqueNumber} was Rejected by ${approverName}`,
      introHtml: `Your Claim was <strong>rejected</strong> by <strong>${approverName}</strong>${comment ? ` with comment: <em>${escapeHtml(comment)}</em>` : ''}.`
    });
  } else { // Accepted
    // Find next pending approver
    const nextIdx = ap.approvers.findIndex(a => a.status === 'Pending');
    if (nextIdx >= 0) {
      const nextEmail = ap.approvers[nextIdx].name;
      await mailApproval({
        to: nextEmail,
        ap,
        title: `Claim ${ap.uniqueNumber} is awaiting your approval`,
        introHtml: `The previous step was approved by <strong>${approverName}</strong>. The request is now awaiting your action.`,
        includeActionButtons: true
      });
    } else {
      // Final approval reached – notify requester
      await mailApproval({
        to: ap.createdBy,
        ap,
        title: `Claim ${ap.uniqueNumber} Approved ✅`,
        introHtml: `All approvers have accepted your Claim.`
      });
    }
  }

  res.json({ message: 'Status updated' });
});

/* ─────────────────────────────────────────
   One-click Approve/Reject from email
   ───────────────────────────────────────── */
app.get('/mail-oneclick/:token', async (req, res) => {
  try {
    const data = verifyAnyMailToken(req.params.token);
    if (data.kind !== 'mail-oneclick') throw new Error('Bad token');

    // prevent multiple uses
    const already = await UsedMailToken.findOne({ jti: data.jti });
    if (already) throw new Error('This link was already used.');

    // sanity checks
    const ap = await Approval.findOne({ uniqueNumber: data.uniqueNumber });
    if (!ap) throw new Error('Request not found.');
    const approver = String(data.approver || '').toLowerCase();
    const isApprover = ap.approvers.some(a => String(a.name||'').toLowerCase() === approver);
    if (!isApprover) throw new Error('Not an approver for this request.');
    if (!isMyTurn(ap, approver)) throw new Error('Not your turn (or already acted).');

    // Apply decision immediately (no comment here)
    const idx = ap.approvers.findIndex(a => String(a.name||'').toLowerCase() === approver);
    ap.approvers[idx].status    = data.action; // 'Accepted' | 'Rejected'
    ap.approvers[idx].comment   = '';
    ap.approvers[idx].updatedAt = new Date();
    await ap.save();

    // mark token used (prevents scans/double clicks)
    await UsedMailToken.create({
      jti: data.jti,
      expiresAt: new Date(data.exp * 1000),
      meta: { uniqueNumber: data.uniqueNumber, approver: data.approver, action: data.action }
    });

    // notifications like in the in-app flow
    if (data.action === 'Rejected') {
      await mailApproval({
        to: ap.createdBy,
        ap,
        title: `Claim ${ap.uniqueNumber} was Rejected by ${approver}`,
        introHtml: `Your Claim was <strong>rejected</strong> by <strong>${approver}</strong>.`
      });
    } else {
      const nextIdx = ap.approvers.findIndex(a => a.status === 'Pending');
      if (nextIdx >= 0) {
        const nextEmail = ap.approvers[nextIdx].name;
        await mailApproval({
          to: nextEmail,
          ap,
          title: `Claim ${ap.uniqueNumber} is awaiting your approval`,
          introHtml: `The previous step was approved by <strong>${approver}</strong>.`,
          includeActionButtons: true
        });
      } else {
        await mailApproval({
          to: ap.createdBy,
          ap,
          title: `Claim ${ap.uniqueNumber} Approved ✅`,
          introHtml: `All approvers have accepted your Claim.`
        });
      }
    }

    // tiny “done” page
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Done</title></head>
    <body style="background:#f8fafc;padding:24px;">
      <div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:18px 18px 22px;font-family:Segoe UI,Roboto,Arial;">
        <h2 style="margin:0 0 8px;">Done</h2>
        <p style="margin:0;">Your decision has been recorded.</p>
      </div>
    </body></html>`);
  } catch (e) {
    const msg = e.message || 'Invalid or expired link.';
    return res.status(400).send(`<!doctype html><html><body><p>${escapeHtml(msg)}</p></body></html>`);
  }
});

/* ─────────────────────────────────────────
   Optional: lightweight comment page
   ───────────────────────────────────────── */
function renderMailActionPage({ ok, message, ap, action, token, approver }) {
  const safeMsg = escapeHtml(message || '');
  const summary = ap ? `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:12px 0;font-family:Segoe UI,Roboto,Arial;">
      <div style="font-weight:600;margin-bottom:6px;">Claim ${escapeHtml(ap.uniqueNumber)}</div>
      <div>Budget: ₹ ${Number(ap.budget||0).toLocaleString('en-IN')}</div>
      <div>Department: ${escapeHtml(ap.department||'-')}</div>
      <div>Purpose: ${escapeHtml(ap.purpose||'-')}</div>
    </div>` : '';

  const form = ok && ap ? `
    <form method="POST" action="/mail-action/${encodeURIComponent(token)}" style="margin-top:12px;font-family:Segoe UI,Roboto,Arial;">
      <div style="margin:8px 0 10px;">
        <label style="margin-right:12px;"><input type="radio" name="action" value="Accepted" ${action==='Accepted'?'checked':''}> Approve</label>
        <label><input type="radio" name="action" value="Rejected" ${action==='Rejected'?'checked':''}> Reject</label>
      </div>
      <div style="margin:8px 0 12px;">
        <label style="display:block;margin-bottom:6px;">Comment (optional):</label>
        <textarea name="comment" rows="4" style="width:100%;max-width:580px;border:1px solid #e5e7eb;border-radius:8px;padding:8px;"></textarea>
      </div>
      <button type="submit" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:10px 14px;font-weight:600;cursor:pointer;">Submit</button>
    </form>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claim comment</title></head>
  <body style="background:#f8fafc;padding:24px;">
    <div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:18px 18px 22px;">
      <h2 style="margin:0 0 8px;font-family:Segoe UI,Roboto,Arial;">${ok?'Add a comment':'Cannot proceed'}</h2>
      <p style="margin:0 0 10px;color:#4b5563;font-family:Segoe UI,Roboto,Arial;">${safeMsg}</p>
      ${summary}
      ${form}
    </div>
  </body></html>`;
}

app.get('/mail-action/:token', async (req, res) => {
  try {
    const data = verifyAnyMailToken(req.params.token); // accept same payload
    const ap = await Approval.findOne({ uniqueNumber: data.uniqueNumber }).lean();
    if (!ap) return res.status(404).send(renderMailActionPage({ ok:false, message:'Request not found.' }));
    const approver = String(data.approver||'').toLowerCase();
    const isApprover = ap.approvers.some(a => String(a.name||'').toLowerCase() === approver);
    if (!isApprover) return res.status(403).send(renderMailActionPage({ ok:false, message:'This link is not for you.' }));
    return res.status(200).send(renderMailActionPage({
      ok:true, message:`Acting as <strong>${escapeHtml(approver)}</strong>.`, ap,
      action: data.action, token: req.params.token, approver
    }));
  } catch (e) {
    return res.status(400).send(renderMailActionPage({ ok:false, message:'Invalid or expired link.' }));
  }
});

app.post('/mail-action/:token', async (req, res) => {
  try {
    const data = verifyAnyMailToken(req.params.token);
    const action  = req.body.action;
    const comment = String(req.body.comment || '');

    // Apply decision (same integrity rules as in-app)
    const ap = await Approval.findOne({ uniqueNumber: data.uniqueNumber });
    if (!ap) throw new Error('Not found');
    const me = String(data.approver||'').toLowerCase();
    const idx = ap.approvers.findIndex(a => String(a.name||'').toLowerCase() === me);
    if (idx === -1) throw new Error('Not your approval to act on');
    if (!['Accepted','Rejected'].includes(action)) throw new Error('Invalid status');
    if (!isMyTurn(ap, me)) throw new Error('Not your turn');

    ap.approvers[idx].status    = action;
    ap.approvers[idx].comment   = comment || '';
    ap.approvers[idx].updatedAt = new Date();
    await ap.save();

    if (action === 'Rejected') {
      await mailApproval({ to: ap.createdBy, ap, title: `Claim ${ap.uniqueNumber} was Rejected by ${me}`, introHtml: `Your Claim was <strong>rejected</strong> by <strong>${me}</strong>${comment ? ` with comment: <em>${escapeHtml(comment)}</em>` : ''}.` });
    } else {
      const nextIdx = ap.approvers.findIndex(a => a.status === 'Pending');
      if (nextIdx >= 0) {
        const nextEmail = ap.approvers[nextIdx].name;
        await mailApproval({ to: nextEmail, ap, title: `Claim ${ap.uniqueNumber} is awaiting your approval`, introHtml: `The previous step was approved by <strong>${me}</strong>.`, includeActionButtons: true });
      } else {
        await mailApproval({ to: ap.createdBy, ap, title: `Claim ${ap.uniqueNumber} Approved ✅`, introHtml: `All approvers have accepted your Claim.` });
      }
    }

    return res.send(`<!doctype html><html><body><p>Saved. You can close this tab.</p></body></html>`);
  } catch (e) {
    return res.status(400).send(`<!doctype html><html><body><p>${escapeHtml(e.message||'Error')}</p></body></html>`);
  }
});

/* ─────────────────────────────────────────
   MASTER controls
   ───────────────────────────────────────── */
app.patch('/api/approvals/:uniqueNumber/master/override', requireAuth(), async (req,res)=>{
  const { approverName, status } = req.body;
  if (!['Pending','Accepted','Rejected'].includes(status))
      return res.status(400).json({ message:'Invalid status' });

  const ap = await Approval.findOne({ uniqueNumber:req.params.uniqueNumber });
  if (!ap) return res.status(404).json({ message:'Not found' });

  const idx = ap.approvers.findIndex(a=> String(a.name||'').toLowerCase() === String(approverName||'').toLowerCase());
  if (idx===-1) return res.status(400).json({ message:'Approver not found' });

  ap.approvers[idx].status    = status;
  ap.approvers[idx].updatedAt = new Date();
  await ap.save();
  res.json({ message:'Override applied' });
});

// ----------------------------------------------------------------------
// Unified endpoints (everyone authenticated can hit these)
// ----------------------------------------------------------------------

// Approvals I created
app.get('/api/approvals/mine', requireAuth(), async (req, res) => {
  const list = await Approval.find({ createdBy: req.user.username }).sort({ createdAt: -1 });
  res.json(list);
});

// Approvals where I am listed as an approver (any status)
app.get('/api/approvals/actor', requireAuth(), async (req, res) => {
  const me = String(req.user.username || '').toLowerCase();
  const list = await Approval.find({ 'approvers.name': me }).sort({ createdAt: -1 });
  res.json(list);
});

// Approvals that currently need my action (I'm first Pending)
// ----------------------------- Replace this route -----------------------------
app.get('/api/approvals/needs-my-action', requireAuth(), async (req, res) => {
  try {
    const meEmail = String(req.user.username || '').toLowerCase();

    // build matching candidates
    const candidates = new Set();
    candidates.add(meEmail);

    // add local-part (meghna.aggarwal)
    const local = meEmail.split('@')[0];
    candidates.add(local);

    // normalized simple form (meghnaaggarwal)
    const simple = local.replace(/\s+/g, '').replace(/[._-]/g, '').toLowerCase();
    candidates.add(simple);

    // directory display name (if exists), plus its simple form
    const meDir = await Directory.findOne({ email: meEmail }).lean();
    if (meDir && meDir.name) {
      const disp = String(meDir.name).toLowerCase();
      candidates.add(disp);
      candidates.add(disp.replace(/\s+/g,'').replace(/[._-]/g,''));
    }

    const candArray = Array.from(candidates).filter(Boolean);
    console.log('needs-my-action: matching candidates for', meEmail, candArray);

    // Query any approval where approvers.name equals any candidate (exact match)
    // (We use $in with the array)
    const list = await Approval.find({ 'approvers.name': { $in: candArray } }).sort({ createdAt: -1 }).lean();

    console.log(`needs-my-action lookup for ${meEmail}: found ${list.length} approvals referencing one of candidates`);

    // filter to only those where it is actually their turn (first pending == their index) and not draft
    const mine = list.filter(ap => {
      const firstPendingIdx = (ap.approvers||[]).findIndex(a => a.status === 'Pending');

      // find my index tolerant to email/display/simple
      const myIdx = (ap.approvers||[]).findIndex(a => {
        const n = String(a.name || '').toLowerCase();
        if (!n) return false;
        if (n === meEmail) return true;
        if (n === local) return true;
        if (n === simple) return true;
        if (meDir && meDir.name && n === String(meDir.name).toLowerCase()) return true;
        if (n.replace(/\s+/g,'').replace(/[._-]/g,'') === simple) return true;
        return false;
      });

      const ok = firstPendingIdx !== -1 && myIdx === firstPendingIdx && !ap.isDraft;
      if (!ok) {
        console.log(`  filtered ${ap.uniqueNumber}: firstPending=${firstPendingIdx}, myIdx=${myIdx}, isDraft=${!!ap.isDraft}`);
      }
      return ok;
    });

    return res.json(mine);
  } catch (e) {
    console.error('needs-my-action error', e);
    return res.status(500).json({ message: 'Server error' });
  }
});


// Approved / Rejected by me
app.get('/api/approvals/by-me', requireAuth(), async (req, res) => {
  const { status } = req.query; // "Accepted" | "Rejected"
  const me = String(req.user.username || '').toLowerCase();
  const list = await Approval.find({
    approvers: { $elemMatch: { name: me, status } }
  }).sort({ createdAt: -1 });
  res.json(list);
});

// (Optional) Everyone can see all approvals → master/hr only mirror
app.get('/api/approvals/all', requireAuth(), requireRole('master','hr'), async (_req, res) => {
  const list = await Approval.find().sort({ createdAt: -1 });
  res.json(list);
});

app.delete('/api/approvals/:uniqueNumber', requireAuth(), async (req,res)=>{
  const del = await Approval.findOneAndDelete({ uniqueNumber:req.params.uniqueNumber });
  if (!del) return res.status(404).json({ message:'Not found' });
  res.json({ message:'Request deleted' });
});

app.patch('/api/approvals/:uniqueNumber/master/reassign', requireAuth(), async (req,res)=>{
  const { approvers } = req.body;
  if (!Array.isArray(approvers) || !approvers.every(s=>typeof s==='string'))
      return res.status(400).json({ message:'Invalid approvers list' });

  const ap = await Approval.findOne({ uniqueNumber:req.params.uniqueNumber });
  if (!ap) return res.status(404).json({ message:'Not found' });

  // normalize provided approvers to lowercase (assume they are emails or names)
  ap.approvers = approvers.map(n=>({ name: String(n || '').toLowerCase(), status:'Pending', updatedAt:new Date() }));
  await ap.save();
  res.json({ message:'Approvers reassigned' });
});

app.patch('/api/approvals/:uniqueNumber/master/reset', requireAuth(), async (req,res)=>{
  const ap = await Approval.findOne({ uniqueNumber:req.params.uniqueNumber });
  if (!ap) return res.status(404).json({ message:'Not found' });

  ap.approvers.forEach(a=>{ a.status='Pending'; a.updatedAt=new Date(); });
  await ap.save();
  res.json({ message:'Request reset' });
});

/* ─────────────────────────────────────────
   TEMP: migration endpoint — run once (master/hr only)
   ----------------------
   Converts approver display-names to emails where possible using Directory.
   Remove this endpoint after migration.
   ───────────────────────────────────────── */
app.post('/_admin/migrate-approvers-to-email', requireAuth(), requireRole('master','hr'), async (req, res) => {
  try {
    const all = await Approval.find().lean();
    let changed = 0, inspected = 0;
    for (const ap of all) {
      let dirty = false;
      const newApprovers = [];
      for (const a of (ap.approvers || [])) {
        inspected++;
        const raw = a.name || '';
        if (!raw.includes('@')) {
          const resolved = await resolveApproverToEmail(raw);
          if (resolved && resolved !== raw.toLowerCase()) {
            dirty = true;
            newApprovers.push(Object.assign({}, a, { name: resolved }));
          } else {
            newApprovers.push(Object.assign({}, a, { name: raw.toLowerCase() }));
          }
        } else {
          newApprovers.push(Object.assign({}, a, { name: raw.toLowerCase() }));
        }
      }
      if (dirty) {
        await Approval.updateOne({ uniqueNumber: ap.uniqueNumber }, { $set: { approvers: newApprovers }});
        changed++;
      }
    }
    res.json({ message: 'migration done', inspected, changed });
  } catch (e) {
    console.error('migration error', e);
    res.status(500).json({ message: 'migration failed' });
  }
});
// ─────────────────────────────────────────
// ADMIN: backfill HR + Accounts after manager accepted
// Adds HR & Accounts approvers when manager already approved but chain missing
// ─────────────────────────────────────────
// in server.js
const FIXED_CHAIN_HR_EMAIL = 'hr@adventz.zuarimoney.com';
const FIXED_CHAIN_ACCOUNTS_EMAIL = 'accounts@adventz.zuarimoney.com';


app.post('/_admin/backfill-hr-accounts', requireAuth(), requireRole('master','hr'), async (req, res) => {
  try {
    const all = await Approval.find().lean();
    let inspected = 0, updated = 0;

    for (const ap of all) {
      inspected++;
      // skip drafts and already-complete approvals
      if (ap.isDraft) continue;
      const approvers = Array.isArray(ap.approvers) ? ap.approvers.map(a => ({ ...a })) : [];

      // if manager step exists and is Accepted, but HR/Accounts not present -> append them
      // We consider "manager step exists" as approvers[0] present.
      if (approvers.length >= 1 && approvers[0].status === 'Accepted') {
        const names = approvers.map(a => String(a.name || '').toLowerCase());
        const hrPresent = names.includes(FIXED_CHAIN_HR_EMAIL.toLowerCase());
        const accountsPresent = names.includes(FIXED_CHAIN_ACCOUNTS_EMAIL.toLowerCase());

        // If both present nothing to do
        if (hrPresent && accountsPresent) continue;

        // Build appended items (only ones missing)
        const toAppend = [];
        if (!hrPresent) {
          toAppend.push({ name: FIXED_CHAIN_HR_EMAIL.toLowerCase(), status: 'Pending', comment: '', updatedAt: null });
        }
        if (!accountsPresent) {
          toAppend.push({ name: FIXED_CHAIN_ACCOUNTS_EMAIL.toLowerCase(), status: 'Pending', comment: '', updatedAt: null });
        }

        // Append and save
        if (toAppend.length) {
          await Approval.updateOne(
            { uniqueNumber: ap.uniqueNumber },
            { $push: { approvers: { $each: toAppend } } }
          );
          updated++;
        }
      }
    }

    res.json({ message: 'backfill complete', inspected, updated });
  } catch (e) {
    console.error('backfill error', e);
    res.status(500).json({ message: 'backfill failed', error: String(e) });
  }
});

/* ─────────────────────────────────────────
   Fallbacks & start
   ───────────────────────────────────────── */
app.use((req,res)=> res.status(404).sendFile(path.join(__dirname,'public','404.html')));
app.use((err,_req,res,_next)=>{ console.error(err); res.status(500).json({ message:'Internal server error' }); });

app.listen(PORT, ()=> console.log(`Server → http://localhost:${PORT}`));
