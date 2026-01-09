import express from "express";
import path from "path";
import { getReadingsForRange, getLatestReading } from "./database";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// Serve static files from public directory
app.use(express.static(path.join(process.cwd(), "public")));

// API: Get readings for a time range
app.get("/api/readings", (req, res) => {
  const range = (req.query.range as string) || "24h";
  const validRanges = ["1h", "24h", "7d", "30d"];

  if (!validRanges.includes(range)) {
    res.status(400).json({ error: "Invalid range. Use: 1h, 24h, 7d, 30d" });
    return;
  }

  const readings = getReadingsForRange(range);
  res.json(readings);
});

// API: Get latest reading from database
app.get("/api/current", (_req, res) => {
  const latest = getLatestReading();
  if (latest) {
    res.json(latest);
  } else {
    res.status(404).json({ error: "No readings available" });
  }
});

/**
 * Start the Express server
 */
export function startServer(): void {
  app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Dashboard server running at http://localhost:${PORT}`);
  });
}

export { app };
