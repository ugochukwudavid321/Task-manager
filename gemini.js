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

// Ask Gemini for a short motivating morning check-in question, tied to
// active goals and (new) active ongoing objectives. May naturally
// reference one of the ongoing objectives if it fits.
async function generateCheckinQuestion(name, goals, timezone, ongoingTasks) {
  const safeGoals = goals || [];
  const safeOngoing = ongoingTasks || [];

  if (!safeGoals.length && !safeOngoing.length) {
    return `Morning ${name} — what's on your plate today?`;
  }

  const goalLines = safeGoals.map((g) => `- ${g.title}: ${g.description || ""}`).join("\n");
  const ongoingLines = safeOngoing
    .map((o) => `- ${o.title}${o.due_date ? ` (due ${o.due_date})` : ""}: ${o.description || ""}`)
    .join("\n");

  const prompt =
    `You are a supportive, technically-minded accountability coach for ${name}. ` +
    (goalLines ? `Active goals:\n${goalLines}\n\n` : "") +
    (ongoingLines ? `Active ongoing objectives (persistent, multi-day):\n${ongoingLines}\n\n` : "") +
    `Write ONE short, motivating morning check-in question (max 2 sentences), no preamble, just the question. ` +
    `You may naturally reference one active goal or ongoing objective if it fits, but don't force it.`;

  try {
    return await callGemini(prompt);
  } catch (err) {
    console.error("Gemini error (question):", err.message);
    return `Morning ${name} — what's on your plate today?`;
  }
}

// Split free text into individual daily actions. For each action, Gemini
// picks the best-fit goal id (or null), AND decides whether the action
// belongs to a persistent multi-day objective:
//   - ongoing_task_id: set if it matches an existing active ongoing task
//   - new_ongoing_title: set if it looks like the start of a NEW persistent
//     objective (something spanning multiple days), otherwise null
//   - if neither applies, both are null and the action is just a one-off
//     daily task
async function parseTasksWithOngoing(rawText, goals, ongoingTasks) {
  const safeGoals = goals || [];
  const safeOngoing = ongoingTasks || [];

  const fallbackSplit = () =>
    rawText
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((description) => ({
        description,
        goal_id: null,
        ongoing_task_id: null,
        new_ongoing_title: null,
      }));

  if (!safeGoals.length && !safeOngoing.length) {
    return fallbackSplit();
  }

  const goalList = safeGoals.map((g) => `- id="${g.id}" title="${g.title}"`).join("\n") || "(none)";
  const ongoingList =
    safeOngoing.map((o) => `- id="${o.id}" title="${o.title}"`).join("\n") || "(none)";

  const prompt =
    `Active goals (id and title):\n${goalList}\n\n` +
    `Active ongoing objectives — persistent containers that span multiple days ` +
    `(id and title):\n${ongoingList}\n\n` +
    `User's plan for today:\n"${rawText}"\n\n` +
    `Split this into individual, concrete daily tasks. For each task:\n` +
    `1. Pick the SINGLE closest-matching goal id from the goals list, or null if none fit.\n` +
    `2. Decide if this task is today's step toward an EXISTING ongoing objective — if so, ` +
    `set "ongoing_task_id" to that objective's id, and leave "new_ongoing_title" null.\n` +
    `3. If the task clearly describes the START of a NEW multi-day objective (not a single ` +
    `one-off action), set "new_ongoing_title" to a short title for it, and leave "ongoing_task_id" null.\n` +
    `4. If the task is just a simple one-off action unrelated to any persistent objective, ` +
    `set both "ongoing_task_id" and "new_ongoing_title" to null.\n` +
    `A task should almost never have both ongoing_task_id and new_ongoing_title set.\n\n` +
    `Respond with ONLY valid JSON, no markdown fences, no preamble, in this exact shape:\n` +
    `[{"description": "...", "goal_id": "..." | null, "ongoing_task_id": "..." | null, "new_ongoing_title": "..." | null}]`;

  try {
    const raw = await callGemini(prompt);
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.map((p) => ({
        description: p.description,
        goal_id: p.goal_id || null,
        ongoing_task_id: p.ongoing_task_id || null,
        new_ongoing_title: p.new_ongoing_title || null,
      }));
    }
    throw new Error("Empty or invalid parse result");
  } catch (err) {
    console.error("Gemini error (categorize):", err.message);
    // Fallback: single task, unassigned, so nothing is silently lost
    return [{ description: rawText, goal_id: null, ongoing_task_id: null, new_ongoing_title: null }];
  }
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
  parseTasksWithOngoing,
  cosineSimilarity,
};