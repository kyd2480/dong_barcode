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
const firebaseStorageBucket = process.env.FIREBASE_STORAGE_BUCKET || "dongtantest4.firebasestorage.app";
const firebaseSignedUrlMinutes = Math.max(1, Number(process.env.FIREBASE_SIGNED_URL_MINUTES || 30));
const maxConcurrentVideoUploads = Math.max(1, Number(process.env.CCTV_MAX_CONCURRENT_UPLOADS || 1));
const uploadRetryAfterSeconds = Math.max(1, Number(process.env.CCTV_UPLOAD_RETRY_AFTER_SECONDS || 60));
const maxConcurrentVideoTranscodes = Math.max(1, Number(process.env.CCTV_MAX_CONCURRENT_TRANSCODES || 1));
const transcodeRetryAfterSeconds = Math.max(1, Number(process.env.CCTV_TRANSCODE_RETRY_AFTER_SECONDS || 30));
let activeVideoUploads = 0;
let activeVideoTranscodes = 0;
let firebaseBucketPromise = null;

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

function isFirebaseStorageItem(item) {
  return Boolean(item?.storageProvider === "firebase" && item?.storagePath);
}

function normalizeBranchKey(value) {
  return String(value || "").trim().toLowerCase();
}

function videoDatabaseBranchOf(item) {
  return normalizeBranchKey(item?.databaseBranch || item?.branch || "");
}

function sortVideosForStoragePriority(items, storageFirst) {
  if (!storageFirst) return items;
  return [...items].sort((a, b) => {
    const storageDelta = Number(isFirebaseStorageItem(b)) - Number(isFirebaseStorageItem(a));
    if (storageDelta) return storageDelta;
    return new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime();
  });
}

function hasFirebaseServiceAccountConfig() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  );
}

function parseFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"));
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    return JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
  }

  return null;
}

async function getFirebaseBucket() {
  if (firebaseBucketPromise) return firebaseBucketPromise;

  firebaseBucketPromise = (async () => {
    if (!firebaseStorageBucket) {
      throw new Error("FIREBASE_STORAGE_BUCKET is not configured");
    }

    const serviceAccount = parseFirebaseServiceAccount();
    if (!serviceAccount) {
      throw new Error(
        "Firebase service account is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_BASE64, or FIREBASE_SERVICE_ACCOUNT_PATH."
      );
    }

    const [{ getApps, initializeApp, cert }, { getStorage }] = await Promise.all([
      import("firebase-admin/app"),
      import("firebase-admin/storage"),
    ]);

    const appName = "cctv-storage";
    const app =
      getApps().find((candidate) => candidate.name === appName) ||
      initializeApp(
        {
          credential: cert(serviceAccount),
          storageBucket: firebaseStorageBucket,
        },
        appName
      );

    return getStorage(app).bucket(firebaseStorageBucket);
  })();

  return firebaseBucketPromise;
}

function buildFirebaseStoragePath(invoiceNumber, fileName, now = new Date()) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const extension = path.extname(fileName || "").toLowerCase() || ".mp4";
  const safeInvoice = sanitizePart(invoiceNumber, "UNKNOWN");
  const safeFileName = sanitizePart(path.basename(fileName || `recording${extension}`), `recording${extension}`);
  return `videos/${year}/${month}/${day}/${safeInvoice}_${Date.now()}_${crypto.randomUUID()}_${safeFileName}`;
}

async function getFirebaseReadUrl(item, disposition = "inline") {
  const bucket = await getFirebaseBucket();
  const file = bucket.file(item.storagePath);
  const expires = Date.now() + firebaseSignedUrlMinutes * 60 * 1000;
  const [url] = await file.getSignedUrl({
    action: "read",
    expires,
    responseDisposition: `${disposition}; filename="${encodeURIComponent(item.fileName || item.originalName || "video.mp4")}"`,
    responseType: item.mimeType || getMimeType(item.fileName || item.originalName || "video.mp4"),
  });
  return url;
}

