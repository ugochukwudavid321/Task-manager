const express = require("express");
const router = express.Router();
const { sb } = require("./supabase");
const { requireAuth } = require("./auth");
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

function nextDayStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function getOrCreateUserProfile(userId, email, preferredName) {
  const users = await sb.get(`users?select=*&id=eq.${userId}`);
  if (users.length) return users[0];
  const fallbackName = preferredName || (email ? email.split("@")[0] : "User");
  const created = await sb.post("users", { id: userId, name: fallbackName });
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

// ==========================================================================
// CRON ROUTE — defined BEFORE requireAuth so it stays reachable via secret,
// not a user session token.
// ==========================================================================

router.get("/notifications/check-due", async (req, res) => {
  try {
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const todayStr = today();

    const dueByDate = await sb.get(
      `tasks?select=*,daily_logs(user_id)&completed=eq.false&due_date=lte.${todayStr}&due_date=not.is.null`
    );
    const dueByScope = await sb.get(
      `tasks?select=*,daily_logs(user_id)&completed=eq.false&scope=eq.multi_day`
    );

    const seenIds = new Set();
    const dueTasks = [...dueByDate, ...dueByScope].filter((t) => {
      if (seenIds.has(t.id)) return false;
      seenIds.add(t.id);
      return true;
    });

    if (!dueTasks.length) {
      return res.json({ ok: true, sent: 0, tasksChecked: 0 });
    }

    const tasksByUser = {};
    for (const task of dueTasks) {
      const uid = task.daily_logs?.user_id;
      if (!uid) continue;
      if (!tasksByUser[uid]) tasksByUser[uid] = [];
      tasksByUser[uid].push(task);
    }

    let sentCount = 0;
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    for (const userId of Object.keys(tasksByUser)) {
      const subs = await sb.get(`push_subscriptions?select=*&user_id=eq.${userId}`);
      if (!subs.length) continue;

      for (const task of tasksByUser[userId]) {
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
        }

        await sb.patch(`tasks?id=eq.${task.id}`, {
          last_reminded_at: new Date().toISOString(),
        });
      }
    }

    res.json({ ok: true, sent: sentCount, tasksChecked: dueTasks.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================================
// Everything below requires a valid signed-in user
// ==========================================================================
router.use(requireAuth);

router.get("/goals", async (req, res) => {
  try {
    const goals = await getActiveGoals(req.userId);
    res.json({ goals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/goals", async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const inserted = await sb.post("goals", {
      user_id: req.userId,
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

router.delete("/goals/:id", async (req, res) => {
  try {
    await sb.delete(`goals?id=eq.${req.params.id}&user_id=eq.${req.userId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/checkin", async (req, res) => {
  try {
    const profile = await getOrCreateUserProfile(req.userId, req.userEmail, req.userName);
    const goals = await getActiveGoals(req.userId);
    const log = await getOrCreateTodayLog(req.userId);

    if (log.intake_status === "completed") {
      return res.json({ alreadyCheckedIn: true, log });
    }

    const question = await generateCheckinQuestion(profile.name, goals, profile.timezone);
    res.json({ alreadyCheckedIn: false, question, goals, logId: log.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/checkin", async (req, res) => {
  try {
    const { responseText } = req.body;
    if (!responseText || !responseText.trim()) {
      return res.status(400).json({ error: "responseText is required" });
    }

    const goals = await getActiveGoals(req.userId);
    const log = await getOrCreateTodayLog(req.userId);

    const tasks = await parseTasksWithGoals(responseText, goals);

    const inserted = await sb.post(
      "tasks",
      tasks.map((t) => ({
        daily_log_id: log.id,
        description: t.description,
        goal_id: t.goal_id || null,
        scope: t.scope || "today",
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

router.get("/tasks/today", async (req, res) => {
  try {
    const log = await getOrCreateTodayLog(req.userId);
    const todaysTasks = await sb.get(`tasks?select=*&daily_log_id=eq.${log.id}`);

    const carriedOver = await sb.get(
      `tasks?select=*,daily_logs(user_id)&completed=eq.false&scope=eq.multi_day`
    );
    const persistingTasks = carriedOver.filter(
      (t) => t.daily_logs?.user_id === req.userId && t.daily_log_id !== log.id
    );

    const seenIds = new Set(todaysTasks.map((t) => t.id));
    const merged = [...todaysTasks];
    for (const t of persistingTasks) {
      if (!seenIds.has(t.id)) {
        delete t.daily_logs;
        merged.push(t);
        seenIds.add(t.id);
      }
    }

    res.json({ log, tasks: merged });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/tasks", async (req, res) => {
  try {
    const { description } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ error: "description is required" });
    }

    const goals = await getActiveGoals(req.userId);
    const log = await getOrCreateTodayLog(req.userId);

    const categorized = await categorizeSingleTask(description, goals);

    const inserted = await sb.post("tasks", {
      daily_log_id: log.id,
      description: categorized.description || description,
      goal_id: categorized.goal_id || null,
      scope: categorized.scope || "today",
      source: "added_later",
    });

    res.json({ ok: true, task: inserted[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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

router.patch("/tasks/:id/scope", async (req, res) => {
  try {
    const { scope } = req.body;
    if (scope !== "today" && scope !== "multi_day") {
      return res.status(400).json({ error: "scope must be 'today' or 'multi_day'" });
    }
    const updated = await sb.patch(`tasks?id=eq.${req.params.id}`, { scope });
    res.json({ ok: true, task: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review  { eveningSummary, moodNote }
// Stats now credit anything COMPLETED TODAY (by completed_at), not just tasks
// originally logged today — so finishing a multi-day task on day 3 counts on
// day 3's review, not lost, and not double-counted on day 1's already-closed review.
router.post("/review", async (req, res) => {
  try {
    const { eveningSummary, moodNote } = req.body;
    const log = await getOrCreateTodayLog(req.userId);
    const todayStr = today();
    const tomorrowStr = nextDayStr(todayStr);

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
        `daily_logs?select=id,log_date,evening_summary,embedding&user_id=eq.${req.userId}&embedding=not.is.null&id=neq.${log.id}`
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

    // Tasks originally logged today (whatever their scope)
    const ownTasks = await sb.get(`tasks?select=*&daily_log_id=eq.${log.id}`);

    // Multi-day tasks logged on OTHER days that are still relevant to today:
    // either still open (so they count toward the denominator as pending),
    // or completed exactly today (so today gets credit for finishing them).
    const carriedOverOpen = await sb.get(
      `tasks?select=*,daily_logs(user_id)&completed=eq.false&scope=eq.multi_day`
    );
    const carriedOverDoneToday = await sb.get(
      `tasks?select=*,daily_logs(user_id)&completed=eq.true&scope=eq.multi_day&completed_at=gte.${todayStr}T00:00:00.000Z&completed_at=lt.${tomorrowStr}T00:00:00.000Z`
    );

    const relevantCarriedOver = [...carriedOverOpen, ...carriedOverDoneToday].filter(
      (t) => t.daily_logs?.user_id === req.userId && t.daily_log_id !== log.id
    );

    const seenIds = new Set(ownTasks.map((t) => t.id));
    const tasksForToday = [...ownTasks];
    for (const t of relevantCarriedOver) {
      if (!seenIds.has(t.id)) {
        delete t.daily_logs;
        tasksForToday.push(t);
        seenIds.add(t.id);
      }
    }

    const completedCount = tasksForToday.filter((t) => t.completed).length;

    res.json({ ok: true, completedCount, totalCount: tasksForToday.length, similarDay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/push/subscribe", async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: "Valid subscription object is required" });
    }

    await sb.upsert(
      "push_subscriptions",
      {
        user_id: req.userId,
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

module.exports = router;