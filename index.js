const express = require("express");
const cors = require("cors");
const multer = require("multer");

const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");

const app = express();

// ----- CORS -----
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin
  })
);

app.use(express.json());

// ----- Multer -----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ----- ENV -----
const AZURE_STORAGE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION;
const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || "images";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME || "mediasharedb";

const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || "photos";
const COSMOS_COMMENT_CONTAINER = process.env.COSMOS_COMMENT_CONTAINER || "comments";
const COSMOS_RATINGS_CONTAINER = process.env.COSMOS_RATINGS_CONTAINER || "ratings";

// ----- Helpers -----
function nowIso() {
  return new Date().toISOString();
}

function toPeopleArray(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

function cosmos() {
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

// ----- Root -----
app.get("/", (req, res) => {
  res.json({
    status: "MediaRG API is running ✅",
    corsOrigin: allowedOrigin,
    containers: {
      photos: COSMOS_CONTAINER,
      comments: COSMOS_COMMENT_CONTAINER,
      ratings: COSMOS_RATINGS_CONTAINER
    }
  });
});

// ----- PHOTOS: list -----
app.get("/api/photos", async (req, res) => {
  try {
    const { photos } = cosmos();
    const q = String(req.query.q || "").trim().toLowerCase();

    const querySpec = q
      ? {
          query: `
            SELECT * FROM c
            WHERE CONTAINS(LOWER(c.title), @q)
               OR CONTAINS(LOWER(c.caption), @q)
               OR CONTAINS(LOWER(c.location), @q)
            ORDER BY c.createdAt DESC
          `,
          parameters: [{ name: "@q", value: q }]
        }
      : { query: "SELECT * FROM c ORDER BY c.createdAt DESC" };

    const { resources } = await photos.items
      .query(querySpec, { enableCrossPartitionQuery: true })
      .fetchAll();

    res.json(resources);
  } catch (err) {
    console.error("GET /api/photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----- PHOTOS: by id -----
app.get("/api/photos/:id", async (req, res) => {
  try {
    const { photos } = cosmos();
    const id = String(req.params.id);

    const { resources } = await photos.items
      .query(
        {
          query: "SELECT * FROM c WHERE c.id=@id",
          parameters: [{ name: "@id", value: id }]
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    if (!resources.length) return res.status(404).json({ error: "Photo not found" });
    res.json(resources[0]);
  } catch (err) {
    console.error("GET /api/photos/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----- PHOTOS: upload (REAL) -----
app.post("/api/photos", upload.single("file"), async (req, res) => {
  try {
    requireEnv("AZURE_STORAGE_CONNECTION", AZURE_STORAGE_CONNECTION);

    if (!req.file) return res.status(400).json({ error: "Missing file field 'file'" });

    const title = String(req.body.title || "").trim();
    const caption = String(req.body.caption || "").trim();
    const location = String(req.body.location || "").trim();
    const people = toPeopleArray(req.body.people);

    if (!title) return res.status(400).json({ error: "Title is required" });

    // Upload to Blob
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION);
    const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
    await containerClient.createIfNotExists({ access: "blob" });

    const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const blobName = `${id}.${ext}`;

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype }
    });

    const url = blockBlobClient.url;

    // Save metadata to Cosmos (photos)
    const { photos } = cosmos();
    const doc = {
      id,
      title,
      caption,
      location,
      people,
      blobName,
      url,
      contentType: req.file.mimetype,
      createdAt: nowIso()
    };

    await photos.items.create(doc);

    res.status(201).json({ message: "Photo uploaded", photo: doc });
  } catch (err) {
    console.error("POST /api/photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- COMMENTS --------------------

// GET comments for a photo
app.get("/api/photos/:id/comments", async (req, res) => {
  try {
    const { comments } = cosmos();
    const photoId = String(req.params.id);

    const { resources } = await comments.items
      .query(
        {
          query: "SELECT * FROM c WHERE c.photoId=@photoId ORDER BY c.createdAt DESC",
          parameters: [{ name: "@photoId", value: photoId }]
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    res.json(resources);
  } catch (err) {
    console.error("GET comments error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST a comment
app.post("/api/photos/:id/comments", async (req, res) => {
  try {
    const { comments } = cosmos();
    const photoId = String(req.params.id);

    const name = String(req.body?.name || "Anonymous").trim();
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Comment text required" });

    const doc = {
      id: `${photoId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      photoId,
      name,
      text,
      createdAt: nowIso()
    };

    await comments.items.create(doc);
    res.status(201).json({ message: "Comment added", comment: doc });
  } catch (err) {
    console.error("POST comment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- RATINGS --------------------

// GET rating summary for a photo
app.get("/api/photos/:id/rating", async (req, res) => {
  try {
    const { ratings } = cosmos();
    const photoId = String(req.params.id);

    const { resources } = await ratings.items
      .query(
        {
          query: "SELECT c.value FROM c WHERE c.photoId=@photoId",
          parameters: [{ name: "@photoId", value: photoId }]
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    const values = resources.map((r) => Number(r.value)).filter((n) => Number.isFinite(n));
    const count = values.length;
    const avg = count ? values.reduce((a, b) => a + b, 0) / count : 0;

    res.json({ photoId, count, average: Number(avg.toFixed(2)) });
  } catch (err) {
    console.error("GET rating error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST rating (upsert by photoId + userKey)
app.post("/api/photos/:id/rating", async (req, res) => {
  try {
    const { ratings } = cosmos();
    const photoId = String(req.params.id);

    const value = Number(req.body?.value);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      return res.status(400).json({ error: "Rating must be 1..5" });
    }

    const userKey = String(req.body?.userKey || "anon").slice(0, 120);
    const id = `${photoId}::${userKey}`;

    const doc = {
      id,
      photoId,
      userKey,
      value,
      updatedAt: nowIso()
    };

    await ratings.items.upsert(doc);
    res.status(201).json({ message: "Rating saved", rating: doc });
  } catch (err) {
    console.error("POST rating error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----- Start -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ MediaRG API running on port ${PORT}`));

