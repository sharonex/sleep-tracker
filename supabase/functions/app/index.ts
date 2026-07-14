const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1/sleep_events`;
const TZ = "Asia/Jerusalem";
const NIGHT_START_HOUR = 17;
const EVENT_TYPES = ["woke_slept", "breastfed", "fell_asleep"];

const dbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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

// "HH:MM" Israel time within the current night -> UTC instant.
// Hours past the night-start hour belong to the night's first calendar day, earlier hours to the next.
function parseNightTime(hhmm: string): Date | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm ?? "");
  if (!m) return null;
  const hh = +m[1], mm = +m[2];
  const start = nightStart();
  const offset = tzOffsetMs(start);
  const startLocal = new Date(start.getTime() + offset);
  let d = startLocal.getUTCDate();
  if (hh < NIGHT_START_HOUR) d += 1;
  return new Date(
    Date.UTC(startLocal.getUTCFullYear(), startLocal.getUTCMonth(), d, hh, mm) - offset,
  );
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

async function addEvent(type: string, time?: string): Promise<Response> {
  if (!EVENT_TYPES.includes(type)) return json({ error: "bad event type" }, 400);
  const row: Record<string, string> = { event_type: type };
  if (time !== undefined) {
    const at = parseNightTime(time);
    if (!at) return json({ error: "bad time, expected HH:MM" }, 400);
    row.created_at = at.toISOString();
  }
  const res = await fetch(REST, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const [saved] = await res.json();
  return json({ ok: true, time: israelTime(saved.created_at) });
}

async function updateEvent(id: string, time: string): Promise<Response> {
  const at = parseNightTime(time);
  if (!at) return json({ error: "bad time, expected HH:MM" }, 400);
  const res = await fetch(`${REST}?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...dbHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ created_at: at.toISOString() }),
  });
  const rows = await res.json();
  if (!rows.length) return json({ error: "not found" }, 404);
  return json({ ok: true, time: israelTime(rows[0].created_at) });
}

async function deleteEvent(id: string): Promise<Response> {
  await fetch(`${REST}?id=eq.${id}`, { method: "DELETE", headers: dbHeaders });
  return json({ ok: true });
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
  const events = rows.map((r: { id: number; event_type: string; created_at: string }) => ({
    id: r.id,
    type: r.event_type,
    time: israelTime(r.created_at),
  }));
  const bedtime = events.find((e: { type: string }) => e.type === "fell_asleep");
  return json({
    nightStart: israelTime(since),
    bedtime: bedtime ? bedtime.time : null,
    wakeUps: events.filter((e: { type: string }) => e.type === "woke_slept").length,
    feeds: events.filter((e: { type: string }) => e.type === "breastfed").length,
    events,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/app/, "").replace(/\/$/, "") || "/";
  const idMatch = /^\/api\/event\/(\d+)$/.exec(path);

  if (req.method === "POST" && path === "/api/event") {
    const { type, time } = await req.json().catch(() => ({}));
    return addEvent(type, time);
  }
  if (req.method === "PATCH" && idMatch) {
    const { time } = await req.json().catch(() => ({}));
    return updateEvent(idMatch[1], time);
  }
  if (req.method === "DELETE" && idMatch) return deleteEvent(idMatch[1]);
  if (req.method === "POST" && path === "/api/undo") return undoLast();
  if (req.method === "GET" && path === "/api/report") return report();

  return json({ error: "not found" }, 404);
});
