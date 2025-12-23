// clearDirectory.js
require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';

(async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    // Use a loose schema just to access the collection
    const Directory = mongoose.model(
      'Directory',
      new mongoose.Schema({}, { strict: false }),
      'directories'
    );

    const result = await Directory.deleteMany({});
    console.log(`✓ Deleted ${result.deletedCount} directory records`);
  } catch (e) {
    console.error('Error clearing directory:', e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
