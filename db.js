/**
 * Database layer — backed by Turso (a hosted, SQLite-compatible database)
 * instead of a local file. This means the data survives even on hosts (like
 * Render's free tier) that don't keep local files between restarts.
 *
 * Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN set in .env — see README.
 */
const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const uid = () => Math.random().toString(36).slice(2, 10);

async function init() {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      base REAL DEFAULT 0,
      allowances REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      account_number TEXT,
      ifsc TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_runs (
      id TEXT PRIMARY KEY,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_entries (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      base REAL DEFAULT 0,
      allowances REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      bonus REAL DEFAULT 0,
      adjustment REAL DEFAULT 0,
      net REAL NOT NULL,
      account_number TEXT,
      ifsc TEXT,
      status TEXT DEFAULT 'pending',
      transfer_id TEXT,
      paid_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_entries_run ON payroll_entries(run_id)`,
  ], 'write');
}
const ready = init();

// ---------- employees ----------
async function listEmployees() {
  await ready;
  const r = await client.execute('SELECT * FROM employees ORDER BY created_at ASC');
  return r.rows.map(rowToEmployee);
}
async function createEmployee(data) {
  await ready;
  const id = uid();
  await client.execute({
    sql: `INSERT INTO employees (id,name,role,base,allowances,deductions,account_number,ifsc,active)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [id, data.name, data.role, data.base, data.allowances, data.deductions, data.accountNumber, data.ifsc, data.active ? 1 : 0],
  });
  const r = await client.execute({ sql: 'SELECT * FROM employees WHERE id=?', args: [id] });
  return rowToEmployee(r.rows[0]);
}
async function updateEmployee(id, data) {
  await ready;
  const existing = await client.execute({ sql: 'SELECT * FROM employees WHERE id=?', args: [id] });
  if (!existing.rows[0]) return null;
  await client.execute({
    sql: `UPDATE employees SET name=?, role=?, base=?, allowances=?, deductions=?, account_number=?, ifsc=?, active=? WHERE id=?`,
    args: [data.name, data.role, data.base, data.allowances, data.deductions, data.accountNumber, data.ifsc, data.active ? 1 : 0, id],
  });
  const r = await client.execute({ sql: 'SELECT * FROM employees WHERE id=?', args: [id] });
  return rowToEmployee(r.rows[0]);
}
async function deleteEmployee(id) {
  await ready;
  await client.execute({ sql: 'DELETE FROM employees WHERE id=?', args: [id] });
}
function rowToEmployee(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, role: r.role, base: r.base, allowances: r.allowances,
    deductions: r.deductions, accountNumber: r.account_number, ifsc: r.ifsc, active: !!r.active,
  };
}

// ---------- payroll runs ----------
async function listRuns() {
  await ready;
  // One query for every run, one query for every entry across all runs —
  // not one entries-query per run (that was the slow part: N+1 round-trips
  // to the cloud database, one extra network round-trip per saved run).
  const runsRes = await client.execute('SELECT * FROM payroll_runs ORDER BY created_at DESC');
  const allEntriesRes = await client.execute('SELECT * FROM payroll_entries');
  const entriesByRun = new Map();
  for (const row of allEntriesRes.rows) {
    if (!entriesByRun.has(row.run_id)) entriesByRun.set(row.run_id, []);
    entriesByRun.get(row.run_id).push(rowToEntry(row));
  }
  return runsRes.rows.map(run => ({
    id: run.id, month: run.month, year: run.year, label: run.label, createdAt: run.created_at,
    entries: entriesByRun.get(run.id) || [],
  }));
}
async function getRun(runId) {
  await ready;
  const runRes = await client.execute({ sql: 'SELECT * FROM payroll_runs WHERE id=?', args: [runId] });
  const run = runRes.rows[0];
  if (!run) return null;
  const entriesRes = await client.execute({ sql: 'SELECT * FROM payroll_entries WHERE run_id=?', args: [runId] });
  return { id: run.id, month: run.month, year: run.year, label: run.label, createdAt: run.created_at, entries: entriesRes.rows.map(rowToEntry) };
}
async function createRun({ month, year, label, entries }) {
  await ready;
  const runId = uid();
  const statements = [
    { sql: 'INSERT INTO payroll_runs (id,month,year,label) VALUES (?,?,?,?)', args: [runId, month, year, label] },
  ];
  for (const e of entries) {
    statements.push({
      sql: `INSERT INTO payroll_entries (id,run_id,employee_id,name,role,base,allowances,deductions,bonus,adjustment,net,account_number,ifsc,status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      args: [uid(), runId, e.employeeId, e.name, e.role, e.base, e.allowances, e.deductions, e.bonus, e.adjustment, e.net, e.accountNumber, e.ifsc],
    });
  }
  await client.batch(statements, 'write');
  return getRun(runId);
}
async function deleteRun(runId) {
  await ready;
  await client.batch([
    { sql: 'DELETE FROM payroll_entries WHERE run_id=?', args: [runId] },
    { sql: 'DELETE FROM payroll_runs WHERE id=?', args: [runId] },
  ], 'write');
}
async function deleteEntry(runId, employeeId) {
  await ready;
  await client.execute({ sql: 'DELETE FROM payroll_entries WHERE run_id=? AND employee_id=?', args: [runId, employeeId] });
  const remaining = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM payroll_entries WHERE run_id=?', args: [runId] });
  if (Number(remaining.rows[0].c) === 0) await deleteRun(runId);
}
async function updateEntryStatus(runId, employeeId, { status, transferId, paidAt }) {
  await ready;
  await client.execute({
    sql: 'UPDATE payroll_entries SET status=?, transfer_id=?, paid_at=? WHERE run_id=? AND employee_id=?',
    args: [status, transferId || null, paidAt || null, runId, employeeId],
  });
}
async function getEntry(runId, employeeId) {
  await ready;
  const r = await client.execute({ sql: 'SELECT * FROM payroll_entries WHERE run_id=? AND employee_id=?', args: [runId, employeeId] });
  return rowToEntry(r.rows[0]);
}
function rowToEntry(r) {
  if (!r) return null;
  return {
    employeeId: r.employee_id, name: r.name, role: r.role, base: r.base, allowances: r.allowances,
    deductions: r.deductions, bonus: r.bonus, adjustment: r.adjustment, net: r.net,
    accountNumber: r.account_number, ifsc: r.ifsc, status: r.status, transferId: r.transfer_id, paidAt: r.paid_at,
  };
}

module.exports = {
  listEmployees, createEmployee, updateEmployee, deleteEmployee,
  listRuns, getRun, createRun, deleteRun, deleteEntry, updateEntryStatus, getEntry,
};
