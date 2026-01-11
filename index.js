const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");

const app = express();

// ---------------- ENV ----------------
const PORT = process.env.PORT || 3000;

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const AZURE_STORAGE_CONNECTION_STRING =
  process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION;

const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || "images";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME || "mediasharedb";

const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || "photos";
const COSMOS_COMMENT_CONTAINER = process.env.COSMOS_COMMENT_CONTAINER || "comments";
const COSMOS_RATINGS_CONTAINER = process.env.COSMOS_RATINGS_CONTAINER || "ratings";

// ---------------- MIDDLEWARE ----------------
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(express.json());

// upload memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ---------------- CLIENTS ----------------
function requireEnv(name, value) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

function getCosmos() {
  requireEnv("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
  requireEnv("COSMOS_KEY", COSMOS_KEY);

  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const db = client.database(COSMOS_DB_NAME);

  return {
    photos: db.container(COSMOS_CONTAINER),
    comments: db.container(COSMOS_COMMENT_CONTAINER),
    ratings: db.container(COSMOS_RATINGS_CONTAINER)
  };
}

function getBlobContainer() {
  requireEnv("AZURE_STORAGE_CONNECTION_STRING", AZURE_STORAGE_CONNECTION_STRING);
  const blobService = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  return blobService.getContainerClient(BLOB_CONTAINER_NAME);
}

function nowISO() {
  return new Date().toISOString();
}

function peopleList(peopleStr) {
  if (!peopleStr) return [];
  return String(peopleStr)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 30);
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => res.send("MediaRG API is running ✅"));

// OPTIONAL: debug env (does not leak secrets)
app.get("/api/_debug/env", (req, res) => {
  res.json({
    CORS_ORIGIN,
    BLOB_CONTAINER_NAME,
    COSMOS_DB_NAME,
    COSMOS_CONTAINER,
    COSMOS_COMMENT_CONTAINER,
    COSMOS_RATINGS_CONTAINER,
    HAS_STORAGE: !!AZURE_STORAGE_CONNECTION_STRING,
    HAS_COSMOS_ENDPOINT: !!COSMOS_ENDPOINT,
    HAS_COSMOS_KEY: !!COSMOS_KEY
  });
});

// -------- PHOTOS --------

// GET all photos
app.get("/api/photos", async (req, res) => {
  try {
    const { photos } = getCosmos();
    const { resources } = await photos.items
      .query("SELECT * FROM c ORDER BY c.createdAt DESC", { enableCrossPartitionQuery: true })
      .fetchAll();

    res.json(resources || []);
  } catch (err) {
    console.error("GET /api/photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET photo by id (query to avoid partition key mismatch)
app.get("/api/photos/:id", async (req, res) => {
  try {
    const { photos } = getCosmos();
    const id = String(req.params.id);

    const querySpec = {
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }]
    };

    const { resources } = await photos.items
      .query(querySpec, { enableCrossPartitionQuery: true })
      .fetchAll();

    const photo = resources?.[0];
    if (!photo) return res.status(404).json({ error: "Photo not found" });

    res.json(photo);
  } catch (err) {
    console.error("GET /api/photos/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST upload photo (file + metadata) -> Blob + Cosmos
app.post("/api/photos", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const title = String(req.body?.title || "").trim();

    if (!file) return res.status(400).json({ error: "file is required" });
    if (!title) return res.status(400).json({ error: "title is required" });

    const caption = String(req.body?.caption || "").trim();
    const location = String(req.body?.location || "").trim();
    const people = peopleList(req.body?.people);

    // upload blob
    const container = getBlobContainer();
    await container.createIfNotExists({ access: "blob" });

    const photoId = String(Date.now());
    const ext = (file.originalname || "jpg").split(".").pop() || "jpg";
    const blobName = `${photoId}.${ext}`;

    const blobClient = container.getBlockBlobClient(blobName);
    await blobClient.uploadData(file.buffer, {
      blobHTTPHeaders: { blobContentType: file.mimetype || "image/jpeg" }
    });

    const url = blobClient.url;

    // save cosmos metadata
    const { photos } = getCosmos();
    const doc = {
      id: photoId,
      photoId,
      title,
      caption,
      location,
      people,
      url,
      blobName,
      createdAt: nowISO()
    };

    await photos.items.upsert(doc);

    res.status(201).json(doc);
  } catch (err) {
    console.error("POST /api/photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------- COMMENTS --------

// GET comments
app.get("/api/photos/:id/comments", async (req, res) => {
  try {
    const { comments } = getCosmos();
    const photoId = String(req.params.id);

    const querySpec = {
      query: "SELECT * FROM c WHERE c.photoId = @photoId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@photoId", value: photoId }]
    };

    const { resources } = await comments.items
      .query(querySpec, { enableCrossPartitionQuery: true })
      .fetchAll();

    res.json(resources || []);
  } catch (err) {
    console.error("GET comments error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST comment
app.post("/api/photos/:id/comments", async (req, res) => {
  try {
    const { comments } = getCosmos();
    const photoId = String(req.params.id);

    const name = String(req.body?.name || "").trim().slice(0, 80) || "Anonymous";
    const text = String(req.body?.text || "").trim().slice(0, 1000);

    if (!text) return res.status(400).json({ error: "text is required" });

    const doc = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      photoId,
      name,
      text,
      createdAt: nowISO()
    };

    // if your comments container is partitioned by /photoId, this helps
    try {
      await comments.items.create(doc);
    } catch {
      await comments.items.create(doc, { partitionKey: photoId });
    }

    res.status(201).json(doc);
  } catch (err) {
    console.error("POST comment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------- RATINGS (FIXED for partition key /photoId) --------

// POST rating
app.post("/api/photos/:id/rating", async (req, res) => {
  try {
    const { ratings } = getCosmos();
    const photoId = String(req.params.id);

    const value = Number(req.body?.value);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      return res.status(400).json({ error: "Rating must be 1..5" });
    }

    const userKey = String(req.body?.userKey || "anon").slice(0, 120);

    // one rating per user per photo
    const id = `${photoId}::${userKey}`;

    const doc = {
      id,
      photoId, // ✅ REQUIRED because your partition key is /photoId
      userKey,
      value,
      updatedAt: nowISO()
    };

    // ✅ REQUIRED because your ratings partition key is /photoId
    await ratings.items.upsert(doc, { partitionKey: photoId });

    res.status(201).json({ message: "Rating saved", rating: doc });
  } catch (err) {
    console.error("POST rating error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET rating summary
app.get("/api/photos/:id/rating", async (req, res) => {
  try {
    const { ratings } = getCosmos();
    const photoId = String(req.params.id);

    const querySpec = {
      query: `
        SELECT VALUE { "count": COUNT(1), "avg": AVG(c.value) }
        FROM c
        WHERE c.photoId = @photoId
      `,
      parameters: [{ name: "@photoId", value: photoId }]
    };

    const { resources } = await ratings.items
      .query(querySpec, { enableCrossPartitionQuery: true })
      .fetchAll();

    const agg = resources?.[0] || { count: 0, avg: 0 };
    const count = Number(agg.count || 0);
    const average = count > 0 ? Number(Number(agg.avg).toFixed(2)) : 0;

    res.json({ photoId, count, average });
  } catch (err) {
    console.error("GET rating error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- START ----------------
app.listen(PORT, () => console.log(`API running on port ${PORT}`));

