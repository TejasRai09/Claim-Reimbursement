// File: seedTestUsers.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,   // bcrypt hashed
  role: { type: String, default: 'user' }
});
const User = mongoose.model('User', userSchema, 'users');

async function upsert(email, password, role = 'approver') {
  const hash = await bcrypt.hash(password, 10);
  await User.updateOne(
    { email: email.toLowerCase() },
    { $set: { email: email.toLowerCase(), password: hash, role } },
    { upsert: true }
  );
  console.log(`✓ upserted ${email} as ${role}`);
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB connected ✓');

    // CHOOSE YOUR TEST PASSWORDS HERE
    await upsert('rohit.sindhava@adventz.com',     '1234', 'approver');
    await upsert('aashutosh.aggarwal@adventz.com', '1234', 'approver');

    console.log('Done ✓');
  } catch (e) {
    console.error(e);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
