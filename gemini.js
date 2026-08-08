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

function getTimeOfDayGreeting(timezone) {
  let hour;
  try {
    hour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: timezone || "UTC",
      }).format(new Date()),
      10
    );
  } catch (err) {
    hour = new Date().getUTCHours();
  }

  if (hour < 5) return "Late night";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  if (hour < 21) return "Evening";
  return "Evening";
}

// Shapes HOW the question is written, not just which greeting word is used.
// A 3am "great job crushing your goals!!" reads as tone-deaf — this keeps
// late-night check-ins quiet, and reserves the higher-energy language for
// actual morning check-ins.
function toneForGreeting(greeting) {
  switch (greeting) {
    case "Late night":
      return (
        "Keep the tone quiet, gentle, and low-key — this is a late-night or very-early-morning " +
        "check-in, not a hype moment. Avoid exclamation points and big motivational language. " +
        "A calm, low-pressure question is better than an energetic one right now."
      );
    case "Morning":
      return "Keep the tone warm, energetic, and forward-looking — this is the start of the day.";
    case "Afternoon":
      return "Keep the tone practical and grounded — a mid-day nudge, not a big pep talk.";
    case "Evening":
    default:
      return "Keep the tone reflective and calm — this is closer to the end of the day.";
  }
}

async function generateCheckinQuestion(name, goals, timezone) {
  const greeting = getTimeOfDayGreeting(timezone);
  const tone = toneForGreeting(greeting);

  if (!goals.length) {
    return `${greeting} ${name} — what's on your plate today?`;
  }
  const goalLines = goals.map((g) => `- ${g.title}: ${g.description || ""}`).join("\n");
  const prompt =
    `You are a supportive, technically-minded accountability coach for ${name}. ` +
    `It is currently the ${greeting.toLowerCase()} for ${name}, so greet them appropriately ` +
    `(e.g. "${greeting}" rather than always "Morning"). ${tone} ` +
    `Active goals:\n${goalLines}\n\n` +
    `Write ONE short, motivating check-in question (max 2 sentences), no preamble, just the question.`;
  try {
    return await callGemini(prompt);
  } catch (err) {
    console.error("Gemini error (question):", err.message);
    return `${greeting} ${name} — what's on your plate today?`;
  }
}

// Split free text into individual tasks, each matched to the single best-fit goal id (or null),
// and tagged with a "scope": "today" for quick same-day items, or "multi_day" for anything that
// reasonably takes longer than a single day / is ongoing. This piggybacks on the SAME Gemini
// call already used for splitting/rephrasing — no extra API request, no extra token cost.
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
    `or null if it doesn't clearly relate to any goal. ` +
    `Also tag each task with a "scope": use "today" for something that can reasonably be finished ` +
    `within the same day, or "multi_day" for anything that clearly spans more than one day or is an ` +
    `ongoing effort (e.g. "write project proposal" over several days, "study for finals this week").\n\n` +
    `Respond with ONLY valid JSON, no markdown fences, no commentary, in this exact shape:\n` +
    `[{"description": "...", "goal_id": "...", "scope": "today"}, {"description": "...", "goal_id": null, "scope": "multi_day"}]`;

  try {
    const raw = await callGemini(prompt);
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length) {
      // Guard against missing/invalid scope values from the model
      return parsed.map((t) => ({
        ...t,
        scope: t.scope === "multi_day" ? "multi_day" : "today",
      }));
    }
    throw new Error("Empty or invalid parse result");
  } catch (err) {
    console.error("Gemini error (categorize):", err.message);
    const fallbackTasks = rawText
      .split(/[\n.,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((description) => ({ description, goal_id: null, scope: "today" }));
    return fallbackTasks.length ? fallbackTasks : [{ description: rawText, goal_id: null, scope: "today" }];
  }
}

async function categorizeSingleTask(description, goals) {
  const [result] = await parseTasksWithGoals(description, goals);
  return result || { description, goal_id: null, scope: "today" };
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