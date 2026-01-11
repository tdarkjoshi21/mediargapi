const express = require("express");
const cors = require("cors");
const multer = require("multer");

const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");

const app = express();

// ---- CORS ----
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin,
  })
);

app.use(express.json({ limit: "2mb" }));

// ---- Multer (memory upload) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---- Env ----
const AZURE_STORAGE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION;
const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || "images";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME || "mediasharedb";

const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || "photos";
const COSMOS_COMMENT_CONTAINER =
  process.env.COSMOS_COMMENT_CONTAINER || "comments";
const COSMOS_RATINGS_CONTAINER =
  process.env.COSMOS_RATINGS_CONTAINER || "ratings";

// ---- Clients ----
function assertEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

assertEnv("AZURE_STORAGE_CONNECTION", AZURE_STORAGE_CONNECTION);
assertEnv("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
assertEnv("COSMOS_KEY", COSMOS_KEY);

const blobServiceClient = BlobServiceClient.fromConnectionString(
  AZURE_STORAGE_CONNECTION
);

const cosmosClient = new CosmosClient({
  endpoint: COSMOS_ENDPOINT,
  key: COSMOS_KEY,
});

const db = cosmosClient.database(COSMOS_DB_NAME);
const photosContainer = db.container(COSMOS_CONTAINER);
const commentsContainer = db.container(COSMOS_COMMENT_CONTAINER);
const ratingsContainer = db.container(COSMOS_RATINGS_CONTAINER);

// ---- Helpers ----
function nowIso() {
  return new Date().toISOString();
}

function safePeopleArray(peopleRaw) {
  if (!peopleRaw) return [];
  if (Array.isArray(peopleRaw)) return peopleRaw.map(String).filter(Boolean);
  return String(peopleRaw)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildSearchPredicate(q) {
  const s = String(q || "").trim().toLowerCase();
  return s;
}

// ---- Health ----
app.get("/", (req, res) => res.send("SharePic API is running"));

// ---- GET photos (supports ?q=search) ----
app.get("/api/photos", async (req, res) => {
  try {
    const q = buildSearchPredicate(req.query.q);
    // simple SQL search across some fields
    // NOTE: This assumes your container partition key doesn’t block this query.
    // If you use partition key like /id you can still query cross partition.
    const querySpec = q
      ? {
          query: `
            SELECT * FROM c
            WHERE CONTAINS(LOWER(c.title), @q)
               OR CONTAINS(LOWER(c.caption), @q)
               OR CONTAINS(LOWER(c.location), @q)
               OR ARRAY_CONTAINS(c.people, @q, true)
            ORDER BY c.createdAt DESC
          `,
          parameters: [{ name: "@q", value: q }],
        }
      : {
          query: "SELECT * FROM c ORDER BY c.createdAt DESC",
        };

    const { resources } = await photosContainer.items
      .query(querySpec, { enableCrossPartitionQuery: true })
      .fetchAll();

    res.json(resources);
  } catch (err) {
    console.error("GET /api/photos error:", err);
    res.status(500).json({ error: "Failed to fetch photos" });
  }
});

// ---- GET photo by id ----
app.get("/api/photos/:id", async (req, res) => {
  try {
    const id = req.params.id;
    // if your container uses partition key = /id, this works:
    const { resource } = await photosContainer.item(id, id).read();
    if (!resource) return res.status(404).json({ error: "Photo not found" });
    res.json(resource);
  } catch (err) {
    console.error("GET /api/photos/:id error:", err);
    res.status(404).json({ error: "Photo not found" });
  }
});

// ---- POST photo upload (creator) ----
// multipart/form-data fields: file, title, caption, location, people
app.post("/api/photos", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });

    const title = (req.body.title || "").trim();
    const caption = (req.body.caption || "").trim();
    const location = (req.body.location || "").trim();
    const people = safePeopleArray(req.body.people);

    if (!title) return res.status(400).json({ error: "Title is required" });

    // upload to blob
    const containerClient =
      blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
    await containerClient.createIfNotExists({ access: "blob" });

    const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const blobName = `${id}.${ext}`;

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    const url = blockBlobClient.url;

    // write metadata to cosmos
    const doc = {
      id, // also used as partition key if /id
      title,
      caption,
      location,
      people,
      blobName,
      url,
      contentType: req.file.mimetype,
      createdAt: nowIso(),
    };

    await photosContainer.items.create(doc);

    res.json({ message: "Photo uploaded", photo: doc });
  } catch (err) {
    console.error("POST /api/photos error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ---- POST comment (consumer) ----
// body: { name?, text }
app.post("/api/photos/:id/comments", async (req, res) => {
  try {
    const photoId = req.params.id;
    const name = (req.body.name || "Anonymous").trim();
    const text = (req.body.text || "").trim();

    if (!text) return res.status(400).json({ error: "Comment text required" });

    const comment = {
      id: `${photoId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      photoId,
      name,
      text,
      createdAt: nowIso(),
    };

    await commentsContainer.items.create(comment);
    res.json({ message: "Comment added", comment });
  } catch (err) {
    console.error("POST /comments error:", err);
    res.status(500).json({ error: "Failed to add comment" });
  }
});

// ---- GET comments for a photo ----
app.get("/api/photos/:id/comments", async (req, res) => {
  try {
    const photoId = req.params.id;

    const querySpec = {
      query: "SELECT * FROM c WHERE c.photoId = @photoId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const { resources } = await commentsContainer.items
      .query(querySpec, { enableCrossPartitionQuery: true })
      .fetchAll();

    res.json(resources);
  } catch (err) {
    console.error("GET comments error:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// ---- POST rating (consumer) ----
// body: { value: 1..5, userKey?: string }
// userKey is a simple identifier to prevent multiple ratings (not real auth).
app.post("/api/photos/:id/rating", async (req, res) => {
  try {
    const photoId = req.params.id;
    const value = Number(req.body.value);

    if (!Number.isFinite(value) || value < 1 || value > 5) {
      return res.status(400).json({ error: "Rating must be 1..5" });
    }

    const userKey = (req.body.userKey || "anon").toString().slice(0, 120);

    // upsert: one rating per photo per userKey
    const ratingId = `${photoId}::${userKey}`;

    const ratingDoc = {
      id: ratingId,
      photoId,
      userKey,
      value,
      updatedAt: nowIso(),
    };

    await ratingsContainer.items.upsert(ratingDoc);
    res.json({ message: "Rating saved", rating: ratingDoc });
  } catch (err) {
    console.error("POST rating error:", err);
    res.status(500).json({ error: "Failed to save rating" });
  }
});

// ---- GET rating summary for a photo ----
app.get("/api/photos/:id/rating", async (req, res) => {
  try {
    const photoId = req.params.id;

    const querySpec = {
      query: "SELECT c.value FROM c WHERE c.photoId = @photoId",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const { resources } = await ratingsContainer.items
      .query(querySpec, { enableCrossPartitionQuery: true })
      .fetchAll();

    const values = resources.map((r) => r.value);
    const count = values.length;
    const avg = count ? values.reduce((a, b) => a + b, 0) / count : 0;

    res.json({ photoId, count, average: Number(avg.toFixed(2)) });
  } catch (err) {
    console.error("GET rating error:", err);
    res.status(500).json({ error: "Failed to fetch rating" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));

