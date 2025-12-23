// resetDb.js
require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';

(async () => {
  await mongoose.connect(MONGO_URI);

  const Approval    = mongoose.model('Approval', new mongoose.Schema({}, { strict: false }), 'approvals');
  const User        = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');
  const ChatMessage = mongoose.model('ChatMessage', new mongoose.Schema({}, { strict: false }), 'chatmessages');
  const Directory   = mongoose.model('Directory', new mongoose.Schema({}, { strict: false }), 'directories');

  await Promise.all([
    Approval.deleteMany({}),
    User.deleteMany({}),
    ChatMessage.deleteMany({}),
    Directory.deleteMany({})
  ]);

  console.log('✓ Cleared approvals, users, chatmessages, directories');
  await mongoose.disconnect();
  process.exit(0);
})();
