import "dotenv/config";
import WebSocket from "ws";

// Configuration - loaded from .env file
const SPA_TOKEN = process.env.SPA_TOKEN;
if (!SPA_TOKEN) {
  console.error("Error: SPA_TOKEN not found in environment. Create a .env file with SPA_TOKEN=your_token");
  process.exit(1);
}
const WS_URL = `wss://accsmartlink.com/spa/${SPA_TOKEN}/wsb`;

// Reconnection settings
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

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
  0x54: "n", // or could be other
  0x71: "F",
  0x76: "H",
  0x38: "L",
  0x3e: "U",
  0x73: "P",
};

// Known display patterns
const PATTERN_ECON = "545c3979"; // "ECon" (Economy mode) - first 4 bytes
const PATTERN_BLANK = "0000000000";

type DisplayType = "temp" | "time" | "eco" | "blank" | "heating" | "unknown";

interface DisplayResult {
  type: DisplayType;
  value: string;
  raw: string;
  temp?: number;
  statusByte1?: number;  // Byte 4: Heating, Jets, AUX
  statusByte2?: number;  // Byte 5: Light, other indicators
}

// Status flag bits in byte 4 of display message
const STATUS_HEATING   = 0x01;  // Bit 0 - Heating indicator
const STATUS_AUX_HI    = 0x02;  // Bit 1 - AUX Hi (needs verification)
const STATUS_JETS_LO   = 0x04;  // Bit 2 - Jets Lo (confirmed)
const STATUS_JETS_HI   = 0x08;  // Bit 3 - Jets Hi (confirmed)
const STATUS_FILTERING = 0x10;  // Bit 4 - Filtering (confirmed)
const STATUS_SET_MODE  = 0x20;  // Bit 5 - Set/adjust mode active (confirmed)
const STATUS_AM        = 0x80;  // Bit 7 - AM indicator (confirmed)
// Bit 6 (0x40): unknown - possibly AUX Lo, AUX II Lo/Hi, or Overheat

// Status flag bits in byte 5 of display message
const STATUS2_LIGHT = 0x10;  // Bit 4 - Light On indicator (confirmed)

interface SpaState {
  currentTemp: number | null;
  lastTempUpdate: Date | null;
  ecoMode: boolean;
  lightOn: boolean;     // from status byte 2 bit 4
  heating: boolean;     // from status byte 1 bit 0
  auxHi: boolean;       // from status byte 1 bit 1
  jetsLo: boolean;      // from status byte 1 bit 2
  jetsHi: boolean;      // from status byte 1 bit 3
  filtering: boolean;   // from status byte 1 bit 4
  setMode: boolean;     // from status byte 1 bit 5
  lastStatusByte1: number | null;
  lastStatusByte2: number | null;
  stsI: number | null;
}

