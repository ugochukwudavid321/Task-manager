const express = require("express");
const router = express.Router();
const { sb } = require("./supabase");
const {
  generateCheckinQuestion,
  parseTasksWithGoals,
  categorizeSingleTask,
  getEmbedding,
  cosineSimilarity,
} = require("./gemini");

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function getOrCreateUser() {
  const users = await sb.get("users?select=*&limit=1");
  if (users.length) return users[0];
  const created = await sb.post("users", { name: "David" });
  return created[0];
}

async function getActiveGoals(userId) {
  return sb.get(`goals?select=id,title,description&user_id=eq.${userId}&status=eq.active`);
}

async function getOrCreateTodayLog(userId) {
  const logs = await sb.get(
    `daily_logs?select=*&user_id=eq.${userId}&log_date=eq.${today()}`
  );
  if (logs.length) return logs[0];

  const upserted = await sb.upsert(
    "daily_logs",
    { user_id: userId, log_date: today(), intake_status: "pending" },
    "user_id,log_date"
  );
  return upserted[0];
}

// GET /api/goals - list active goals
router.get("/goals", async (req, res) => {
  try {
    const user = await getOrCreateUser();
    const goals = await getActiveGoals(user.id);
    res.json({ goals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/checkin - morning question + today's status
router.get("/checkin", async (req, res) => {
  try {
    const user = await getOrCreateUser();
    const goals = await getActiveGoals(user.id);
    const log = await getOrCreateTodayLog(user.id);

    if (log.intake_status === "completed") {
      return res.json({ alreadyCheckedIn: true, log });
    }

    const question = await generateCheckinQuestion(user.name, goals);
    res.json({ alreadyCheckedIn: false, question, goals, logId: log.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/checkin  { responseText }  - submit morning plan
router.post("/checkin", async (req, res) => {
  try {
    const { responseText } = req.body;
    if (!responseText || !responseText.trim()) {
      return res.status(400).json({ error: "responseText is required" });
    }

    const user = await getOrCreateUser();
    const goals = await getActiveGoals(user.id);
    const log = await getOrCreateTodayLog(user.id);

    const tasks = await parseTasksWithGoals(responseText, goals);

    const inserted = await sb.post(
      "tasks",
      tasks.map((t) => ({
        daily_log_id: log.id,
        description: t.description,
        goal_id: t.goal_id || null,
        source: "morning_intake",
      }))
    );

    const summary = `${tasks.length} tasks logged: ` + tasks.map((t) => t.description).join("; ");
    await sb.patch(`daily_logs?id=eq.${log.id}`, {
      intake_status: "completed",
      morning_summary: summary,
    });

    res.json({ ok: true, tasks: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/today
router.get("/tasks/today", async (req, res) => {
  try {
    const user = await getOrCreateUser();
    const log = await getOrCreateTodayLog(user.id);
    const tasks = await sb.get(`tasks?select=*&daily_log_id=eq.${log.id}`);
    res.json({ log, tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// POST /api/goals  { title, description }  - add a new goal
router.post("/goals", async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const user = await getOrCreateUser();

    const inserted = await sb.post("goals", {
      user_id: user.id,
      title: title.trim(),
      description: description ? description.trim() : null,
      status: "active",
    });

    res.json({ ok: true, goal: inserted[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks  { description }  - add a task any time during the day
router.post("/tasks", async (req, res) => {
  try {
    const { description } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ error: "description is required" });
    }

    const user = await getOrCreateUser();
    const goals = await getActiveGoals(user.id);
    const log = await getOrCreateTodayLog(user.id);

    const categorized = await categorizeSingleTask(description, goals);

    const inserted = await sb.post("tasks", {
      daily_log_id: log.id,
      description: categorized.description || description,
      goal_id: categorized.goal_id || null,
      source: "added_later",
    });

    res.json({ ok: true, task: inserted[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/tasks/:id/complete
router.patch("/tasks/:id/complete", async (req, res) => {
  try {
    const completedAt = new Date().toISOString();
    const updated = await sb.patch(`tasks?id=eq.${req.params.id}`, {
      completed: true,
      completed_at: completedAt,
    });
    res.json({ ok: true, task: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review  { eveningSummary, moodNote }
router.post("/review", async (req, res) => {
  try {
    const { eveningSummary, moodNote } = req.body;
    const user = await getOrCreateUser();
    const log = await getOrCreateTodayLog(user.id);

    let embedding = null;
    let similarDay = null;

    if (eveningSummary && eveningSummary.trim()) {
      embedding = await getEmbedding(eveningSummary);

      await sb.patch(`daily_logs?id=eq.${log.id}`, {
        evening_summary: eveningSummary,
        mood_note: moodNote || null,
        embedding,
      });

      const pastLogs = await sb.get(
        `daily_logs?select=id,log_date,evening_summary,embedding&user_id=eq.${user.id}&embedding=not.is.null&id=neq.${log.id}`
      );

      let best = null;
      for (const p of pastLogs) {
        if (!p.embedding) continue;
        const vec = typeof p.embedding === "string" ? JSON.parse(p.embedding) : p.embedding;
        const score = cosineSimilarity(embedding, vec);
        if (!best || score > best.score) best = { score, log: p };
      }
      if (best && best.score > 0.7) {
        similarDay = { date: best.log.log_date, summary: best.log.evening_summary, score: best.score };
      }
    } else {
      await sb.patch(`daily_logs?id=eq.${log.id}`, {
        evening_summary: eveningSummary || "",
        mood_note: moodNote || null,
      });
    }

    const tasks = await sb.get(`tasks?select=*&daily_log_id=eq.${log.id}`);
    const completedCount = tasks.filter((t) => t.completed).length;

    res.json({ ok: true, completedCount, totalCount: tasks.length, similarDay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
