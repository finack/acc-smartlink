import Database from "better-sqlite3";
import path from "path";

// Database file location (in project root, or configurable via env)
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "spa-data.db");

// Initialize database
const db = new Database(DB_PATH);

// Create tables if they don't exist
// Note: We keep 'aux_hi' column name for backward compatibility with existing databases
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    timestamp INTEGER PRIMARY KEY,
    temperature REAL,
    heating INTEGER,
    jets_lo INTEGER,
    jets_hi INTEGER,
    aux_hi INTEGER,
    filtering INTEGER,
    light_on INTEGER,
    edit INTEGER,
    am INTEGER,
    overheat INTEGER,
    jets2_hi INTEGER,
    jets2_lo INTEGER,
    aux_lo INTEGER
  )
`);

// Migration: Add new columns if they don't exist (for existing databases)
const tableInfo = db.pragma('table_info(readings)') as Array<{ name: string }>;
const columns = tableInfo.map((c) => c.name);
if (!columns.includes('overheat')) {
  db.exec('ALTER TABLE readings ADD COLUMN overheat INTEGER DEFAULT 0');
}
if (!columns.includes('jets2_hi')) {
  db.exec('ALTER TABLE readings ADD COLUMN jets2_hi INTEGER DEFAULT 0');
}
if (!columns.includes('jets2_lo')) {
  db.exec('ALTER TABLE readings ADD COLUMN jets2_lo INTEGER DEFAULT 0');
}
if (!columns.includes('aux_lo')) {
  db.exec('ALTER TABLE readings ADD COLUMN aux_lo INTEGER DEFAULT 0');
}

// Create index for time-based queries
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp)
`);

export interface Reading {
  timestamp: number;
  temperature: number | null;
  heating: boolean;
  jetsLo: boolean;
  jetsHi: boolean;
  auxHi: boolean;
  filtering: boolean;
  lightOn: boolean;
  edit: boolean;
  am: boolean;
  overheat: boolean;
  jets2Hi: boolean;
  jets2Lo: boolean;
  auxLo: boolean;
}

export interface SpaStateForDb {
  currentTemp: number | null;
  heating: boolean;
  jetsLo: boolean;
  jetsHi: boolean;
  auxHi: boolean;
  filtering: boolean;
  lightOn: boolean;
  edit: boolean;
  overheat: boolean;
  jets2Hi: boolean;
  jets2Lo: boolean;
  auxLo: boolean;
}

// Prepared statements for performance
// Note: aux_hi column stores auxHi data (kept for backward compatibility)
const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO readings (timestamp, temperature, heating, jets_lo, jets_hi, aux_hi, filtering, light_on, edit, am, overheat, jets2_hi, jets2_lo, aux_lo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getReadingsStmt = db.prepare(`
  SELECT timestamp, temperature, heating, jets_lo, jets_hi, aux_hi, filtering, light_on, edit, am, overheat, jets2_hi, jets2_lo, aux_lo
  FROM readings
  WHERE timestamp >= ? AND timestamp <= ?
  ORDER BY timestamp ASC
`);

const getLatestStmt = db.prepare(`
  SELECT timestamp, temperature, heating, jets_lo, jets_hi, aux_hi, filtering, light_on, edit, am, overheat, jets2_hi, jets2_lo, aux_lo
  FROM readings
  ORDER BY timestamp DESC
  LIMIT 1
`);

/**
 * Insert a reading into the database
 */
export function insertReading(state: SpaStateForDb, am: boolean = false): void {
  const timestamp = Date.now();
  insertStmt.run(
    timestamp,
    state.currentTemp,
    state.heating ? 1 : 0,
    state.jetsLo ? 1 : 0,
    state.jetsHi ? 1 : 0,
    state.auxHi ? 1 : 0,
    state.filtering ? 1 : 0,
    state.lightOn ? 1 : 0,
    state.edit ? 1 : 0,
    am ? 1 : 0,
    state.overheat ? 1 : 0,
    state.jets2Hi ? 1 : 0,
    state.jets2Lo ? 1 : 0,
    state.auxLo ? 1 : 0
  );
}

/**
 * Get readings within a time range
 */
export function getReadings(fromTimestamp: number, toTimestamp: number): Reading[] {
  const rows = getReadingsStmt.all(fromTimestamp, toTimestamp) as Array<{
    timestamp: number;
    temperature: number | null;
    heating: number;
    jets_lo: number;
    jets_hi: number;
    aux_hi: number;
    filtering: number;
    light_on: number;
    edit: number;
    am: number;
    overheat: number;
    jets2_hi: number;
    jets2_lo: number;
    aux_lo: number;
  }>;

  return rows.map((row) => ({
    timestamp: row.timestamp,
    temperature: row.temperature,
    heating: row.heating === 1,
    jetsLo: row.jets_lo === 1,
    jetsHi: row.jets_hi === 1,
    auxHi: row.aux_hi === 1,  // aux_hi column maps to auxHi
    filtering: row.filtering === 1,
    lightOn: row.light_on === 1,
    edit: row.edit === 1,
    am: row.am === 1,
    overheat: row.overheat === 1,
    jets2Hi: row.jets2_hi === 1,
    jets2Lo: row.jets2_lo === 1,
    auxLo: row.aux_lo === 1,
  }));
}

/**
 * Get readings for a time range string (e.g., "1h", "24h", "7d", "30d")
 */
export function getReadingsForRange(range: string): Reading[] {
  const now = Date.now();
  let fromTimestamp: number;

  switch (range) {
    case "1h":
      fromTimestamp = now - 60 * 60 * 1000;
      break;
    case "24h":
      fromTimestamp = now - 24 * 60 * 60 * 1000;
      break;
    case "7d":
      fromTimestamp = now - 7 * 24 * 60 * 60 * 1000;
      break;
    case "30d":
      fromTimestamp = now - 30 * 24 * 60 * 60 * 1000;
      break;
    default:
      fromTimestamp = now - 24 * 60 * 60 * 1000; // Default to 24h
  }

  return getReadings(fromTimestamp, now);
}

/**
 * Get the most recent reading
 */
export function getLatestReading(): Reading | null {
  const row = getLatestStmt.get() as {
    timestamp: number;
    temperature: number | null;
    heating: number;
    jets_lo: number;
    jets_hi: number;
    aux_hi: number;
    filtering: number;
    light_on: number;
    edit: number;
    am: number;
    overheat: number;
    jets2_hi: number;
    jets2_lo: number;
    aux_lo: number;
  } | undefined;

  if (!row) return null;

  return {
    timestamp: row.timestamp,
    temperature: row.temperature,
    heating: row.heating === 1,
    jetsLo: row.jets_lo === 1,
    jetsHi: row.jets_hi === 1,
    auxHi: row.aux_hi === 1,  // aux_hi column maps to auxHi
    filtering: row.filtering === 1,
    lightOn: row.light_on === 1,
    edit: row.edit === 1,
    am: row.am === 1,
    overheat: row.overheat === 1,
    jets2Hi: row.jets2_hi === 1,
    jets2Lo: row.jets2_lo === 1,
    auxLo: row.aux_lo === 1,
  };
}

/**
 * Close the database connection (for graceful shutdown)
 */
export function closeDatabase(): void {
  db.close();
}
