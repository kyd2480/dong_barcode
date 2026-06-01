import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import cors from "cors";
import express from "express";
import multer from "multer";

const app = express();
const port = Number(process.env.PORT || 3000);
const storageRoot = path.resolve(
  process.env.CCTV_STORAGE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || "/app/data"
);
const videoDir = path.join(storageRoot, "videos");
const incomingDir = path.join(storageRoot, "incoming");
const indexPath = path.join(storageRoot, "videos-index.json");
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((item) => item.trim()) }));
app.use(express.json({ limit: "1mb" }));

await fsp.mkdir(videoDir, { recursive: true });
await fsp.mkdir(incomingDir, { recursive: true });

const upload = multer({
  dest: incomingDir,
  limits: { fileSize: Number(process.env.CCTV_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024) },
});

function sanitizePart(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
  return cleaned || fallback;
}

function compact(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

async function readIndex() {
  try {
    return JSON.parse(await fsp.readFile(indexPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeIndex(items) {
  const tempPath = `${indexPath}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(items, null, 2), "utf8");
  await fsp.rename(tempPath, indexPath);
}

function getMimeType(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  return "application/octet-stream";
}

function isDirectBrowserVideo(item) {
  if (item.extension === ".webm") return true;
  return item.extension === ".mp4" && process.env.CCTV_DIRECT_MP4 === "1";
}


async function findVideo(id) {
  const items = await readIndex();
  const item = items.find((entry) => entry.id === id);
  if (!item) return null;
  const absolutePath = path.resolve(videoDir, item.storedName);
  if (!absolutePath.startsWith(videoDir)) return null;
  return { item, absolutePath };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, storageRoot, videoDir });
});

app.post("/api/videos/upload", upload.single("video"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "video file is required" });

    const originalName = req.file.originalname || "recording";
    const extension = path.extname(originalName).toLowerCase() || ".mp4";
    const invoiceNumber = sanitizePart(req.body.invoiceNumber || path.basename(originalName, extension), "UNKNOWN");
    const id = crypto.randomUUID();
    const storedName = `${invoiceNumber}_${Date.now()}_${id}${extension}`;
    const targetPath = path.join(videoDir, storedName);

    await fsp.mkdir(videoDir, { recursive: true });
    await fsp.mkdir(incomingDir, { recursive: true });
    await fsp.rename(req.file.path, targetPath);

    const stat = await fsp.stat(targetPath);
    const item = {
      id,
      invoiceNumber,
      originalName,
      storedName,
      fileName: storedName,
      extension,
      mimeType: getMimeType(storedName),
      size: stat.size,
      uploadedAt: new Date().toISOString(),
    };
    const items = await readIndex();
    items.unshift(item);
    await writeIndex(items);

    res.status(201).json(item);
  } catch (error) {
    if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
    next(error);
  }
});

app.get("/api/videos", async (req, res, next) => {
  try {
    const query = compact(req.query.invoice || req.query.q || "");
    const items = await readIndex();
    const filtered = query
      ? items.filter((item) => compact(item.invoiceNumber).includes(query) || compact(item.fileName).includes(query))
      : items.slice(0, 100);
    res.json({ items: filtered.slice(0, 100) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/videos/:id/download", async (req, res, next) => {
  try {
    const found = await findVideo(req.params.id);
    if (!found) return res.status(404).json({ error: "video not found" });
    res.download(found.absolutePath, found.item.fileName);
  } catch (error) {
    next(error);
  }
});

app.get("/api/videos/:id/stream", async (req, res, next) => {
  try {
    const found = await findVideo(req.params.id);
    if (!found) return res.status(404).json({ error: "video not found" });
    const { item, absolutePath } = found;

    if (isDirectBrowserVideo(item) && req.query.transcode !== "1") {
      const stat = await fsp.stat(absolutePath);
      const range = req.headers.range;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", item.mimeType || getMimeType(item.fileName));
      if (!range) {
        res.setHeader("Content-Length", stat.size);
        return fs.createReadStream(absolutePath).pipe(res);
      }

      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (!match) return res.status(416).end();
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) return res.status(416).end();
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Content-Length", end - start + 1);
      return fs.createReadStream(absolutePath, { start, end }).pipe(res);
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      absolutePath,
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ]);

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on("data", (chunk) => console.error(String(chunk)));
    req.on("close", () => ffmpeg.kill("SIGKILL"));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "server error" });
});

const server = process.env.CCTV_NO_LISTEN === "1"
  ? null
  : app.listen(port, () => {
      console.log(`Dongtan CCTV server listening on ${port}`);
      console.log(`Storage root: ${storageRoot}`);
    });

export { app, server, storageRoot, videoDir };

