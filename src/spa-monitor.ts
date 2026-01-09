import "dotenv/config";
import WebSocket from "ws";
import { insertReading, closeDatabase } from "./database";
import { startServer } from "./server";

// Configuration - loaded from .env file
const SPA_TOKEN = process.env.SPA_TOKEN;
if (!SPA_TOKEN) {
  console.error("Error: SPA_TOKEN not found in environment. Create a .env file with SPA_TOKEN=your_token");
  process.exit(1);
}
const WS_URL = `wss://accsmartlink.com/spa/${SPA_TOKEN}/wsb`;

// Collection settings
const POLLING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SAMPLE_COUNT = 3;
const COLLECTION_TIMEOUT_MS = 30000; // 30 second timeout for collection

// Valid temperature range for hot tub (Fahrenheit)
const MIN_VALID_TEMP = 45;
const MAX_VALID_TEMP = 106;

// 7-segment display digit encoding (mask off 0x80 for colon/indicator bit)
const SEVEN_SEGMENT_DIGITS: Record<number, number> = {
  0x00: 0,  // blank can also represent 0 in some contexts
  0x3f: 0,
  0x06: 1,
  0x5b: 2,
  0x4f: 3,
  0x66: 4,
  0x6d: 5,
  0x7d: 6,
  0x07: 7,
  0x7f: 8,
  0x6f: 9,
};

// 7-segment letter patterns for mode detection
const SEVEN_SEGMENT_LETTERS: Record<number, string> = {
  0x79: "E",
  0x39: "C",
  0x5c: "o",
  0x54: "n",
  0x71: "F",
  0x76: "H",
  0x38: "L",
  0x3e: "U",
  0x73: "P",
};

// Known display patterns
const PATTERN_ECON = "545c3979";
const PATTERN_BLANK = "0000000000";

type DisplayType = "temp" | "time" | "eco" | "blank" | "heating" | "unknown";

interface DisplayResult {
  type: DisplayType;
  value: string;
  raw: string;
  temp?: number;
  statusByte1?: number;
  statusByte2?: number;
}

// Status flag bits in byte 4 of display message
const STATUS_HEATING   = 0x01;
const STATUS_AUX_HI    = 0x02;
const STATUS_JETS_LO   = 0x04;
const STATUS_JETS_HI   = 0x08;
const STATUS_FILTERING = 0x10;
const STATUS_EDIT      = 0x20;
const STATUS_OVERHEAT  = 0x40;
const STATUS_AM        = 0x80;

// Status flag bits in byte 5 of display message
const STATUS2_LIGHT    = 0x10;
const STATUS2_JETS2_HI = 0x20;
const STATUS2_JETS2_LO = 0x40;
const STATUS2_AUX_LO   = 0x80;

