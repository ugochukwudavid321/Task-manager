const { getUserFromToken } = require("./supabase");

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not signed in" });
  }
  const token = authHeader.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) {
    return res.status(401).json({ error: "Session expired, please sign in again" });
  }
  req.userId = user.id;
  req.userEmail = user.email;
  req.userName = user.user_metadata?.full_name || null;
  next();
}

module.exports = { requireAuth };