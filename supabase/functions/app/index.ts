const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1/sleep_events`;
const TZ = "Asia/Jerusalem";
const NIGHT_START_HOUR = 17;

const dbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function tzOffsetMs(date: Date): number {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(date.toLocaleString("en-US", { timeZone: TZ }));
  return local.getTime() - utc.getTime();
}

// The "night" starts at 17:00 Israel time (today if we're past it, otherwise yesterday)
function nightStart(): Date {
  const now = new Date();
  const offset = tzOffsetMs(now);
  const israelNow = new Date(now.getTime() + offset);
  let y = israelNow.getUTCFullYear(), m = israelNow.getUTCMonth(), d = israelNow.getUTCDate();
  if (israelNow.getUTCHours() < NIGHT_START_HOUR) d -= 1;
  return new Date(Date.UTC(y, m, d, NIGHT_START_HOUR) - offset);
}

function israelTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function addEvent(type: string): Promise<Response> {
  if (type !== "woke_slept" && type !== "breastfed") {
    return json({ error: "bad event type" }, 400);
  }
  const res = await fetch(REST, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ event_type: type }),
  });
  const [row] = await res.json();
  return json({ ok: true, time: israelTime(row.created_at) });
}

async function undoLast(): Promise<Response> {
  const since = nightStart().toISOString();
  const res = await fetch(
    `${REST}?created_at=gte.${since}&order=created_at.desc&limit=1`,
    { headers: dbHeaders },
  );
  const [last] = await res.json();
  if (!last) return json({ ok: false, message: "nothing to undo" });
  await fetch(`${REST}?id=eq.${last.id}`, { method: "DELETE", headers: dbHeaders });
  return json({ ok: true, undone: last.event_type, time: israelTime(last.created_at) });
}

async function report(): Promise<Response> {
  const since = nightStart().toISOString();
  const res = await fetch(
    `${REST}?created_at=gte.${since}&order=created_at.asc`,
    { headers: dbHeaders },
  );
  const rows = await res.json();
  const events = rows.map((r: { event_type: string; created_at: string }) => ({
    type: r.event_type,
    time: israelTime(r.created_at),
  }));
  return json({
    nightStart: israelTime(since),
    wakeUps: events.filter((e: { type: string }) => e.type === "woke_slept").length,
    feeds: events.filter((e: { type: string }) => e.type === "breastfed").length,
    events,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/app/, "").replace(/\/$/, "") || "/";

  if (req.method === "POST" && path === "/api/event") {
    const { type } = await req.json().catch(() => ({}));
    return addEvent(type);
  }
  if (req.method === "POST" && path === "/api/undo") return undoLast();
  if (req.method === "GET" && path === "/api/report") return report();

  return json({ error: "not found" }, 404);
});