async function streamFirebaseVideo(item, req, res) {
  const bucket = await getFirebaseBucket();
  const file = bucket.file(item.storagePath);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size || item.size || 0);
  const contentType = metadata.contentType || item.mimeType || getMimeType(item.fileName || item.originalName || "video.mp4");
  const range = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=300");

  if (range && size > 0) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (!match) return res.status(416).end();
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : size - 1;
    if (start >= size || end >= size || start > end) return res.status(416).end();
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    return file.createReadStream({ start, end }).pipe(res);
  }

  if (size > 0) res.setHeader("Content-Length", size);
  return file.createReadStream().pipe(res);
}

function isExpiredUploadedAt(value, now = Date.now()) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 && now - time > retentionMs;
}

function limitConcurrentVideoUploads(req, res, next) {
  if (activeVideoUploads >= maxConcurrentVideoUploads) {
    res.setHeader("Retry-After", String(uploadRetryAfterSeconds));
    return res.status(429).json({
      error: "too many video uploads",
      activeUploads: activeVideoUploads,
      maxConcurrentUploads: maxConcurrentVideoUploads,
      retryAfterSeconds: uploadRetryAfterSeconds,
    });
  }

  activeVideoUploads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeVideoUploads = Math.max(0, activeVideoUploads - 1);
  };

  res.once("finish", release);
  res.once("close", release);
  next();
}

function acquireVideoTranscode(res) {
  if (activeVideoTranscodes >= maxConcurrentVideoTranscodes) {
    res.setHeader("Retry-After", String(transcodeRetryAfterSeconds));
    res.status(429).json({
      error: "too many video transcodes",
      activeTranscodes: activeVideoTranscodes,
      maxConcurrentTranscodes: maxConcurrentVideoTranscodes,
      retryAfterSeconds: transcodeRetryAfterSeconds,
    });
    return null;
  }

  activeVideoTranscodes += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeVideoTranscodes = Math.max(0, activeVideoTranscodes - 1);
  };
}

