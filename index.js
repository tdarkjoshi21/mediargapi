const express = require("express");
const cors = require("cors");

const app = express();

// ---- CORS (use env var in Azure) ----
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin
  })
);

app.use(express.json());

// ---- In-memory data ----
let photos = [
  {
    id: "1",
    title: "Sample Photo",
    url: "https://via.placeholder.com/600x400",
    caption: "This is a placeholder image",
    location: "Demo",
    people: ["DemoUser"],
    createdAt: new Date().toISOString()
  }
];

const commentsByPhoto = {}; // { photoId: [{name,text,createdAt}] }
const ratingsByPhoto = {};  // { photoId: [{value,createdAt}] }

// ---- Helpers ----
function nowIso() {
  return new Date().toISOString();
}

function toPeopleArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function calcRatingSummary(photoId) {
  const ratings = ratingsByPhoto[photoId] || [];
  const count = ratings.length;
  const avg = count
    ? ratings.reduce((sum, r) => sum + Number(r.value || 0), 0) / count
    : 0;
  return { count, average: Number(avg.toFixed(2)) };
}

// ---- Routes ----
app.get("/", (req, res) => {
  res.json({
    status: "MediaRG API is running ✅",
    corsOrigin: allowedOrigin
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

// GET photos (supports ?q=)
app.get("/api/photos", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();

  let result = photos;
  if (q) {
    result = photos.filter((p) => {
      const people = (p.people || []).join(" ").toLowerCase();
      return (
        (p.title || "").toLowerCase().includes(q) ||
        (p.caption || "").toLowerCase().includes(q) ||
        (p.location || "").toLowerCase().includes(q) ||
        people.includes(q)
      );
    });
  }

  const withRatings = result.map((p) => ({
    ...p,
    rating: calcRatingSummary(p.id)
  }));

  console.log(`GET /api/photos q="${q}" -> ${withRatings.length} item(s)`);
  res.json(withRatings);
});

// GET photo by id
app.get("/api/photos/:id", (req, res) => {
  const id = String(req.params.id);
  const photo = photos.find((p) => p.id === id);

  if (!photo) return res.status(404).json({ error: "Photo not found" });

  console.log(`GET /api/photos/${id}`);
  res.json({
    ...photo,
    rating: calcRatingSummary(id),
    comments: commentsByPhoto[id] || []
  });
});

// POST photo (metadata only)
app.post("/api/photos", (req, res) => {
  const { title, url, caption, location, people } = req.body || {};

  if (!title || !url) {
    return res.status(400).json({ error: "title and url are required" });
  }

  const newPhoto = {
    id: String(Date.now()),
    title: String(title).trim(),
    url: String(url).trim(),
    caption: String(caption || "").trim(),
    location: String(location || "").trim(),
    people: toPeopleArray(people),
    createdAt: nowIso()
  };

  photos.unshift(newPhoto);
  console.log("POST /api/photos created:", newPhoto.id);

  res.status(201).json({ message: "Photo added", photo: newPhoto });
});

// POST comment
app.post("/api/photos/:id/comments", (req, res) => {
  const id = String(req.params.id);
  const photo = photos.find((p) => p.id === id);
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  const name = String(req.body?.name || "Anonymous").trim();
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Comment text required" });

  commentsByPhoto[id] = commentsByPhoto[id] || [];
  const comment = { name, text, createdAt: nowIso() };
  commentsByPhoto[id].unshift(comment);

  console.log(`POST /api/photos/${id}/comments`);
  res.status(201).json({ message: "Comment added", comment });
});

// GET comments
app.get("/api/photos/:id/comments", (req, res) => {
  const id = String(req.params.id);
  res.json(commentsByPhoto[id] || []);
});

// POST rating
app.post("/api/photos/:id/rating", (req, res) => {
  const id = String(req.params.id);
  const photo = photos.find((p) => p.id === id);
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  const value = Number(req.body?.value);
  if (!Number.isFinite(value) || value < 1 || value > 5) {
    return res.status(400).json({ error: "Rating must be a number 1..5" });
  }

  ratingsByPhoto[id] = ratingsByPhoto[id] || [];
  ratingsByPhoto[id].push({ value, createdAt: nowIso() });

  console.log(`POST /api/photos/${id}/rating value=${value}`);
  res.status(201).json({
    message: "Rating added",
    rating: calcRatingSummary(id)
  });
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ MediaRG API running on port ${PORT}`));

