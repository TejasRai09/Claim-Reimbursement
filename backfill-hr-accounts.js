// backfill-hr-accounts.js
require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';
const FIXED_CHAIN_HR_EMAIL = 'hr@adventz.zuarimoney.com';
const FIXED_CHAIN_ACCOUNTS_EMAIL = 'accounts@adventz.zuarimoney.com';

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('MongoDB connected');

    const Approval = mongoose.model('Approval', new mongoose.Schema({}, { strict: false }), 'approvals');

    const all = await Approval.find().lean();
    let inspected = 0, updated = 0;

    for (const ap of all) {
      inspected++;
      if (ap.isDraft) continue;

      const approvers = Array.isArray(ap.approvers) ? ap.approvers.map(a => ({ ...a })) : [];

      // Ensure we only act where manager already accepted (to avoid interrupting in-progress flows)
      if (approvers.length >= 1 && approvers[0].status === 'Accepted') {
        const names = approvers.map(a => String(a.name || '').toLowerCase());
        const hrPresent = names.includes(FIXED_CHAIN_HR_EMAIL.toLowerCase());
        const accountsPresent = names.includes(FIXED_CHAIN_ACCOUNTS_EMAIL.toLowerCase());

        if (!hrPresent || !accountsPresent) {
          const toAppend = [];
          if (!hrPresent) {
            toAppend.push({ name: FIXED_CHAIN_HR_EMAIL.toLowerCase(), status: 'Pending', comment: '', updatedAt: null });
          }
          if (!accountsPresent) {
            toAppend.push({ name: FIXED_CHAIN_ACCOUNTS_EMAIL.toLowerCase(), status: 'Pending', comment: '', updatedAt: null });
          }

          if (toAppend.length) {
            await Approval.updateOne(
              { uniqueNumber: ap.uniqueNumber },
              { $push: { approvers: { $each: toAppend } } }
            );
            updated++;
            console.log(`Updated ${ap.uniqueNumber} -> appended: ${toAppend.map(t=>t.name).join(',')}`);
          }
        }
      }
    }

    console.log(`Backfill finished. Inspected: ${inspected}, Updated: ${updated}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Backfill error', e);
    try { await mongoose.disconnect(); } catch(_) {}
    process.exit(1);
  }
})();
