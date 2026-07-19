const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1/sleep_events`;
const NOTES_REST = `${SUPABASE_URL}/rest/v1/night_notes`;
const TZ = "Asia/Jerusalem";
const DAY_START_HOUR = 8; // a tracked day runs 08:00 -> 08:00 Israel time
const NIGHT_HOUR = 17; // 17:00 -> 08:00 is the night portion, used for the report stats
const EVENT_TYPES = ["woke_slept", "breastfed", "fell_asleep", "woke_up", "solid_food", "bottle", "pain_med"];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

// Israel calendar date (YYYY-MM-DD) of the current tracked day:
// today if we're past 08:00 Israel time, otherwise yesterday
function currentDayDate(): string {
  const now = new Date();
  const israelNow = new Date(now.getTime() + tzOffsetMs(now));
  if (israelNow.getUTCHours() < DAY_START_HOUR) {
    israelNow.setUTCDate(israelNow.getUTCDate() - 1);
  }
  return israelNow.toISOString().slice(0, 10);
}

// 08:00 Israel time on the given date -> UTC instant
function dayStartOf(dateStr: string): Date | null {
  const m = DATE_RE.exec(dateStr);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], DAY_START_HOUR);
  return new Date(naive - tzOffsetMs(new Date(naive)));
}

// "HH:MM" Israel time within the given tracked day -> UTC instant.
// Hours past the day-start hour belong to the day's first calendar date, earlier hours to the next.
function parseDayTime(hhmm: string, dateStr: string): Date | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm ?? "");
  const d = DATE_RE.exec(dateStr);
  if (!m || !d) return null;
  const hh = +m[1], mm = +m[2];
  let day = +d[3];
  if (hh < DAY_START_HOUR) day += 1;
  const naive = Date.UTC(+d[1], +d[2] - 1, day, hh, mm);
  return new Date(naive - tzOffsetMs(new Date(naive)));
}

function israelTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function israelHour(iso: string): number {
  return +israelTime(iso).slice(0, 2);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function addEvent(type: string, time?: string, date?: string, note?: string): Promise<Response> {
  if (!EVENT_TYPES.includes(type)) return json({ error: "bad event type" }, 400);
  const row: Record<string, string> = { event_type: type };
  if (time !== undefined) {
    const at = parseDayTime(time, date ?? currentDayDate());
    if (!at) return json({ error: "bad time, expected HH:MM" }, 400);
    row.created_at = at.toISOString();
  }
  if (note) row.note = note;
  const res = await fetch(REST, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const [saved] = await res.json();
  return json({ ok: true, time: israelTime(saved.created_at) });
}

async function updateEvent(id: string, time?: string, date?: string, note?: string): Promise<Response> {
  const patch: Record<string, string | null> = {};
  if (time !== undefined) {
    const at = parseDayTime(time, date ?? currentDayDate());
    if (!at) return json({ error: "bad time, expected HH:MM" }, 400);
    patch.created_at = at.toISOString();
  }
  if (note !== undefined) patch.note = note || null;
  if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
  const res = await fetch(`${REST}?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...dbHeaders, Prefer: "return=representation" },
    body: JSON.stringify(patch),
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
  const since = dayStartOf(currentDayDate())!.toISOString();
  const res = await fetch(
    `${REST}?created_at=gte.${since}&order=created_at.desc&limit=1`,
    { headers: dbHeaders },
  );
  const [last] = await res.json();
  if (!last) return json({ ok: false, message: "nothing to undo" });
  await fetch(`${REST}?id=eq.${last.id}`, { method: "DELETE", headers: dbHeaders });
  return json({ ok: true, undone: last.event_type, time: israelTime(last.created_at) });
}

async function saveNightNote(date: string, note: string): Promise<Response> {
  if (!DATE_RE.test(date ?? "")) return json({ error: "bad date" }, 400);
  const res = await fetch(`${NOTES_REST}?on_conflict=night_date`, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ night_date: date, note: note ?? "", updated_at: new Date().toISOString() }),
  });
  return json({ ok: res.ok });
}

// All rows from a PostgREST endpoint, paging past the server's max-rows cap
async function fetchAll(url: string): Promise<unknown[]> {
  const page = 1000;
  const out: unknown[] = [];
  for (let from = 0; ; from += page) {
    const res = await fetch(url, {
      headers: { ...dbHeaders, Range: `${from}-${from + page - 1}` },
    });
    const rows = await res.json();
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

async function analytics(): Promise<Response> {
  const [events, notes] = await Promise.all([
    fetchAll(`${REST}?select=id,event_type,created_at,note&order=created_at.asc`),
    fetchAll(`${NOTES_REST}?select=night_date,note`),
  ]);
  return json({ events, notes, currentNight: currentDayDate() });
}

async function report(dateStr?: string): Promise<Response> {
  const date = dateStr ?? currentDayDate();
  const start = dayStartOf(date);
  if (!start) return json({ error: "bad date" }, 400);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const [evRes, noteRes] = await Promise.all([
    fetch(
      `${REST}?created_at=gte.${start.toISOString()}&created_at=lt.${end.toISOString()}&order=created_at.asc`,
      { headers: dbHeaders },
    ),
    fetch(`${NOTES_REST}?night_date=eq.${date}&select=note`, { headers: dbHeaders }),
  ]);
  const rows: { id: number; event_type: string; created_at: string; note: string | null }[] =
    await evRes.json();
  const [noteRow] = await noteRes.json();
  const events = rows.map((r) => ({
    id: r.id,
    type: r.event_type,
    time: israelTime(r.created_at),
    note: r.note || "",
  }));
  // Stats cover only the night portion of the day (17:00 -> 08:00)
  const nightRows = rows.filter((r) => {
    const h = israelHour(r.created_at);
    return h >= NIGHT_HOUR || h < DAY_START_HOUR;
  });
  const bedtime = nightRows.find((r) => r.event_type === "fell_asleep");
  // A woke_up only counts as a night wake-up when a fell_asleep follows it
  // (an awake window); otherwise it is the morning wake
  const wakeUps = nightRows.filter((r, i) =>
    r.event_type === "woke_slept" ||
    (r.event_type === "woke_up" &&
      nightRows.slice(i + 1).some((n) => n.event_type === "fell_asleep"))
  ).length;
  return json({
    date,
    isCurrent: date === currentDayDate(),
    dayStart: israelTime(start.toISOString()),
    bedtime: bedtime ? israelTime(bedtime.created_at) : null,
    wakeUps,
    feeds: nightRows.filter((r) => r.event_type === "breastfed").length,
    note: noteRow?.note ?? "",
    events,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/app/, "").replace(/\/$/, "") || "/";
  const idMatch = /^\/api\/event\/(\d+)$/.exec(path);

  if (req.method === "POST" && path === "/api/event") {
    const { type, time, date, note } = await req.json().catch(() => ({}));
    return addEvent(type, time, date, note);
  }
  if (req.method === "PATCH" && idMatch) {
    const { time, date, note } = await req.json().catch(() => ({}));
    return updateEvent(idMatch[1], time, date, note);
  }
  if (req.method === "DELETE" && idMatch) return deleteEvent(idMatch[1]);
  if (req.method === "POST" && path === "/api/undo") return undoLast();
  if (req.method === "POST" && path === "/api/night-note") {
    const { date, note } = await req.json().catch(() => ({}));
    return saveNightNote(date, note);
  }
  if (req.method === "GET" && path === "/api/report") {
    return report(url.searchParams.get("date") ?? undefined);
  }
  if (req.method === "GET" && path === "/api/analytics") return analytics();

  return json({ error: "not found" }, 404);
});
