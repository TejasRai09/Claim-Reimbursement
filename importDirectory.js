#!/usr/bin/env node
/* importDirectory.js
 *
 * Import/Upsert the company directory from Employees.xlsx into MongoDB.
 *
 * Assumed headers (case-insensitive):
 *   - Employee Number
 *   - Employee Name
 *   - Curr.Designation
 *   - Curr.Department
 *   - Manager Name
 *   - Curr.Company
 *   - Email
 *   - Phone
 *
 * Env:
 *   - MONGO_URI=mongodb://localhost:27017/approvaldb
 *
 * Collection: "directories"
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
    if (v === undefined) out[k] = true;
    else out[k] = v;
  }
  return out;
}

const args    = parseArgs();
const fileArg = args._[0];
const DRY_RUN = !!args['dry-run'];

if (!fileArg) {
  console.error('Usage: node importDirectory.js Employees.xlsx [--dry-run]');
  process.exit(1);
}

/* ---------------- DB & Schema ---------------- */
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';

const DirectorySchema = new mongoose.Schema(
  {
    empCode:      String,                                      // Employee Number
    name:         String,                                      // Employee Name
    email:        { type: String, unique: true, index: true }, // Email
    designation:  String,                                      // Curr.Designation
    department:   String,                                      // Curr.Department
    managerName:  String,                                      // Manager Name (display)
    managerEmail: String,                                      // derived from manager row
    company:      String,                                      // Curr.Company
    phone:        String                                       // Phone
  },
  { collection: 'directories' }
);
const Directory = mongoose.model('Directory', DirectorySchema);

/* ---------------- Helpers ---------------- */
const norm      = (s) => String(s || '').trim();
const normLower = (s) => norm(s).toLowerCase();

function mapRowToDoc(row) {
  const keys = Object.keys(row);

  const getBy = (candidates) => {
    for (const k of keys) {
      const kN = k.trim().toLowerCase();
      if (candidates.includes(kN)) return row[k];
    }
    return '';
  };

  const empCode      = getBy(['employee number', 'emp number', 'employee no', 'emp no', 'employee id', 'emp id']);
  const name         = getBy(['employee name', 'name', 'emp name', 'full name']);
  const emailRaw     = getBy(['email', 'email id', 'email address', 'official email']);
  const designation  = getBy(['curr.designation', 'designation', 'current designation']);
  const department   = getBy(['curr.department', 'department', 'current department']);
  const managerName  = getBy(['manager name', 'reporting manager', 'manager']);
  const company      = getBy(['curr.company', 'company', 'organisation', 'organization']);
  const phone        = getBy(['phone', 'mobile', 'mobile no', 'contact', 'contact no']);

  const email = normLower(emailRaw);

  return {
    empCode:      norm(empCode),
    name:         norm(name),
    email,                   // lower-cased
    designation:  norm(designation),
    department:   norm(department),
    managerName:  norm(managerName),
    managerEmail: '',        // will be back-filled
    company:      norm(company),
    phone:        norm(phone),
  };
}

// Compare doc fields to see if an update would change anything
function diffChanged(existing, incoming) {
  const fields = [
    'empCode',
    'name',
    'email',
    'designation',
    'department',
    'managerName',
    'managerEmail',
    'company',
    'phone'
  ];
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
  const wb        = XLSX.readFile(absPath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws        = wb.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(ws, { defval: '' });

  if (!rows.length) {
    console.warn('Sheet is empty, nothing to import.');
    process.exit(0);
  }

  console.log(`Rows found: ${rows.length}`);

  // First, map all rows -> docs
  const docs = rows
    .map(mapRowToDoc)
    .filter(d => d.email && d.email.includes('@'));

  // Build managerName -> email map (from manager's own row)
  const nameToEmail = new Map();
  for (const d of docs) {
    if (d.name && d.email) {
      const key = d.name.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!nameToEmail.has(key)) {
        nameToEmail.set(key, d.email);
      }
    }
  }

  // Fill managerEmail if possible
  for (const d of docs) {
    if (d.managerName && !d.managerEmail) {
      const key = d.managerName.trim().toLowerCase().replace(/\s+/g, ' ');
      const mgrEmail = nameToEmail.get(key);
      if (mgrEmail) {
        d.managerEmail = mgrEmail;
      }
    }
  }

  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('MongoDB connected ✓');

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedNoEmail = 0;
  let errors = 0;

  for (const doc of docs) {
    try {
      if (!doc.email || !doc.email.includes('@')) {
        skippedNoEmail++;
        continue;
      }

      const existing = await Directory.findOne({ email: doc.email });
      if (!existing) {
        if (!DRY_RUN) {
          await Directory.create(doc);
        }
        inserted++;
      } else {
        if (!diffChanged(existing, doc)) {
          unchanged++;
          continue;
        }
        if (!DRY_RUN) {
          existing.set(doc);
          await existing.save();
        }
        updated++;
      }
    } catch (e) {
      console.error('Row error:', e.message || e);
      errors++;
    }
  }

  console.log('---- Import summary ----');
  console.log('Inserted :', inserted);
  console.log('Updated  :', updated);
  console.log('Unchanged:', unchanged);
  console.log('Skipped (no email):', skippedNoEmail);
  console.log('Errors   :', errors);

  await mongoose.disconnect();
  process.exit(0);
})();
