// scripts/createMaster.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';

const userSchema = new mongoose.Schema({
  email:    { type: String, unique: true },
  password: String,
  role:     { type: String, default: 'user' }
});
const User = mongoose.model('User', userSchema);

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

    const email = 'master@adventz.com'.toLowerCase();
    const plain = 'Zuari@12345';
    const hash  = await bcrypt.hash(plain, 10);

    const existing = await User.findOne({ email });
    if (existing) {
      existing.password = hash;
      existing.role = 'master';
      await existing.save();
      console.log('Updated existing master user:', email);
    } else {
      await User.create({ email, password: hash, role: 'master' });
      console.log('Created master user:', email);
    }
  } catch (e) {
    console.error('Error:', e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
