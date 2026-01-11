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

// JSON only for non-file routes
app.use(express.json());

// ----- Multer for multipart/form-data -----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ----- Env -----
const AZURE_STORAGE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION;
const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || "images";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME || "mediasharedb";
const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || "photos";

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
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

// ----- Health -----
app.get("/", (req, res) => {
  res.json({
    status: "MediaRG API is running ✅",
    corsOrigin: allowedOrigin
  });
});

// ----- GET photos (list) -----
app.get("/api/photos", async (req, res) => {
  try {
    requireEnv("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
    requireEnv("COSMOS_KEY", COSMOS_KEY);

    const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
    const container = client.database(COSMOS_DB_NAME).container(COSMOS_CONTAINER);

    const { resources } = await container.items
      .query("SELECT * FROM c ORDER BY c.createdAt DESC", { enableCrossPartitionQuery: true })
      .fetchAll();

    res.json(resources);
  } catch (err) {
    console.error("GET /api/photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----- GET photo by id -----
app.get("/api/photos/:id", async (req, res) => {
  try {
    requireEnv("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
    requireEnv("COSMOS_KEY", COSMOS_KEY);

    const id = String(req.params.id);

    const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
    const container = client.database(COSMOS_DB_NAME).container(COSMOS_CONTAINER);

    const { resources } = await container.items
      .query(
        { query: "SELECT * FROM c WHERE c.id=@id", parameters: [{ name: "@id", value: id }] },
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

// ----- POST photo (REAL upload) -----
// expects multipart/form-data: file + title + caption + location + people
app.post("/api/photos", upload.single("file"), async (req, res) => {
  try {
    requireEnv("AZURE_STORAGE_CONNECTION", AZURE_STORAGE_CONNECTION);
    requireEnv("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
    requireEnv("COSMOS_KEY", COSMOS_KEY);

    if (!req.file) return res.status(400).json({ error: "Missing file field 'file'" });

    const title = String(req.body.title || "").trim();
    const caption = String(req.body.caption || "").trim();
    const location = String(req.body.location || "").trim();
    const people = toPeopleArray(req.body.people);

    if (!title) return res.status(400).json({ error: "Title is required" });

    // 1) Upload to Blob
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION);
    const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);

    // container should exist already, but safe:
    await containerClient.createIfNotExists({ access: "blob" });

    const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const blobName = `${id}.${ext}`;

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype }
    });

    const url = blockBlobClient.url;

    // 2) Save metadata to Cosmos
    const cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
    const photosContainer = cosmosClient.database(COSMOS_DB_NAME).container(COSMOS_CONTAINER);

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

    await photosContainer.items.create(doc);

    // return for frontend
    res.status(201).json({ message: "Photo uploaded", photo: doc });
  } catch (err) {
    console.error("POST /api/photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ MediaRG API running on port ${PORT}`));

