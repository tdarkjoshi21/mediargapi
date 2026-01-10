const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Sample photos array (replace with DB later)
const photos = [
  { id: 1, title: "Sample Photo", url: "https://via.placeholder.com/150" },
  { id: 2, title: "My Test Photo", url: "https://via.placeholder.com/200" }
];

// Health check
app.get("/", (req, res) => res.send("SharePic API is running"));

// GET photos
app.get("/api/photos", (req, res) => {
  console.log("GET /api/photos hit!");
  res.json(photos);
});

// GET photo by ID
app.get("/api/photos/:id", (req, res) => {
  const photoId = parseInt(req.params.id, 10);
  const photo = photos.find(p => p.id === photoId);
  if (!photo) return res.status(404).json({ error: "Photo not found" });
  console.log(GET /api/photos/${photoId} hit!);
  res.json(photo);
});

// POST photo
app.post("/api/photos", (req, res) => {
  console.log("POST /api/photos hit! Body:", req.body);
  // For testing, just add to array (later replace with Blob + Cosmos)
  const newId = photos.length + 1;
  const newPhoto = { id: newId, ...req.body };
  photos.push(newPhoto);
  res.json({ message: "Upload endpoint works", photo: newPhoto });
});

// POST comment
app.post("/api/photos/:id/comments", (req, res) => {
  console.log(POST /api/photos/${req.params.id}/comments hit! Body:, req.body);
  res.json({ message: Comment added for photo ${req.params.id} });
});

// POST rating
app.post("/api/photos/:id/rating", (req, res) => {
  console.log(POST /api/photos/${req.params.id}/rating hit! Body:, req.body);
  res.json({ message: Rating added for photo ${req.params.id} });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(API running on port ${PORT}));