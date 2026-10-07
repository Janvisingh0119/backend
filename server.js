require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { GROQ_API_KEY, FIREBASE_API_KEY } = process.env;
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!GROQ_API_KEY || !FIREBASE_API_KEY) {
  console.error("Missing GROQ_API_KEY or FIREBASE_API_KEY in environment.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error("Origin not allowed"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "2kb" }));

// ---- Per-user rate limit: 5 quiz generations per minute -------------------
const hits = new Map();
function rateLimited(uid) {
  const now = Date.now();
  const recent = (hits.get(uid) || []).filter(t => now - t < 60000);
  if (recent.length >= 5) { hits.set(uid, recent); return true; }
  recent.push(now);
  hits.set(uid, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [uid, times] of hits) {
    if (!times.some(t => now - t < 60000)) hits.delete(uid);
  }
}, 60000).unref();

// ---- Verify the Firebase ID token sent by the website ---------------------
async function verifyFirebaseUser(idToken) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );
  if (!response.ok) return null;
  const data = await response.json();
  return data.users?.[0]?.localId || null;
}

// ---- Groq quiz generation (same prompt/schema the frontend used) ----------
const schema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answer: { type: "integer" }
        },
        required: ["question", "options", "answer"],
        additionalProperties: false
      }
    }
  },
  required: ["questions"],
  additionalProperties: false
};

function isValidQuiz(questions) {
  return Array.isArray(questions) && questions.length === 10 && questions.every(q =>
    typeof q?.question === "string" && q.question.trim() &&
    Array.isArray(q.options) && q.options.length === 4 &&
    q.options.every(o => typeof o === "string" && o.trim()) &&
    new Set(q.options.map(o => o.normalize("NFKC").toLocaleLowerCase())).size === 4 &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3
  );
}

async function generateQuestions(category) {
  const payload = {
    model: "openai/gpt-oss-120b",
    messages: [
      { role: "system", content: "Create clear, factually correct multiple-choice quiz questions. Return only data matching the required JSON schema." },
      { role: "user", content: `Create exactly 10 clear, factually correct multiple-choice quiz questions about ${category}. Each question must have exactly four distinct answer options and one unambiguous correct answer. Vary concepts and difficulty. Set answer to the zero-based index of the correct option.` }
    ],
    response_format: { type: "json_schema", json_schema: { name: "quiz_questions", strict: true, schema } }
  };

  const retryable = [429, 500, 502, 503, 504];
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify(payload)
    });
    if (!retryable.includes(response.status) || attempt === 2) break;
    const retryAfter = Number(response.headers.get("Retry-After"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 10000)
      : 1000 * (attempt + 1);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error("Groq returned an unreadable response."), { status: 502 }); }

  if (!response.ok) {
    console.error("Groq error:", response.status, result?.error?.message);
    const busy = retryable.includes(response.status);
    throw Object.assign(
      new Error(busy ? "The question generator is busy. Please try again shortly." : "The question generator failed. Please try again."),
      { status: busy ? 503 : 502 }
    );
  }

  let questions;
  try { questions = JSON.parse(result?.choices?.[0]?.message?.content).questions; }
  catch { throw Object.assign(new Error("Invalid quiz data received. Try again."), { status: 502 }); }

  if (!isValidQuiz(questions)) {
    throw Object.assign(new Error("Incomplete quiz received. Please try again."), { status: 502 });
  }
  return questions;
}

// ---- The only route: generate quiz questions ------------------------------
app.post("/api/generate-quiz", async (req, res) => {
  try {
    const header = req.get("Authorization") || "";
    const idToken = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!idToken) return res.status(401).json({ error: "Sign in required." });

    const uid = await verifyFirebaseUser(idToken);
    if (!uid) return res.status(401).json({ error: "Your session is invalid or expired. Please sign in again." });

    if (rateLimited(uid)) {
      return res.status(429).json({ error: "Too many quiz requests. Wait a minute and try again." });
    }

    const category = typeof req.body?.category === "string"
      ? req.body.category.trim().replace(/\s+/g, " ") : "";
    // Same character rules the admin panel enforces when adding categories
    if (!/^[A-Za-z0-9][A-Za-z0-9 &.+#()_-]{0,49}$/.test(category)) {
      return res.status(400).json({ error: "Invalid category." });
    }

    const questions = await generateQuestions(category);
    res.json({ questions });
  } catch (error) {
    console.error("generate-quiz failed:", error);
    res.status(error.status || 500).json({ error: error.message || "Server error." });
  }
});

// Anything else is not served
app.use((req, res) => res.status(404).json({ error: "Not found." }));
app.use((err, req, res, next) => res.status(403).json({ error: err.message || "Forbidden." }));

app.listen(PORT, () => console.log(`Quiz API listening on port ${PORT}`));
