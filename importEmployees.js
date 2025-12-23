#!/usr/bin/env node
// importEmployees.js
// Usage: node importEmployees.js employees.xlsx

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mongoose  = require('mongoose');
const XLSX      = require('xlsx');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/approvaldb';

const directorySchema = new mongoose.Schema(
  {
    empCode:      String,
    name:         String,
    email:        { type: String, unique: true, index: true },
    designation:  String,
    department:   String,
    managerName:  String,
    managerEmail: String,
    company:      String,
    phone:        String
  },
  { collection: 'directories' }
);
const Directory = mongoose.model('Directory', directorySchema);

const fileArg = process.argv[2];
if (!fileArg) {
  console.error('Usage: node importEmployees.js <path-to-xlsx-or-csv>');
  process.exit(1);
}

function norm(s)      { return String(s || '').trim(); }
function normLower(s) { return norm(s).toLowerCase(); }
function normKeyName(s) { return norm(s).toUpperCase(); }

(async () => {
  try {
    const abs = path.resolve(process.cwd(), fileArg);
    if (!fs.existsSync(abs)) {
      console.error('File not found:', abs);
      process.exit(1);
    }

    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('MongoDB ✓');

    const wb   = XLSX.readFile(abs, { cellDates: false });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) {
      console.log('No rows in sheet.');
      process.exit(0);
    }

    console.log('Rows:', rows.length);

    // 1) Build a map: Employee Name -> email (for manager lookup)
    const nameToEmail = {};
    for (const r of rows) {
      const empName = normKeyName(r['Employee Name'] || r['Emp Name'] || r['Name']);
      const email   = normLower(r['Email']);
      if (empName && email) {
        nameToEmail[empName] = email;
      }
    }

    // 2) Clear existing directory (only directory, not whole DB)
    await Directory.deleteMany({});
    console.log('Cleared existing directory.');

    // 3) Insert all employees with managerEmail resolved from that map
    let inserted = 0;
    for (const r of rows) {
      const empCode     = norm(r['Employee Number']);
      const name        = norm(r['Employee Name']);
      const designation = norm(r['Curr.Designation']);
      const department  = norm(r['Curr.Department']);
      const mgrNameRaw  = norm(r['Manager Name']);
      const company     = norm(r['Curr.Company']);
      const email       = normLower(r['Email']);
      const phone       = norm(String(r['Phone'] || r['Mobile'] || ''));

      if (!email || !email.includes('@')) {
        console.log('Skip (no email):', name, empCode);
        continue;
      }

      const managerKey   = normKeyName(mgrNameRaw);
      const managerEmail = managerKey ? (nameToEmail[managerKey] || '') : '';

      await Directory.create({
        empCode,
        name,
        email,
        designation,
        department,
        managerName: mgrNameRaw,
        managerEmail,
        company,
        phone
      });
      inserted++;
    }

    console.log('Inserted employees:', inserted);
    await mongoose.disconnect();
    console.log('Done ✓');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