let reconnectAttempts = 0;
let ws: WebSocket | null = null;
const state: SpaState = {
  currentTemp: null,
  lastTempUpdate: null,
  ecoMode: false,
  lightOn: false,
  heating: false,
  auxHi: false,
  jetsLo: false,
  jetsHi: false,
  filtering: false,
  setMode: false,
  lastStatusByte1: null,
  lastStatusByte2: null,
  stsI: null,
};

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${formatTimestamp()}] ${message}`);
}

function decodeDigit(byte: number): number | null {
  // Mask off the 0x80 bit (colon/decimal indicator)
  const masked = byte & 0x7f;
  return SEVEN_SEGMENT_DIGITS[masked] ?? null;
}

function decodeLetter(byte: number): string | null {
  const masked = byte & 0x7f;
  return SEVEN_SEGMENT_LETTERS[masked] ?? null;
}

function parseDisplayData(hexString: string): DisplayResult {
  // Convert hex string to bytes
  const bytes: number[] = [];
  for (let i = 0; i < hexString.length; i += 2) {
    bytes.push(parseInt(hexString.substring(i, i + 2), 16));
  }

  const raw = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const prefix = hexString.substring(0, 10).toLowerCase();

  // Check for blank display
  if (prefix === PATTERN_BLANK || hexString === "000000000010") {
    return { type: "blank", value: "", raw };
  }

  // Check for ECON (Economy) mode pattern
  if (hexString.substring(0, 8).toLowerCase() === PATTERN_ECON.toLowerCase()) {
    return { type: "eco", value: "ECOn", raw, statusByte1: bytes[4], statusByte2: bytes[5] };
  }

  // Try to decode as letters (for modes like "HI", "LO", etc.)
  const letters = bytes.slice(0, 4).map((b) => decodeLetter(b)).filter((l) => l !== null);
  if (letters.length >= 2) {
    const text = letters.reverse().join("");
    if (["HI", "LO", "ON", "OFF", "ECO"].includes(text.toUpperCase())) {
      return { type: "unknown", value: text, raw };
    }
  }

  // Check for temperature with 0xF1 indicator (F for Fahrenheit)
  if ((bytes[0] & 0x7f) === 0x71) {
    const statusByte1 = bytes[4];
    const statusByte2 = bytes[5];

    // Check for 3-digit temp (100+): byte 3 is hundreds, byte 2 is tens, byte 1 is ones
    const hundredsDigit = decodeDigit(bytes[3]);
    const tensDigit = decodeDigit(bytes[2]);
    const onesDigit = decodeDigit(bytes[1]);

    if (hundredsDigit === 1 && tensDigit !== null && onesDigit !== null) {
      // 3-digit temperature (100-106°F)
      const temp = 100 + tensDigit * 10 + onesDigit;
      if (temp >= 100 && temp <= MAX_VALID_TEMP) {
        return { type: "temp", value: `${temp}°F`, raw, temp, statusByte1, statusByte2 };
      }
    }

    // 2-digit temperature (45-99°F): byte 2 is tens, byte 1 is ones
    if (tensDigit !== null && onesDigit !== null) {
      const temp = tensDigit * 10 + onesDigit;
      if (temp >= MIN_VALID_TEMP && temp <= 99) {
        return { type: "temp", value: `${temp}°F`, raw, temp, statusByte1, statusByte2 };
      }
    }
  }

  // Try to decode as time (3 or 4 digits for H:MM or HH:MM)
  const d0 = decodeDigit(bytes[0]);  // ones of minutes
  const d1 = decodeDigit(bytes[1]);  // tens of minutes
  const d2 = decodeDigit(bytes[2]);  // ones of hours
  const d3 = decodeDigit(bytes[3]);  // tens of hours (may be 0 or blank)
  const statusByte1 = bytes[4];
  const statusByte2 = bytes[5];

  if (d0 !== null && d1 !== null && d2 !== null) {
    // Build time string
    const minutes = d1 * 10 + d0;
    const hours = (d3 !== null && d3 > 0 ? d3 * 10 : 0) + d2;
    const amPm = (statusByte1 & STATUS_AM) !== 0 ? " AM" : "";
    const timeStr = `${hours}:${minutes.toString().padStart(2, "0")}${amPm}`;
    return { type: "time", value: timeStr, raw, statusByte1, statusByte2 };
  }

  return { type: "unknown", value: hexString, raw, statusByte1, statusByte2 };
}

function parseMessage(data: WebSocket.RawData): void {
  const message = data.toString();

  try {
    const parsed = JSON.parse(message);

    // Handle status messages (stsR/stsI are connection status, not light status)
    if (parsed.stsR !== undefined) {
      log(`${message} -> Connection stsR: ${parsed.stsR}`);
    }
    if (parsed.stsI !== undefined && parsed.stsI !== state.stsI) {
      state.stsI = parsed.stsI;
      log(`${message} -> Connection stsI: ${parsed.stsI}`);
    }

    // Handle display messages
    if (parsed.dsp) {
      const display = parseDisplayData(parsed.dsp);
      const interpretations: string[] = [];

      // Parse status bytes for heating/jets/light status
      const statusChanged1 = display.statusByte1 !== undefined && display.statusByte1 !== state.lastStatusByte1;
      const statusChanged2 = display.statusByte2 !== undefined && display.statusByte2 !== state.lastStatusByte2;

      if (statusChanged1 || statusChanged2) {
        if (display.statusByte1 !== undefined) state.lastStatusByte1 = display.statusByte1;
        if (display.statusByte2 !== undefined) state.lastStatusByte2 = display.statusByte2;

        // Parse byte 4 (heating, aux, jets, filtering)
        if (display.statusByte1 !== undefined) {
          const heating = (display.statusByte1 & STATUS_HEATING) !== 0;
          const auxHi = (display.statusByte1 & STATUS_AUX_HI) !== 0;
          const jetsLo = (display.statusByte1 & STATUS_JETS_LO) !== 0;

          if (heating !== state.heating) {
            state.heating = heating;
            interpretations.push(`Heating: ${heating ? "ON" : "OFF"}`);
          }
          if (auxHi !== state.auxHi) {
            state.auxHi = auxHi;
            interpretations.push(`AUX Hi: ${auxHi ? "ON" : "OFF"}`);
          }
          if (jetsLo !== state.jetsLo) {
            state.jetsLo = jetsLo;
            interpretations.push(`Jets Lo: ${jetsLo ? "ON" : "OFF"}`);
          }
          const jetsHi = (display.statusByte1 & STATUS_JETS_HI) !== 0;
          if (jetsHi !== state.jetsHi) {
            state.jetsHi = jetsHi;
            interpretations.push(`Jets Hi: ${jetsHi ? "ON" : "OFF"}`);
          }
          const filtering = (display.statusByte1 & STATUS_FILTERING) !== 0;
          if (filtering !== state.filtering) {
            state.filtering = filtering;
            interpretations.push(`Filtering: ${filtering ? "ON" : "OFF"}`);
          }
          const setMode = (display.statusByte1 & STATUS_SET_MODE) !== 0;
          if (setMode !== state.setMode) {
            state.setMode = setMode;
            interpretations.push(`Set Mode: ${setMode ? "ON" : "OFF"}`);
          }
        }

        // Parse byte 5 (light)
        if (display.statusByte2 !== undefined) {
          const lightOn = (display.statusByte2 & STATUS2_LIGHT) !== 0;
          if (lightOn !== state.lightOn) {
            state.lightOn = lightOn;
            interpretations.push(`Light: ${lightOn ? "ON" : "OFF"}`);
          }
        }
      }

      switch (display.type) {
        case "temp":
          if (display.temp !== undefined) {
            if (display.temp !== state.currentTemp) {
              state.currentTemp = display.temp;
              state.lastTempUpdate = new Date();
            }
            interpretations.push(`Temp: ${display.value}`);
          }
          break;

        case "eco":
          if (!state.ecoMode) {
            state.ecoMode = true;
          }
          interpretations.push(`Mode: ECOn`);
          break;

        case "blank":
          interpretations.push(`Blank`);
          break;

        case "time":
          interpretations.push(`Time: ${display.value}`);
          break;

        default:
          interpretations.push(`Unknown: ${display.raw}`);
      }

      // Log every message with interpretation
      log(`${message} -> ${interpretations.join(" | ")}`);
    }
  } catch {
    log(`${message} -> Non-JSON message`);
  }
}

function connect(): void {
  log(`Connecting to ${WS_URL}`);

  ws = new WebSocket(WS_URL, {
    headers: {
      "Origin": "https://accsmartlink.com",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });

  ws.on("open", () => {
    log("Connected to ACC SmartLink WebSocket");
    reconnectAttempts = 0;

    // TODO: Send any initial handshake/subscription messages if required
    // ws.send(JSON.stringify({ type: "subscribe", ... }));
  });

  ws.on("message", (data) => {
    parseMessage(data);
  });

  ws.on("close", (code, reason) => {
    log(`Connection closed: ${code} - ${reason.toString()}`);
    scheduleReconnect();
  });

  ws.on("error", (error) => {
    log(`WebSocket error: ${error.message}`);
  });

  ws.on("ping", () => {
    log("Received ping");
  });

  ws.on("pong", () => {
    log("Received pong");
  });
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
    process.exit(1);
  }

  reconnectAttempts++;
  log(`Reconnecting in ${RECONNECT_DELAY_MS}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

  setTimeout(() => {
    connect();
  }, RECONNECT_DELAY_MS);
}

function shutdown(): void {
  log("Shutting down...");
  if (ws) {
    ws.close();
  }
  process.exit(0);
}

// Handle graceful shutdown
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the connection
log("ACC SmartLink Spa Monitor starting...");
connect();
