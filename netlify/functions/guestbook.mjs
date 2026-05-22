// netlify/functions/guestbook.mjs
// Handles POST only — adding new guestbook entries.
// Reads are done client-side via a read-only Upstash token.
//
// Requires env vars:
//   UPSTASH_REDIS_REST_URL   — Upstash REST endpoint
//   UPSTASH_REDIS_REST_TOKEN — full read/write token (never exposed to browser)
//
// Storage layout:
//   guestbook:entries   — public LIST of JSON entry objects (no PII), newest first
//   guestbook:meta      — private LIST of JSON meta objects (PII), newest first
//                         only accessible with the write token
//
// Both LPUSHes are sent as a single MULTI/EXEC transaction so they either
// both succeed or both fail — no partial writes.

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_RW_TOKEN;

const LIST_KEY = "guestbook:entries";
const META_KEY = "guestbook:meta";

const MAX_MSG_LEN  = 500;
const MAX_NAME_LEN = 60;

// ---------------------------------------------------------------------------
// Upstash multi-exec transaction — all commands execute atomically
// ---------------------------------------------------------------------------
async function redisTransaction(commands) {
  const res = await fetch(`${REDIS_URL}/multi-exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  
  if (!res.ok) throw new Error(`Redis transaction failed: ${res.status}`);
  const results = await res.json();
  
  // Performance tweak: .some() is faster and memory-lean for boolean checks
  if (results.some(r => r.error)) throw new Error("Redis command error.");
  return results;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Performance tweak: Native Response.json() runs at the C++ layer
// and automatically manages the Content-Type header.
function respond(status, body) {
  return Response.json(body, { status, headers: CORS });
}

// ---------------------------------------------------------------------------
// Handler — modern Netlify Functions API (Request + Context)
// ---------------------------------------------------------------------------
export default async (request, context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== "POST") {
    return respond(405, { error: "Method not allowed." });
  }

  // Memory tweak: Terminate early if the payload is suspiciously large
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > 3000) { 
    return respond(413, { error: "Payload too large." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return respond(400, { error: "Invalid JSON." });
  }

  // Honeypot
  if (body.website) {
    return respond(200, { ok: true });
  }

  // Memory tweak: Safe fallback to avoid extra string allocations if undefined
  const message = body.message ? String(body.message).trim() : "";
  const name    = body.name ? String(body.name).trim() : "";

  if (!message)
    return respond(400, { error: "Message is required." });
  if (message.length > MAX_MSG_LEN)
    return respond(400, { error: `Message must be ${MAX_MSG_LEN} characters or fewer.` });
  if (name.length > MAX_NAME_LEN)
    return respond(400, { error: `Name must be ${MAX_NAME_LEN} characters or fewer.` });

  const id = crypto.randomUUID();

  // ── Public entry (no PII) ──────────────────────────────────────────────
  const entry = {
    id,
    name:      name || null,
    message,
    timestamp: new Date().toISOString(),
  };

  // ── Private meta (PII) ────────────────────────────────────────────────
  const geo = context.geo ?? {};
  const meta = {
    id,
    ip:          context.ip ?? null,
    city:        geo.city ?? null,
    countryCode: geo.country?.code ?? null,
    countryName: geo.country?.name ?? null,
    subCode:     geo.subdivision?.code ?? null,
    subName:     geo.subdivision?.name ?? null,
  };

  try {
    // Atomic transaction — both LPUSHes succeed or neither does
    await redisTransaction([
      ["LPUSH", LIST_KEY, JSON.stringify(entry)],
      ["LPUSH", META_KEY,  JSON.stringify(meta)],
    ]);

    return respond(201, { ok: true, entry });
  } catch (err) {
    console.error("Redis transaction error:", err);
    return respond(500, { error: "Failed to save entry." });
  }
};
