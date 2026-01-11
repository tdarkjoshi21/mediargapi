const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;

// Your frontend static site origin:
const DEFAULT_CORS_ORIGIN = "https://mediadtj259.z1.web.core.windows.net";
const CORS_ORIGIN = process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN;

// Required env vars (names must match your Azure settings)
const AZURE_STORAGE_CONNECTION =
  process.env.AZURE_STORAGE_CONNECTION || process.env.AZURE_STORAGE_CONNECTION_STRING;

const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || "images";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME || "mediasharedb";

// Containers (must exist)
const COSMOS_PHOTOS_CONTAINER = process.env.COSMOS_CONTAINER || "photos";
const COSMOS_COMMENTS_CONTAINER = process.env.COSMOS_COMMENT_CONTAINER || "comments";
const COSMOS_RATINGS_CONTAINER = process.env.COSMOS_RATINGS_CONTAINER || "ratings";

// ---------- MIDDLEWARE ----------
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(express.json());

// Multer in-memory upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ---------- HELPERS ----------
function must(name, value) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

function nowISO() {
  return new Date().toISOString();
}

function safeArrayFromComma(text) {
  if (!text) return [];
  return String(text)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);
}

let _cosmos;
function cosmos() {
  must("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
  must("COSMOS_KEY", COSMOS_KEY);

  if (!_cosmos) {
    const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
    const db = client.database(COSMOS_DB_NAME);

    _cosmos = {
      client,
      db,
      photos: db.container(COSMOS_PHOTOS_CONTAINER),
      comments: db.container(COSMOS_COMMENTS_CONTAINER),
      ratings: db.container(COSMOS_RATINGS_CONTAINER)
    };
  }
  return _cosmos;
}

let _blob;
function blob() {
  must("AZURE_STORAGE_CONNECTION", AZURE_STORAGE_CONNECTION);
  if (!_blob) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION);
    const container = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
    _blob = { blobServiceClient, container };
  }
  return _blob;
}

// ---------- ROUTES ----------
app.get("/", (req, res) => res.send("MediaRG API is running ✅"));

// Debug env (optional but helpful)
app.get("/api/_debug/env", (req, res) => {
  res.json({
    CORS_ORIGIN,
    COSMOS_DB_NAME,
    COSMOS_CONTAINER: COSMOS_PHOTOS_CONTAINER,
    COSMOS_COMMENT_CONTAINER: COSMOS_COMMENTS_CONTAINER,
    COSMOS_RATINGS_CONTAINER,
    BLOB_CONTAINER_NAME,
    HAS_COSMOS_ENDPOINT: !!COSMOS_ENDPOINT,
    HAS_COSMOS_KEY: !!COSMOS_KEY,
    HAS_STORAGE_CONN: !!AZURE_STORAGE_CONNECTION
  });
});

// ---- PHOTOS ----

// GET all photos (newest first)
app.get("/api/photos", async (req, res) => {
  try {
    const { photos } = cosmos();
    const querySpec = {
      query: "SELECT * FROM c ORDER BY c.createdAt DESC"
    };
    const { resources } = await photos.items
      .query(querySpec, { enableCrossPartitionQuery: true })
      .fetchAll();

    res.json(resources || []);
  } catch (err) {
    console.error("GET /api/photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET photo by id
app.get("/api/photos/:id", async (req, res) => {
  try {
    const { photos } = cosmos();
    const id = String(req.params.id);

    // We created photoId == id, and partition key is commonly /id or /photoId depending on your setup.
    // We'll query to avoid partition key mismatch.
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
    const caption = String(req.body?.caption || "").trim();
    const location = String(req.body?.location || "").trim();
    const people = safeArrayFromComma(req.body?.people);

    if (!file) return res.status(400).json({ error: "file is required" });
    if (!title) return res.status(400).json({ error: "title is required" });

    const { container } = blob();
    await container.createIfNotExists({ access: "blob" });

    const ext = (file.originalname || "").split(".").pop() || "jpg";
    const photoId = String(Date.now()); // simple unique id
    const blobName = `${photoId}.${ext}`;

    const blockBlobClient = container.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(file.buffer, {
      blobHTTPHeaders: { blobContentType: file.mimetype || "image/jpeg" }
    });

    const url = blockBlobClient.url;

    const { photos } = cosmos();

    // Store metadata in Cosmos (photos container)
    const doc = {
      id: photoId,       // ✅ used as id
      photoId: photoId,  // ✅ also keep photoId for queries
      title,
      caption,
      location,
      people,
      url,
      blobName,
      createdAt: nowISO()
    };

    // Upsert without partitionKey; if your photos container uses /id or /photoId it will still work in many setups.
    // If your photos container is partitioned, change partitionKey accordingly.
    await photos.items.upsert(doc);

    res.status(201).json(doc);
  } catch (err) {
    console.error("POST /api/photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- COMMENTS ----

// GET comments for a photo
app.get("/api/photos/:id/comments", async (req, res) => {
  try {
    const { comments } = cosmos();
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
    const { comments } = cosmos();
    const photoId = String(req.params.id);

    const name = String(req.body?.name || "").trim().slice(0, 80);
    const text = String(req.body?.text || "").trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: "text is required" });

    const doc = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      photoId,
      name: name || "Anonymous",
      text,
      createdAt: nowISO()
    };

    // Many comments containers are partitioned by /photoId. If yours is, pass partitionKey.
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

// ---- RATINGS (partition key fixed for /photoId) ----

// POST rating (partition key = /photoId)
app.post("/api/photos/:id/rating", async (req, res) => {
  try {
    const { ratings } = cosmos();
    const photoId = String(req.params.id);

    const value = Number(req.body?.value);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      return res.status(400).json({ error: "Rating must be 1..5" });
    }

    const userKey = String(req.body?.userKey || "anon").slice(0, 120);

    // one rating per (photoId,userKey)
    const id = `${photoId}::${userKey}`;

    const doc = {
      id,
      photoId, // ✅ matches container partition key
      userKey,
      value,
      updatedAt: nowISO()
    };

    // ✅ REQUIRED for your ratings container: partition key is /photoId
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
    const { ratings } = cosmos();
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
    console.error("GET rating summary error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`MediaRG API running on port ${PORT}`);
  console.log(`CORS origin allowed: ${CORS_ORIGIN}`);
});

