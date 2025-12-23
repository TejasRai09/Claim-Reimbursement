// resetDirectory.js
require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';

(async () => {
  try {
    await mongoose.connect(MONGO_URI);

    const Directory = mongoose.model(
      'Directory',
      new mongoose.Schema({}, { strict: false }),
      'directories'
    );

    const result = await Directory.deleteMany({});
    console.log(`✓ Cleared directories collection (${result.deletedCount} docs deleted)`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Error clearing directories:', e);
    process.exit(1);
  }
})();
