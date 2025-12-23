// check-hr-accounts.js
require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';
const HR_EMAIL = 'hr@adventz.zuarimoney.com';
const ACCOUNTS_EMAIL = 'accounts@adventz.zuarimoney.com';

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB connected');

    const Approval = mongoose.model('Approval', new mongoose.Schema({}, { strict: false }), 'approvals');

    // Query approvals where approvers array contains hr or accounts (case-insensitive)
    const regexHr = new RegExp('^' + HR_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    const regexAcc = new RegExp('^' + ACCOUNTS_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');

    const hrMatches = await Approval.find({ 'approvers.name': regexHr }).sort({ createdAt: -1 }).lean();
    const accMatches = await Approval.find({ 'approvers.name': regexAcc }).sort({ createdAt: -1 }).lean();

    console.log(`\nHR matches for ${HR_EMAIL}: ${hrMatches.length}`);
    hrMatches.slice(0, 10).forEach(ap => {
      console.log(` - ${ap.uniqueNumber}  [${ap.approvers.map(a => `${a.name}:${a.status}`).join(', ')}]`);
    });
    if (hrMatches.length > 10) console.log(`   ...and ${hrMatches.length - 10} more\n`);

    console.log(`\nAccounts matches for ${ACCOUNTS_EMAIL}: ${accMatches.length}`);
    accMatches.slice(0, 10).forEach(ap => {
      console.log(` - ${ap.uniqueNumber}  [${ap.approvers.map(a => `${a.name}:${a.status}`).join(', ')}]`);
    });
    if (accMatches.length > 10) console.log(`   ...and ${accMatches.length - 10} more\n`);

    // Additionally check approvals where HR or Accounts exist but are NOT first pending (so they won't show in needs-my-action)
    const both = await Approval.find({
      $or: [{ 'approvers.name': regexHr }, { 'approvers.name': regexAcc }]
    }).sort({ createdAt: -1 }).lean();

    const notFirstPending = both.filter(ap => {
      if (!Array.isArray(ap.approvers) || ap.approvers.length === 0) return false;
      const firstPendingIdx = ap.approvers.findIndex(a => a.status === 'Pending');
      const hrIdx = ap.approvers.findIndex(a => regexHr.test(String(a.name||'')));
      const accIdx = ap.approvers.findIndex(a => regexAcc.test(String(a.name||'')));
      // if HR/Acc exist but their index !== firstPendingIdx then they won't appear in needs-my-action
      return (hrIdx !== -1 && hrIdx !== firstPendingIdx) || (accIdx !== -1 && accIdx !== firstPendingIdx);
    });

    console.log(`\nApprovals where HR/Accounts present but NOT the first pending (so won't show up in 'needs my action'): ${notFirstPending.length}`);
    notFirstPending.slice(0, 10).forEach(ap => {
      const firstPendingIdx = ap.approvers.findIndex(a => a.status === 'Pending');
      const firstPendingName = firstPendingIdx === -1 ? '(none)' : ap.approvers[firstPendingIdx].name;
      console.log(` - ${ap.uniqueNumber}  firstPending=${firstPendingName}  [${ap.approvers.map(a => `${a.name}:${a.status}`).join(', ')}]`);
    });
    if (notFirstPending.length > 10) console.log(`   ...and ${notFirstPending.length - 10} more\n`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Error:', e);
    try { await mongoose.disconnect(); } catch(_) {}
    process.exit(1);
  }
})();
