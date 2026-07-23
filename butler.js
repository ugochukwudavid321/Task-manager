const express = require("express");
const router = express.Router();
const { sb } = require("./supabase");
const { sendPushNotification } = require("./push");
const {
  callGemini,
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
// POST /api/push/subscribe  { subscription }
router.post("/push/subscribe", async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: "Valid subscription object is required" });
    }

    const user = await getOrCreateUser();

    await sb.upsert(
      "push_subscriptions",
      {
        user_id: user.id,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
      "endpoint"
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// GET /api/notifications/check-due?secret=YOUR_SECRET
// Meant to be called by an external cron on a schedule, not by the frontend.
router.get("/notifications/check-due", async (req, res) => {
  try {
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await getOrCreateUser();
    const todayStr = today();

    // Tasks due today or earlier, not completed, not reminded in the last 6 hours
    const dueTasks = await sb.get(
      `tasks?select=*&completed=eq.false&due_date=lte.${todayStr}&due_date=not.is.null`
    );

    const subs = await sb.get(`push_subscriptions?select=*&user_id=eq.${user.id}`);
    if (!subs.length) {
      return res.json({ ok: true, sent: 0, reason: "no subscriptions" });
    }

    let sentCount = 0;
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    for (const task of dueTasks) {
      if (task.last_reminded_at && task.last_reminded_at > sixHoursAgo) continue;

      const prompt =
        `Write a short, friendly one-sentence phone notification reminding the user about this task: ` +
        `"${task.description}" (scope: ${task.scope}, due: ${task.due_date}). ` +
        `Max 15 words, no preamble, just the reminder text.`;

      let body;
      try {
        body = await callGemini(prompt);
      } catch (e) {
        body = `Reminder: ${task.description}`;
      }

      for (const sub of subs) {
        const result = await sendPushNotification(sub, {
          title: "Acorn Reminder",
          body,
          url: "/",
        });
        if (result.ok) sentCount++;
        if (result.expired) {
          await sb.get(`push_subscriptions?id=eq.${sub.id}`); // no-op guard
          // Could delete expired subs here if desired
        }
      }

      await sb.patch(`tasks?id=eq.${task.id}`, {
        last_reminded_at: new Date().toISOString(),
      });
    }

    res.json({ ok: true, sent: sentCount, tasksChecked: dueTasks.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