async function cleanupExpiredVideos() {
  const now = Date.now();
  const items = await readIndex();
  const keep = [];
  const knownStoredNames = new Set();
  let deleted = 0;

  for (const item of items) {
    if (item.storedName) knownStoredNames.add(item.storedName);
    if (!isExpiredUploadedAt(item.uploadedAt, now)) {
      keep.push(item);
      continue;
    }

    if (isFirebaseStorageItem(item)) {
      try {
        const bucket = await getFirebaseBucket();
        await bucket.file(item.storagePath).delete({ ignoreNotFound: true });
        deleted += 1;
      } catch (error) {
        console.error(`Failed to delete expired Firebase video ${item.storagePath}:`, error);
      }
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
  if (isFirebaseStorageItem(item)) return { item, firebase: true };
  const absolutePath = path.resolve(videoDir, item.storedName);
  if (!absolutePath.startsWith(videoDir)) return null;
  return { item, absolutePath };
}

app.get("/health", (_req, res) => {
  const memoryUsage = process.memoryUsage();
  res.json({
    ok: true,
    storageRoot,
    videoDir,
    retentionDays,
    activeVideoUploads,
    maxConcurrentVideoUploads,
    activeVideoTranscodes,
    maxConcurrentVideoTranscodes,
    memoryUsage,
    firebaseStorageBucket,
    firebaseConfigured: hasFirebaseServiceAccountConfig(),
  });
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

app.post("/api/videos/upload", limitConcurrentVideoUploads, upload.single("video"), async (req, res, next) => {
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
      databaseBranch: normalizeBranchKey(req.body.databaseBranch),
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

app.post("/api/videos/firebase-upload-url", async (req, res, next) => {
  try {
    if (!hasFirebaseServiceAccountConfig()) {
      return res.status(503).json({ error: "Firebase Storage upload is not configured" });
    }

    const originalName = String(req.body.fileName || req.body.originalName || "recording.mp4").trim();
    const extension = path.extname(originalName).toLowerCase() || ".mp4";
    const invoiceNumber = sanitizePart(req.body.invoiceNumber || path.basename(originalName, extension), "UNKNOWN");
    const mimeType = String(req.body.mimeType || getMimeType(originalName)).trim() || "application/octet-stream";
    const storagePath = buildFirebaseStoragePath(invoiceNumber, originalName);
    const bucket = await getFirebaseBucket();
    const file = bucket.file(storagePath);
    const expires = Date.now() + firebaseSignedUrlMinutes * 60 * 1000;
    const [uploadUrl] = await file.getSignedUrl({
      action: "write",
      expires,
      contentType: mimeType,
    });

    res.json({
      uploadUrl,
      storagePath,
      bucket: firebaseStorageBucket,
      method: "PUT",
      expiresAt: new Date(expires).toISOString(),
      headers: {
        "Content-Type": mimeType,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/videos/firebase-complete", async (req, res, next) => {
  try {
    if (!hasFirebaseServiceAccountConfig()) {
      return res.status(503).json({ error: "Firebase Storage upload is not configured" });
    }

    cleanupExpiredVideos().catch((error) => console.error("Expired CCTV cleanup failed:", error));

    const storagePath = String(req.body.storagePath || "").trim();
    if (!storagePath) return res.status(400).json({ error: "storagePath is required" });

    const bucket = await getFirebaseBucket();
    const file = bucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: "uploaded Firebase file not found" });

    const [metadata] = await file.getMetadata();
    const originalName = String(req.body.originalName || req.body.fileName || path.basename(storagePath)).trim();
    const extension = path.extname(originalName).toLowerCase() || path.extname(storagePath).toLowerCase() || ".mp4";
    const invoiceNumber = sanitizePart(req.body.invoiceNumber || path.basename(originalName, extension), "UNKNOWN");
    const id = crypto.randomUUID();
    const item = {
      id,
      invoiceNumber,
      originalName,
      storedName: path.basename(storagePath),
      fileName: path.basename(storagePath),
      extension,
      mimeType: String(req.body.mimeType || metadata.contentType || getMimeType(originalName)),
      size: Number(metadata.size || req.body.size || 0),
      uploadedAt: new Date().toISOString(),
      storageProvider: "firebase",
      storageBucket: firebaseStorageBucket,
      storagePath,
      databaseBranch: normalizeBranchKey(req.body.databaseBranch),
    };

    const items = await readIndex();
    items.unshift(item);
    await writeIndex(items);

    res.status(201).json(item);
  } catch (error) {
    next(error);
  }
});

app.get("/api/videos", async (req, res, next) => {
  try {
    const query = compact(req.query.invoice || req.query.q || "");
    const databaseBranch = normalizeBranchKey(req.query.databaseBranch);
    const storageFirst = req.query.storageFirst === "1" || req.query.storageFirst === "true";
    const items = await readIndex();
    const branchFiltered = databaseBranch
      ? items.filter((item) => {
          const itemBranch = videoDatabaseBranchOf(item);
          return !itemBranch || itemBranch === databaseBranch;
        })
      : items.slice(0, 100);
    const filtered = query
      ? branchFiltered.filter((item) => compact(item.invoiceNumber).includes(query) || compact(item.fileName).includes(query))
      : branchFiltered;
    res.json({ items: sortVideosForStoragePriority(filtered, storageFirst).slice(0, 100) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/videos/:id/download", async (req, res, next) => {
  try {
    const found = await findVideo(req.params.id);
    if (!found) return res.status(404).json({ error: "video not found" });
    if (found.firebase) {
      return res.redirect(await getFirebaseReadUrl(found.item, "attachment"));
    }
    res.download(found.absolutePath, found.item.fileName);
  } catch (error) {
    next(error);
  }
});

app.get("/api/videos/:id/stream", async (req, res, next) => {
  try {
    const found = await findVideo(req.params.id);
    if (!found) return res.status(404).json({ error: "video not found" });
    if (found.firebase) {
      return streamFirebaseVideo(found.item, req, res);
    }
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

    const releaseTranscode = acquireVideoTranscode(res);
    if (!releaseTranscode) return;

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
    ffmpeg.on("error", (error) => {
      releaseTranscode();
      if (!res.headersSent) next(error);
      else res.destroy(error);
    });
    ffmpeg.on("close", releaseTranscode);
    res.once("finish", releaseTranscode);
    res.once("close", () => {
      releaseTranscode();
      if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
    });
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
