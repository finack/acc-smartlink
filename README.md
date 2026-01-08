# ACC SmartLink Spa Monitor

A TypeScript client for monitoring ACC SmartLink spa controllers via WebSocket.

## Overview

ACC SmartLink spa controllers (WF-100/BWF-200 WiFi modules) communicate via WebSocket to the `accsmartlink.com` cloud service. This project reverse-engineers the protocol to enable local monitoring of spa temperature and status.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your spa token
npm start
```

Get your token from your accsmartlink.com URL:
```
https://accsmartlink.com/spa/{TOKEN}/app
```

## Protocol Documentation

### WebSocket Connection

```
URL: wss://accsmartlink.com/spa/{TOKEN}/wsb
```

The token is the unique identifier from your spa's web URL:
`https://accsmartlink.com/spa/{TOKEN}/app`

### Message Types

#### Display Message

```json
{"dsp":"XXYYZZ??AABB"}
```

A 12-character hex string representing the 7-segment display state and status indicators.

#### Connection Status

```json
{"stsR":1}
{"stsI":0}
```

Connection/ready status messages (not indicator status).

### Display Message Format

The `dsp` field contains 6 bytes (12 hex characters):

```
Byte:    [0]   [1]   [2]   [3]   [4]   [5]
         F/ind ones  tens  hund  stat1 stat2
Example: f1    3f    3f    06    04    10
         F     0     0     1     Lo    Light
         = 100°F, Jets Lo, Light On
```

| Byte | Description |
|------|-------------|
| 0 | Display mode indicator (0xF1 = temperature in °F) |
| 1 | Ones digit (7-segment encoded) |
| 2 | Tens digit (7-segment encoded) |
| 3 | Hundreds digit (7-segment encoded, 0x00 = blank) |
| 4 | Status byte 1 (heating, jets, aux) |
| 5 | Status byte 2 (light, other indicators) |

### 7-Segment Digit Encoding

| Hex | Digit | Binary |
|-----|-------|--------|
| 0x3F | 0 | 00111111 |
| 0x06 | 1 | 00000110 |
| 0x5B | 2 | 01011011 |
| 0x4F | 3 | 01001111 |
| 0x66 | 4 | 01100110 |
| 0x6D | 5 | 01101101 |
| 0x7D | 6 | 01111101 |
| 0x07 | 7 | 00000111 |
| 0x7F | 8 | 01111111 |
| 0x6F | 9 | 01101111 |

The high bit (0x80) is used as a colon/decimal indicator.

### 7-Segment Letter Encoding

| Hex | Letter | Usage |
|-----|--------|-------|
| 0x71/0xF1 | F | Fahrenheit indicator |
| 0x79 | E | ECOn (Economy) mode |
| 0x39 | C | ECOn (Economy) mode |
| 0x5C | o | ECOn (Economy) mode |
| 0x54 | n | ECOn (Economy) mode |

### Status Byte 1 (Byte 4)

| Bit | Value | Indicator |
|-----|-------|-----------|
| 0 | 0x01 | Heating |
| 1 | 0x02 | AUX Hi |
| 2 | 0x04 | Jets Lo |
| 3 | 0x08 | Jets Hi |
| 4 | 0x10 | Filtering |
| 5 | 0x20 | Edit (temp adjustment active) |
| 6 | 0x40 | (unknown - possibly AUX Lo, AUX II Lo/Hi, Overheat) |
| 7 | 0x80 | AM indicator |

### Status Byte 2 (Byte 5)

| Bit | Value | Indicator |
|-----|-------|-----------|
| 4 | 0x10 | Light On |
| other | ? | (unknown - possibly Overheat, Filtering) |

### Example Messages

| Message | Decoded |
|---------|---------|
| `f16f6f000000` | 99°F, no indicators |
| `f16f6f000400` | 99°F, Jets Lo |
| `f13f3f060000` | 100°F, no indicators |
| `f13f3f060400` | 100°F, Jets Lo |
| `f13f3f060800` | 100°F, Jets Hi |
| `f13f3f061400` | 100°F, Jets Lo, Filtering |
| `f13f3f060410` | 100°F, Jets Lo, Light On |
| `f17f6f000500` | 98°F, Heating, Jets Lo |
| `5bdb87000500` | Time 7:22, Heating, Jets Lo |
| `545c39790000` | ECOn (Economy) mode display |
| `000000000000` | Blank display |

### Physical Display Layout

```
┌───┐   ┌───┐   ┌───┐   ┌───┐
│ 1 │ . │ 2 │ : │ 3 │ · │ 4 │  AM    4x 7-segment digits
└───┘   └───┘   └───┘   └───┘  Edit
        dot    colon   dot

Heating   Lo      Lo      Lo    Overheat   ← LED indicators
  On      Hi      Hi      Hi    Filtering
───────────────────────────────────────────
 Light    AUX    Jets   AUX II    Set      ← Buttons
```

## Hardware

- **Controller**: ACC SmarTouch Digital (SMTD1000, SMTD1500, SMTD2000, SMTD3000)
- **WiFi Module**: WF-100 or BWF-200 (Bluetooth + WiFi)
- **Manufacturer**: Applied Computer Controls (ACC Spas)

## License

MIT
