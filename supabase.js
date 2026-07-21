// Thin wrapper around Supabase's REST API (PostgREST).
// Uses Node's built-in fetch (Node 18+, matches AXE's runtime on Render).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment.");
}

const baseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function sbRequest(method, path, { body, returnRepresentation = true } = {}) {
  const headers = { ...baseHeaders };
  if (returnRepresentation) headers.Prefer = "return=representation";

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${errText}`);
  }

  // 204 No Content or empty body
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbUpsert(path, body, onConflict) {
  const headers = { ...baseHeaders, Prefer: "resolution=merge-duplicates,return=representation" };
  const url = `${SUPABASE_URL}/rest/v1/${path}?on_conflict=${onConflict}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase UPSERT ${path} failed: ${res.status} ${errText}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const sb = {
  get: (path) => sbRequest("GET", path),
  post: (path, body) => sbRequest("POST", path, { body }),
  patch: (path, body) => sbRequest("PATCH", path, { body }),
  upsert: (path, body, onConflict) => sbUpsert(path, body, onConflict),
};

module.exports = { sb };