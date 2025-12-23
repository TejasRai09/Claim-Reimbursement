// File: seedApprover.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

// ── Mongo connection ──────────────────────────────────────────
mongoose.connect(
  process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb'
).catch(err => { console.error('MongoDB ❌', err); process.exit(1); });

const User = mongoose.model(
  'User',
  new mongoose.Schema({
    email:    { type: String, unique: true },
    password: String,   // bcrypt‑hashed
    role:     String
  }),
  'users'
);

// ── Seed data ────────────────────────────────────────────────
(async () => {
  try {
    const approvers = [
      { email: 'rohit.sindhava@adventz.com', password: 'pass', role: 'approver' },
      { email: 'intakhab@adventz.com',      password: 'pass', role: 'approver' },
      { email: 'athar@adventz.com',         password: 'pass', role: 'approver' }
    ];

    for (const { email, password, role } of approvers) {
      const hash = await bcrypt.hash(password, 10);          // ← hash each pwd
      await User.updateOne(
        { email },
        { $set: { email, password: hash, role } },
        { upsert: true }
      );
      console.log(`✓  seeded ${email}`);
    }

    console.log('Approver seeding complete');
  } catch (err) {
    console.error('Seeding error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
