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
const desktopAppUpdateDir = path.join(storageRoot, "desktop-app");
const desktopAppUpdateManifestPath = path.join(desktopAppUpdateDir, "latest.json");
const corsOrigin = process.env.CORS_ORIGIN || "*";
const retentionDays = Math.max(1, Number(process.env.CCTV_RETENTION_DAYS || 30));
const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

app.set("trust proxy", true);
app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((item) => item.trim()) }));
app.use(express.json({ limit: "1mb" }));

await fsp.mkdir(videoDir, { recursive: true });
await fsp.mkdir(incomingDir, { recursive: true });
await fsp.mkdir(desktopAppUpdateDir, { recursive: true });

const upload = multer({
  dest: incomingDir,
  limits: { fileSize: Number(process.env.CCTV_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024) },
});
const desktopAppUpload = multer({
  dest: incomingDir,
  limits: { fileSize: Number(process.env.DESKTOP_APP_MAX_UPLOAD_BYTES || 200 * 1024 * 1024) },
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

async function readDesktopAppManifest() {
  try {
    return JSON.parse(await fsp.readFile(desktopAppUpdateManifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function getRequestBaseUrl(req) {
  const protocol = req.protocol || "https";
  return `${protocol}://${req.get("host")}`;
}

function getBearerToken(req) {
  const header = String(req.get("authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
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

function isExpiredUploadedAt(value, now = Date.now()) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 && now - time > retentionMs;
}

async function cleanupExpiredVideos() {
  const now = Date.now();
  const items = await readIndex();
  const keep = [];
  const knownStoredNames = new Set();
  let deleted = 0;

  for (const item of items) {
    knownStoredNames.add(item.storedName);
    if (!isExpiredUploadedAt(item.uploadedAt, now)) {
      keep.push(item);
      continue;
    }

    const absolutePath = path.resolve(videoDir, item.storedName);
    if (absolutePath.startsWith(videoDir)) {
      try {
        await fsp.unlink(absolutePath);
        deleted += 1;
      } catch (error) {
        if (error.code !== "ENOENT") console.error(`Failed to delete expired video ${item.storedName}:`, error);
      }
    }
  }

  let looseDeleted = 0;
  try {
    const files = await fsp.readdir(videoDir);
    for (const fileName of files) {
      if (knownStoredNames.has(fileName)) continue;
      const absolutePath = path.join(videoDir, fileName);
      const stat = await fsp.stat(absolutePath);
      if (!stat.isFile() || now - stat.mtimeMs <= retentionMs) continue;
      await fsp.unlink(absolutePath);
      looseDeleted += 1;
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Failed to scan loose video files:", error);
  }

  if (keep.length !== items.length) await writeIndex(keep);
  if (deleted || looseDeleted) {
    console.log(`Expired CCTV cleanup: indexDeleted=${deleted}, looseDeleted=${looseDeleted}, retentionDays=${retentionDays}`);
  }
  return { deleted, looseDeleted, retentionDays };
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
  res.json({ ok: true, storageRoot, videoDir, retentionDays });
});

app.get("/api/desktop-app/latest", async (req, res, next) => {
  try {
    const manifest = await readDesktopAppManifest();
    if (!manifest?.version || !manifest?.fileName) {
      return res.status(404).json({ error: "desktop app update is not configured" });
    }

    const appPath = path.resolve(desktopAppUpdateDir, manifest.fileName);
    if (!appPath.startsWith(desktopAppUpdateDir)) {
      return res.status(400).json({ error: "invalid update manifest" });
    }

    try {
      await fsp.access(appPath, fs.constants.R_OK);
    } catch {
      return res.status(404).json({ error: "desktop app update file not found" });
    }

    res.json({
      version: manifest.version,
      fileName: manifest.fileName,
      sha256: manifest.sha256 || "",
      mandatory: manifest.mandatory !== false,
      downloadUrl: `${getRequestBaseUrl(req)}/api/desktop-app/download`,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/desktop-app/download", async (_req, res, next) => {
  try {
    const manifest = await readDesktopAppManifest();
    if (!manifest?.fileName) {
      return res.status(404).json({ error: "desktop app update is not configured" });
    }

    const appPath = path.resolve(desktopAppUpdateDir, manifest.fileName);
    if (!appPath.startsWith(desktopAppUpdateDir)) {
      return res.status(400).json({ error: "invalid update manifest" });
    }

    res.download(appPath, manifest.fileName);
  } catch (error) {
    next(error);
  }
});

app.post("/api/desktop-app/upload", desktopAppUpload.single("app"), async (req, res, next) => {
  try {
    const token = process.env.DESKTOP_UPDATE_TOKEN || "";
    if (!token) return res.status(503).json({ error: "desktop update upload is disabled" });
    if (getBearerToken(req) !== token) return res.status(401).json({ error: "unauthorized" });
    if (!req.file) return res.status(400).json({ error: "app file is required" });

    const version = String(req.body.version || "").trim();
    if (!version) return res.status(400).json({ error: "version is required" });

    await fsp.mkdir(desktopAppUpdateDir, { recursive: true });
    const fileName = "BarcodeWebcamRecorder.exe";
    const targetPath = path.join(desktopAppUpdateDir, fileName);
    await fsp.rename(req.file.path, targetPath);

    const fileBuffer = await fsp.readFile(targetPath);
    const manifest = {
      version,
      fileName,
      sha256: crypto.createHash("sha256").update(fileBuffer).digest("hex"),
      mandatory: true,
      uploadedAt: new Date().toISOString(),
    };
    await fsp.writeFile(desktopAppUpdateManifestPath, JSON.stringify(manifest, null, 2), "utf8");
    res.status(201).json(manifest);
  } catch (error) {
    if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
    next(error);
  }
});

app.post("/api/videos/upload", upload.single("video"), async (req, res, next) => {
  try {
    cleanupExpiredVideos().catch((error) => console.error("Expired CCTV cleanup failed:", error));
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
    await cleanupExpiredVideos();
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

cleanupExpiredVideos().catch((error) => console.error("Expired CCTV cleanup failed:", error));
setInterval(() => {
  cleanupExpiredVideos().catch((error) => console.error("Expired CCTV cleanup failed:", error));
}, 6 * 60 * 60 * 1000).unref();

const server = process.env.CCTV_NO_LISTEN === "1"
  ? null
  : app.listen(port, () => {
      console.log(`Dongtan CCTV server listening on ${port}`);
      console.log(`Storage root: ${storageRoot}`);
    });

export { app, server, storageRoot, videoDir };



