const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_KEY) {
  throw new Error("Missing GEMINI_API_KEY in environment.");
}

const GEMINI_MODEL = "gemini-flash-latest"; // alias, always points at current recommended flash model
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

async function callGemini(prompt) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    throw new Error(`Gemini generateContent failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

async function getEmbedding(text) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!res.ok) {
    throw new Error(`Gemini embedContent failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.embedding.values;
}

// Ask Gemini for a short motivating morning check-in question, tied to active goals.
async function generateCheckinQuestion(name, goals) {
  if (!goals.length) {
    return `Morning ${name} — what's on your plate today?`;
  }
  const goalLines = goals.map((g) => `- ${g.title}: ${g.description || ""}`).join("\n");
  const prompt =
    `You are a supportive, technically-minded accountability coach for ${name}. ` +
    `Active goals:\n${goalLines}\n\n` +
    `Write ONE short, motivating morning check-in question (max 2 sentences), no preamble, just the question.`;
  try {
    return await callGemini(prompt);
  } catch (err) {
    console.error("Gemini error (question):", err.message);
    return `Morning ${name} — what's on your plate today?`;
  }
}

// Split free text into individual tasks, each matched to the single best-fit goal id (or null).
async function parseTasksWithGoals(rawText, goals) {
  const goalList = goals.length
    ? goals.map((g) => `- id="${g.id}" title="${g.title}"`).join("\n")
    : "(no active goals)";

  const prompt =
    `Active goals (id and title):\n${goalList}\n\n` +
    `User's rough plan for today, written quickly and possibly run-on or messy:\n"${rawText}"\n\n` +
    `Break this into individual, concrete tasks. For each one, REWRITE it as a short, clear, ` +
    `actionable phrase in your own words — do NOT copy the user's original wording verbatim. ` +
    `Fix grammar, remove filler words, and make each task read like a clean to-do item ` +
    `(e.g. "wash prep for church train read" might become "Prepare laundry for church" and "Read for training"). ` +
    `Then, for each task, pick the SINGLE closest-matching goal id from the list above, ` +
    `or null if it doesn't clearly relate to any goal.\n\n` +
    `Respond with ONLY valid JSON, no markdown fences, no commentary, in this exact shape:\n` +
    `[{"description": "...", "goal_id": "..."}, {"description": "...", "goal_id": null}]`;

  try {
    const raw = await callGemini(prompt);
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length) return parsed;
    throw new Error("Empty or invalid parse result");
  } catch (err) {
    console.error("Gemini error (categorize):", err.message);
    // Fallback: naive split on line breaks / periods / commas, so a bad
    // Gemini response doesn't dump the entire raw text as one giant task.
    const fallbackTasks = rawText
      .split(/[\n.,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((description) => ({ description, goal_id: null }));
    return fallbackTasks.length ? fallbackTasks : [{ description: rawText, goal_id: null }];
  }
}

// Categorize a single ad-hoc task (used by the "add task anytime" endpoint).
async function categorizeSingleTask(description, goals) {
  const [result] = await parseTasksWithGoals(description, goals);
  return result || { description, goal_id: null };
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
  callGemini,
  getEmbedding,
  generateCheckinQuestion,
  parseTasksWithGoals,
  categorizeSingleTask,
  cosineSimilarity,
};
