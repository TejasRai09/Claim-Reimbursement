#!/usr/bin/env node
/* importDirectory.js
 *
 * Import/Upsert the company directory from an XLSX/CSV file into MongoDB.
 *
 * Features:
 *  - Upsert by email (default) or by ecode:   --key=email | --key=ecode
 *  - Insert-only mode (skip updates):         --only-new
 *  - Dry run (no DB writes):                  --dry-run
 *
 * Env:
 *  - MONGO_URI=mongodb://localhost:27017/approvaldb
 *
 * Collection: "directories" (same as your server uses)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');

/* ---------------- CLI args ---------------- */
function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.replace(/^--/, '').split('=');
    if (v === undefined) {
      // flags like --only-new or --dry-run
      out[k] = true;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const args = parseArgs();
const fileArg = args._[0];
const KEY = (args.key || 'email').toLowerCase(); // 'email' | 'ecode'
const ONLY_NEW = !!args['only-new'];
const DRY_RUN = !!args['dry-run'];

if (!fileArg) {
  console.error('Usage: node importDirectory.js <path-to-xlsx-or-csv> [--key=email|ecode] [--only-new] [--dry-run]');
  process.exit(1);
}

/* ---------------- DB & Schema ---------------- */
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';

const DirectorySchema = new mongoose.Schema(
  {
    ecode: String,
    name: String,
    email: { type: String, unique: true, index: true },
    mobile: String,
    impactLevel: String,
    business: String,
  },
  { collection: 'directories' }
);
const Directory = mongoose.model('Directory', DirectorySchema);

/* ---------------- Helpers ---------------- */
const norm = (s) => String(s || '').trim();
const normLower = (s) => norm(s).toLowerCase();

function mapRowToDoc(row) {
  // Header mapping (case-insensitive). These are *examples* of headings your sheets might use.
  const keys = Object.keys(row);
  const getBy = (candidates) => {
    for (const k of keys) {
      const kN = k.trim().toLowerCase();
      if (candidates.includes(kN)) return row[k];
    }
    return '';
  };

  const ecode       = getBy(['e.code', 'ecode', 'emp code', 'employee code', 'employee id']);
  const name        = getBy(['name', 'employee name', 'emp name', 'full name']);
  const emailRaw    = getBy(['email id', 'email', 'email address', 'mail', 'official email']);
  const mobile      = getBy(['mobile no.', 'mobile', 'phone', 'contact', 'contact no']);
  const impactLevel = getBy(['impact level', 'impactlevel', 'level']);
  const business    = getBy(['business', 'company', 'unit', 'bu', 'department']);

  const email = normLower(emailRaw);
  return {
    ecode: norm(ecode),
    name: norm(name),
    email, // already lower-cased
    mobile: norm(mobile),
    impactLevel: norm(impactLevel),
    business: norm(business),
  };
}

/* Compare doc fields to see if an update would change anything */
function diffChanged(existing, incoming) {
  const fields = ['ecode', 'name', 'email', 'mobile', 'impactLevel', 'business'];
  return fields.some((f) => (existing[f] || '') !== (incoming[f] || ''));
}

/* ---------------- Main ---------------- */
(async function main() {
  const absPath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  console.log(`Reading: ${absPath}`);
  const wb = XLSX.readFile(absPath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  if (!rows.length) {
    console.warn('Sheet is empty, nothing to import.');
    process.exit(0);
  }

  console.log(`Rows found: ${rows.length}`);
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('MongoDB connected ✓');

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedNoEmail = 0;
  let skippedNoKey = 0;
  let skippedOnlyNew = 0;
  let conflicts = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    try {
      const doc = mapRowToDoc(rows[i]);

      // Must have an email to store (schema requires unique email)
      if (!doc.email || !doc.email.includes('@')) {
        skippedNoEmail++;
        continue;
      }

      if (KEY === 'email') {
        // Upsert by email (default behavior)
        const existing = await Directory.findOne({ email: doc.email });
        if (!existing) {
          if (DRY_RUN) {
            inserted++;
            continue;
          }
          await Directory.create(doc);
          inserted++;
        } else {
          if (ONLY_NEW) {
            skippedOnlyNew++;
            continue;
          }
          if (!diffChanged(existing, doc)) {
            unchanged++;
            continue;
          }
          if (!DRY_RUN) {
            // Update only changed fields
            existing.set(doc);
            await existing.save();
          }
          updated++;
        }
      } else if (KEY === 'ecode') {
        // Upsert by employee code; allows safe email rename
        if (!doc.ecode) {
          skippedNoKey++;
          continue;
        }

        const existingByCode = await Directory.findOne({ ecode: doc.ecode });
        if (!existingByCode) {
          // New by ecode; but ensure we won't collide with another document's email
          const emailOwner = await Directory.findOne({ email: doc.email });
          if (emailOwner) {
            // Someone else already has this email → conflict
            conflicts++;
            continue;
          }
          if (DRY_RUN) {
            inserted++;
            continue;
          }
          await Directory.create(doc);
          inserted++;
        } else {
          if (ONLY_NEW) {
            skippedOnlyNew++;
            continue;
          }

          // If email is changing, ensure no collision with a different doc
          if (doc.email && existingByCode.email !== doc.email) {
            const other = await Directory.findOne({ email: doc.email, _id: { $ne: existingByCode._id } });
            if (other) {
              // another record already uses the target email → conflict
              conflicts++;
              continue;
            }
          }

          if (!diffChanged(existingByCode, doc)) {
            unchanged++;
            continue;
          }

          if (!DRY_RUN) {
            existingByCode.set(doc);
            await existingByCode.save();
          }
          updated++;
        }
      } else {
        console.error(`Unknown --key=${KEY}. Use "email" or "ecode".`);
        await mongoose.disconnect();
        process.exit(1);
      }
    } catch (e) {
      // Unique errors etc.
      errors++;
      console.error(`Row ${i + 1} error:`, e.message || e);
    }
  }

  console.log('\n--- Import Summary ---');
  console.log(`Key mode      : ${KEY}`);
  console.log(`Only new      : ${ONLY_NEW ? 'yes' : 'no'}`);
  console.log(`Dry run       : ${DRY_RUN ? 'yes' : 'no'}`);
  console.log('----------------------');
  console.log(`Inserted      : ${inserted}`);
  console.log(`Updated       : ${updated}`);
  console.log(`Unchanged     : ${unchanged}`);
  console.log(`Skipped (no email) : ${skippedNoEmail}`);
  if (KEY === 'ecode') {
    console.log(`Skipped (no ecode) : ${skippedNoKey}`);
    console.log(`Conflicts (email already in use by another record): ${conflicts}`);
  }
  console.log(`Skipped (only-new) : ${skippedOnlyNew}`);
  console.log(`Errors        : ${errors}`);

  await mongoose.disconnect();
  console.log('Done ✓');
  process.exit(0);
})().catch(async (err) => {
  console.error('Fatal:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