interface CollectionState {
  currentTemp: number | null;
  heating: boolean;
  auxHi: boolean;
  jetsLo: boolean;
  jetsHi: boolean;
  filtering: boolean;
  lightOn: boolean;
  edit: boolean;
  overheat: boolean;
  jets2Hi: boolean;
  jets2Lo: boolean;
  auxLo: boolean;
  lastStatusByte1: number | null;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${formatTimestamp()}] ${message}`);
}

function decodeDigit(byte: number): number | null {
  const masked = byte & 0x7f;
  return SEVEN_SEGMENT_DIGITS[masked] ?? null;
}

function decodeLetter(byte: number): string | null {
  const masked = byte & 0x7f;
  return SEVEN_SEGMENT_LETTERS[masked] ?? null;
}

function parseDisplayData(hexString: string): DisplayResult {
  const bytes: number[] = [];
  for (let i = 0; i < hexString.length; i += 2) {
    bytes.push(parseInt(hexString.substring(i, i + 2), 16));
  }

  const raw = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const prefix = hexString.substring(0, 10).toLowerCase();

  if (prefix === PATTERN_BLANK || hexString === "000000000010") {
    return { type: "blank", value: "", raw };
  }

  if (hexString.substring(0, 8).toLowerCase() === PATTERN_ECON.toLowerCase()) {
    return { type: "eco", value: "ECOn", raw, statusByte1: bytes[4], statusByte2: bytes[5] };
  }

  const letters = bytes.slice(0, 4).map((b) => decodeLetter(b)).filter((l) => l !== null);
  if (letters.length >= 2) {
    const text = letters.reverse().join("");
    if (["HI", "LO", "ON", "OFF", "ECO"].includes(text.toUpperCase())) {
      return { type: "unknown", value: text, raw };
    }
  }

  if ((bytes[0] & 0x7f) === 0x71) {
    const statusByte1 = bytes[4];
    const statusByte2 = bytes[5];

    const hundredsDigit = decodeDigit(bytes[3]);
    const tensDigit = decodeDigit(bytes[2]);
    const onesDigit = decodeDigit(bytes[1]);

    if (hundredsDigit === 1 && tensDigit !== null && onesDigit !== null) {
      const temp = 100 + tensDigit * 10 + onesDigit;
      if (temp >= 100 && temp <= MAX_VALID_TEMP) {
        return { type: "temp", value: `${temp}°F`, raw, temp, statusByte1, statusByte2 };
      }
    }

    if (tensDigit !== null && onesDigit !== null) {
      const temp = tensDigit * 10 + onesDigit;
      if (temp >= MIN_VALID_TEMP && temp <= 99) {
        return { type: "temp", value: `${temp}°F`, raw, temp, statusByte1, statusByte2 };
      }
    }
  }

  const d0 = decodeDigit(bytes[0]);
  const d1 = decodeDigit(bytes[1]);
  const d2 = decodeDigit(bytes[2]);
  const d3 = decodeDigit(bytes[3]);
  const statusByte1 = bytes[4];
  const statusByte2 = bytes[5];

  if (d0 !== null && d1 !== null && d2 !== null) {
    const minutes = d1 * 10 + d0;
    const hours = (d3 !== null && d3 > 0 ? d3 * 10 : 0) + d2;
    const amPm = (statusByte1 & STATUS_AM) !== 0 ? " AM" : "";
    const timeStr = `${hours}:${minutes.toString().padStart(2, "0")}${amPm}`;
    return { type: "time", value: timeStr, raw, statusByte1, statusByte2 };
  }

  return { type: "unknown", value: hexString, raw, statusByte1, statusByte2 };
}

function updateStateFromDisplay(display: DisplayResult, state: CollectionState): void {
  if (display.statusByte1 !== undefined) {
    state.heating = (display.statusByte1 & STATUS_HEATING) !== 0;
    state.auxHi = (display.statusByte1 & STATUS_AUX_HI) !== 0;
    state.jetsLo = (display.statusByte1 & STATUS_JETS_LO) !== 0;
    state.jetsHi = (display.statusByte1 & STATUS_JETS_HI) !== 0;
    state.filtering = (display.statusByte1 & STATUS_FILTERING) !== 0;
    state.edit = (display.statusByte1 & STATUS_EDIT) !== 0;
    state.overheat = (display.statusByte1 & STATUS_OVERHEAT) !== 0;
    state.lastStatusByte1 = display.statusByte1;
  }

  if (display.statusByte2 !== undefined) {
    state.lightOn = (display.statusByte2 & STATUS2_LIGHT) !== 0;
    state.jets2Hi = (display.statusByte2 & STATUS2_JETS2_HI) !== 0;
    state.jets2Lo = (display.statusByte2 & STATUS2_JETS2_LO) !== 0;
    state.auxLo = (display.statusByte2 & STATUS2_AUX_LO) !== 0;
  }

  if (display.type === "temp" && display.temp !== undefined) {
    state.currentTemp = display.temp;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Connect to WebSocket, collect temperature samples, write to DB, disconnect
 */
async function collectReading(): Promise<void> {
  return new Promise((resolve, reject) => {
    const samples: number[] = [];
    const state: CollectionState = {
      currentTemp: null,
      heating: false,
      auxHi: false,
      jetsLo: false,
      jetsHi: false,
      filtering: false,
      lightOn: false,
      edit: false,
      overheat: false,
      jets2Hi: false,
      jets2Lo: false,
      auxLo: false,
      lastStatusByte1: null,
    };

    log("Connecting for data collection...");

    const ws = new WebSocket(WS_URL, {
      headers: {
        "Origin": "https://accsmartlink.com",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });

    const timeout = setTimeout(() => {
      log("Collection timeout - closing connection");
      ws.close();
      // Still write what we have if we got any samples
      if (samples.length > 0) {
        writeReading(samples, state);
      }
      resolve();
    }, COLLECTION_TIMEOUT_MS);

    ws.on("open", () => {
      log("Connected - collecting samples...");
    });

    ws.on("message", (data) => {
      const message = data.toString();
      try {
        const parsed = JSON.parse(message);

        if (parsed.dsp) {
          let dspData = parsed.dsp;
          if (typeof dspData === 'string' && dspData.length === 10) {
            dspData = dspData + "00";
          }

          const display = parseDisplayData(dspData);
          updateStateFromDisplay(display, state);

          // Collect temperature samples
          if (display.type === "temp" && display.temp !== undefined) {
            samples.push(display.temp);
            log(`Sample ${samples.length}/${SAMPLE_COUNT}: ${display.temp}°F`);

            // Once we have enough samples, close and write
            if (samples.length >= SAMPLE_COUNT) {
              clearTimeout(timeout);
              ws.close();
              writeReading(samples, state);
              resolve();
            }
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.on("error", (error) => {
      log(`WebSocket error: ${error.message}`);
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function writeReading(samples: number[], state: CollectionState): void {
  const temp = median(samples);

  const reading = {
    currentTemp: temp,
    heating: state.heating,
    jetsLo: state.jetsLo,
    jetsHi: state.jetsHi,
    auxHi: state.auxHi,
    filtering: state.filtering,
    lightOn: state.lightOn,
    edit: state.edit,
    overheat: state.overheat,
    jets2Hi: state.jets2Hi,
    jets2Lo: state.jets2Lo,
    auxLo: state.auxLo,
  };

  const am = state.lastStatusByte1 !== null ? (state.lastStatusByte1 & STATUS_AM) !== 0 : false;

  insertReading(reading, am);
  log(`Logged: ${temp !== null ? temp + "°F" : "no temp"} (${samples.length} samples), heating: ${state.heating ? "ON" : "OFF"}`);
}

async function runCollection(): Promise<void> {
  try {
    await collectReading();
  } catch (error) {
    log(`Collection failed: ${error}`);
  }
}

let collectionInterval: NodeJS.Timeout | null = null;

function shutdown(): void {
  log("Shutting down...");
  if (collectionInterval) {
    clearInterval(collectionInterval);
  }
  closeDatabase();
  process.exit(0);
}

// Handle graceful shutdown
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the server and collection
log("ACC SmartLink Spa Monitor starting...");
startServer();

// Initial collection
runCollection();

// Schedule periodic collection
collectionInterval = setInterval(runCollection, POLLING_INTERVAL_MS);
