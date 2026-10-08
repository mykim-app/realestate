// Supabase Edge Function: realestate
// 보관 코드(6자리 영문+숫자)로 관심 위치 저장·조회, 관리자는 이메일 인증번호로 전체 열람
// 필요한 비밀값(Secrets): VWORLD_KEY, VWORLD_DOMAIN, DATA_GO_KR_KEY, CRON_KEY, ADMIN_EMAIL,
//                        REB_KEY, REB_SALE_STATBL_ID, REB_JEONSE_STATBL_ID (뒤 3개는 선택)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-token, x-cron-key, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
const env = (k: string) => Deno.env.get(k) ?? "";

const MAX_PLACES_PER_CODE = 30;

// ---------- 보관 코드 ----------
const normCode = (s: unknown) => String(s ?? "").trim().toUpperCase();
const validCode = (c: string) => /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{6}$/.test(c);
function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 글자(0, O, 1, I) 제외
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(6));
    const c = Array.from(b, (x) => chars[x % chars.length]).join("");
    if (validCode(c)) return c;
  }
}

// 간단한 호출 횟수 제한(함수 인스턴스 안에서만 동작하는 보조 장치)
const hits = new Map<string, number[]>();
function throttled(ip: string, limit = 60): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > limit;
}

// ---------- 날짜 ----------
function weekMonday(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay();
  kst.setUTCDate(kst.getUTCDate() - (day === 0 ? 6 : day - 1));
  return kst.toISOString().slice(0, 10);
}
function yyyymm(offsetMonths: number): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(1);
  kst.setUTCMonth(kst.getUTCMonth() - offsetMonths);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------- VWorld: 좌표 -> 필지(지번·PNU·공시지가) ----------
async function lookupParcel(lat: number, lng: number) {
  const u = new URL("https://api.vworld.kr/req/data");
  u.searchParams.set("service", "data");
  u.searchParams.set("request", "GetFeature");
  u.searchParams.set("data", "LP_PA_CBND_BUBUN");
  u.searchParams.set("key", env("VWORLD_KEY"));
  u.searchParams.set("domain", env("VWORLD_DOMAIN"));
  u.searchParams.set("geomFilter", `POINT(${lng} ${lat})`);
  u.searchParams.set("geometry", "false");
  u.searchParams.set("size", "1");
  u.searchParams.set("format", "json");
  const j = await (await fetch(u)).json();
  const f = j?.response?.result?.featureCollection?.features?.[0];
  if (!f) throw new Error("해당 좌표에서 필지를 찾지 못했습니다. 지도에서 건물·토지 위를 다시 눌러 주세요.");
  const p = f.properties ?? {};
  return {
    pnu: String(p.pnu),
    addr: String(p.addr ?? ""),
    jibun: String(p.jibun ?? ""),
    jiga: p.jiga != null ? Number(p.jiga) : null, // 원/㎡
    gosiYear: p.gosi_year ? String(p.gosi_year) : null,
  };
}

// 주소·건물·단지 이름 검색 (브이월드 검색: 도로명 + 지번 + 장소)
async function geocode(q: string) {
  const search = async (type: string, category?: string) => {
    const u = new URL("https://api.vworld.kr/req/search");
    u.searchParams.set("service", "search");
    u.searchParams.set("request", "search");
    u.searchParams.set("version", "2.0");
    u.searchParams.set("crs", "EPSG:4326");
    u.searchParams.set("size", "5");
    u.searchParams.set("page", "1");
    u.searchParams.set("query", q);
    u.searchParams.set("type", type);
    if (category) u.searchParams.set("category", category);
    u.searchParams.set("format", "json");
    u.searchParams.set("key", env("VWORLD_KEY"));
    u.searchParams.set("domain", env("VWORLD_DOMAIN"));
    try {
      const j = await (await fetch(u)).json();
      return j?.response?.result?.items ?? [];
    } catch { return []; }
  };
  const [road, parcel, place] = await Promise.all([
    search("ADDRESS", "road"), search("ADDRESS", "parcel"), search("PLACE"),
  ]);
  const out: { label: string; sub: string; lat: number; lng: number }[] = [];
  const seen = new Set<string>();
  const push = (it: any, isPlace: boolean) => {
    const lng = Number(it?.point?.x), lat = Number(it?.point?.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const a = it.address ?? {};
    const label = isPlace ? String(it.title ?? "") : String(a.road || a.parcel || "");
    const sub = isPlace ? String(a.road || a.parcel || "") : (a.road && a.parcel ? String(a.parcel) : "");
    if (!label || seen.has(label + sub)) return;
    seen.add(label + sub);
    out.push({ label, sub, lat, lng });
  };
  for (const it of road) push(it, false);
  for (const it of parcel) push(it, false);
  for (const it of place) push(it, true);
  return out.slice(0, 10);
}

async function landPriceHistory(pnu: string) {
  const u = new URL("https://api.vworld.kr/ned/data/getIndvdLandPriceAttr");
  u.searchParams.set("key", env("VWORLD_KEY"));
  u.searchParams.set("domain", env("VWORLD_DOMAIN"));
  u.searchParams.set("pnu", pnu);
  u.searchParams.set("format", "json");
  u.searchParams.set("numOfRows", "30");
  u.searchParams.set("pageNo", "1");
  try {
    const j = await (await fetch(u)).json();
    const rows = j?.indvdLandPrices?.field ?? [];
    return (Array.isArray(rows) ? rows : [rows])
      .map((x: any) => ({ year: String(x.stdrYear), won_per_m2: Number(x.pblntfPclnd) }))
      .filter((x: any) => x.year && Number.isFinite(x.won_per_m2))
      .sort((a: any, b: any) => b.year.localeCompare(a.year));
  } catch {
    return [];
  }
}

// ---------- 국토부 아파트 매매 실거래가 ----------
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
}
function parcelJibun(pnu: string): string {
  const san = pnu[10] === "2" ? "산" : "";
  const bon = parseInt(pnu.slice(11, 15), 10);
  const bu = parseInt(pnu.slice(15, 19), 10);
  return `${san}${bon}${bu ? "-" + bu : ""}`;
}
async function aptTrades(pnu: string, addr: string, months = 3) {
  const lawd = pnu.slice(0, 5);
  const jibun = parcelJibun(pnu);
  const tokens = addr.trim().split(/\s+/);
  const dong = tokens.length >= 2 ? tokens[tokens.length - 2] : "";
  const out: any[] = [];
  for (let i = 0; i < months; i++) {
    const u = new URL("https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev");
    u.searchParams.set("serviceKey", env("DATA_GO_KR_KEY"));
    u.searchParams.set("LAWD_CD", lawd);
    u.searchParams.set("DEAL_YMD", yyyymm(i));
    u.searchParams.set("numOfRows", "1000");
    u.searchParams.set("pageNo", "1");
    try {
      const xml = await (await fetch(u)).text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const b = m[1];
        if (tag(b, "jibun") !== jibun) continue;
        if (dong && tag(b, "umdNm") !== dong) continue;
        if (tag(b, "cdealType") === "O") continue; // 해제(취소) 거래 제외
        out.push({
          apt: tag(b, "aptNm"),
          date: `${tag(b, "dealYear")}-${tag(b, "dealMonth").padStart(2, "0")}-${tag(b, "dealDay").padStart(2, "0")}`,
          price_manwon: parseInt(tag(b, "dealAmount").replace(/,/g, ""), 10), // 만원
          area_m2: parseFloat(tag(b, "excluUseAr")), // 전용면적 ㎡
          floor: tag(b, "floor"),
        });
      }
    } catch { /* 해당 월 조회 실패 시 건너뜀 */ }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}

// ---------- 한국부동산원 주간 아파트 동향 (R-ONE) ----------
async function fetchRegionWeekly(kind: "sale" | "jeonse") {
  const id = env(kind === "sale" ? "REB_SALE_STATBL_ID" : "REB_JEONSE_STATBL_ID");
  if (!id || !env("REB_KEY")) return { skipped: true, inserted: 0 };
  const u = new URL("https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do");
  u.searchParams.set("KEY", env("REB_KEY"));
  u.searchParams.set("STATBL_ID", id);
  u.searchParams.set("DTACYCLE_CD", "WK");
  u.searchParams.set("START_WRTTIME", yyyymm(2) + "01");
  u.searchParams.set("Type", "json");
  u.searchParams.set("pSize", "1000");
  const j = await (await fetch(u)).json();
  const rows = j?.SttsApiTblData?.[1]?.row ?? [];
  const recs = rows
    .map((r: any) => ({
      kind,
      region: String(r.CLS_FULLNM ?? r.CLS_NM ?? ""),
      wrttime: String(r.WRTTIME_DESC ?? r.WRTTIME_IDTFR_ID ?? ""),
      value: r.DTA_VAL != null ? Number(r.DTA_VAL) : null,
    }))
    .filter((r: any) => r.region && r.wrttime);
  if (recs.length) {
    const { error } = await sb.from("region_weekly").upsert(recs);
    if (error) throw new Error(error.message);
  }
  return { skipped: false, inserted: recs.length };
}

let regionCache: any[] | null = null;
let regionCacheAt = 0;
async function regionFor(addr: string) {
  if (!regionCache || Date.now() - regionCacheAt > 5 * 60_000) {
    const { data } = await sb.from("region_weekly").select("*").order("wrttime", { ascending: false }).limit(5000);
    regionCache = data ?? [];
    regionCacheAt = Date.now();
  }
  const t = addr.trim().split(/\s+/);
  const sido = t[0] ?? "", sigungu = t[1] ?? "";
  const pick = (kind: string, name: string) =>
    regionCache!
      .filter((r: any) => r.kind === kind && name && r.region.includes(name))
      .slice(0, 8)
      .map((r: any) => ({ region: r.region, week: r.wrttime, pct: r.value }));
  const sale = pick("sale", sigungu), jeonse = pick("jeonse", sigungu);
  return { sale: sale.length ? sale : pick("sale", sido), jeonse: jeonse.length ? jeonse : pick("jeonse", sido) };
}

// ---------- 스냅샷 ----------
async function makeSnapshot(place: any) {
  const [history, trades] = await Promise.all([landPriceHistory(place.pnu), aptTrades(place.pnu, place.addr ?? "")]);
  const cur = await lookupParcel(place.lat, place.lng).catch(() => null);
  const payload = {
    land: {
      year: cur?.gosiYear ?? history[0]?.year ?? null,
      won_per_m2: cur?.jiga ?? history[0]?.won_per_m2 ?? null,
      history,
    },
    trades,
  };
  const { error } = await sb.from("snapshots").upsert({
    place_id: place.id, week: weekMonday(), payload, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function placesWithData(rows: any[]) {
  const out = [];
  for (const p of rows) {
    const { data: snaps } = await sb.from("snapshots").select("week,payload")
      .eq("place_id", p.id).order("week", { ascending: false }).limit(8);
    out.push({ ...p, snapshots: snaps ?? [], region: await regionFor(p.addr ?? "") });
  }
  return out;
}

// ---------- 관리자 (이메일 인증번호) ----------
async function isAdmin(req: Request): Promise<boolean> {
  const token = req.headers.get("x-admin-token") ?? "";
  if (!token || !env("ADMIN_EMAIL")) return false;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user?.email) return false;
  return data.user.email.toLowerCase() === env("ADMIN_EMAIL").toLowerCase();
}

// ---------- 라우터 ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    if (throttled(ip)) return json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." }, 429);

    const url = new URL(req.url);
    const op = url.searchParams.get("op") ?? "";
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // --- 누구나 ---
    if (op === "lookup") {
      const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "좌표가 올바르지 않습니다." }, 400);
      const p = await lookupParcel(lat, lng);
      return json({ ...p, history: await landPriceHistory(p.pnu) });
    }

    if (op === "geocode") {
      const q = String(url.searchParams.get("q") ?? "").trim();
      if (q.length < 2 || q.length > 100) return json({ error: "검색어는 두 글자 이상 입력해 주세요." }, 400);
      return json({ items: await geocode(q) });
    }

    if (op === "suggest_code") {
      for (let i = 0; i < 10; i++) {
        const c = randomCode();
        const { count } = await sb.from("places").select("id", { count: "exact", head: true }).eq("code", c);
        if (!count) return json({ code: c });
      }
      return json({ error: "코드를 만들지 못했습니다. 다시 시도해 주세요." }, 500);
    }

    if (op === "list") {
      const code = normCode(url.searchParams.get("code"));
      if (!validCode(code)) return json({ error: "보관 코드는 영문과 숫자를 섞은 6자리입니다." }, 400);
      const { data, error } = await sb.from("places").select("*").eq("code", code).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return json({ places: await placesWithData(data ?? []) });
    }

    if (op === "add") {
      const code = normCode(body.code);
      const { name, memo, lat, lng } = body;
      if (!validCode(code)) return json({ error: "보관 코드는 영문과 숫자를 섞은 6자리입니다." }, 400);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "이름과 위치가 필요합니다." }, 400);
      const { count } = await sb.from("places").select("id", { count: "exact", head: true }).eq("code", code);
      if ((count ?? 0) >= MAX_PLACES_PER_CODE) return json({ error: `한 코드에는 ${MAX_PLACES_PER_CODE}곳까지 저장할 수 있습니다.` }, 400);
      const parcel = await lookupParcel(lat, lng);
      const { data, error } = await sb.from("places")
        .upsert({ code, name: String(name).slice(0, 60), memo: memo ? String(memo).slice(0, 200) : null, lat, lng, pnu: parcel.pnu, addr: parcel.addr, jibun: parcel.jibun },
          { onConflict: "code,pnu" })
        .select().single();
      if (error) throw new Error(error.message);
      await makeSnapshot(data);
      return json({ ok: true, code });
    }

    if (op === "delete") {
      const code = normCode(body.code);
      const { error } = await sb.from("places").delete().eq("id", body.id).eq("code", code);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    // 내 코드의 위치만 새로 불러오기 (최근 10분 이내 기록이 있으면 건너뜀)
    if (op === "refresh_mine") {
      const code = normCode(body.code);
      if (!validCode(code)) return json({ error: "보관 코드가 올바르지 않습니다." }, 400);
      const { data: places } = await sb.from("places").select("*").eq("code", code);
      let done = 0;
      for (const p of places ?? []) {
        const { data: s } = await sb.from("snapshots").select("updated_at").eq("place_id", p.id).order("week", { ascending: false }).limit(1);
        const last = s?.[0]?.updated_at ? Date.parse(s[0].updated_at) : 0;
        if (Date.now() - last < 10 * 60_000) continue;
        await makeSnapshot(p); done++;
      }
      return json({ ok: true, updated: done });
    }

    // --- 자동 갱신(GitHub Actions) 또는 관리자 ---
    if (op === "refresh") {
      const cronOk = env("CRON_KEY") && req.headers.get("x-cron-key") === env("CRON_KEY");
      if (!cronOk && !(await isAdmin(req))) return json({ error: "권한이 없습니다." }, 401);
      const region = {
        sale: await fetchRegionWeekly("sale").catch((e) => ({ error: String(e) })),
        jeonse: await fetchRegionWeekly("jeonse").catch((e) => ({ error: String(e) })),
      };
      regionCache = null;
      const { data: places } = await sb.from("places").select("*");
      let done = 0;
      for (const p of places ?? []) { await makeSnapshot(p); done++; }
      return json({ ok: true, week: weekMonday(), places: done, region });
    }

    // --- 관리자 인증: 관리자 메일로 인증번호 발송 -> 확인 ---
    if (op === "admin_request") {
      if (!env("ADMIN_EMAIL")) return json({ error: "관리자 메일이 설정되어 있지 않습니다." }, 500);
      const { error } = await sb.auth.signInWithOtp({ email: env("ADMIN_EMAIL"), options: { shouldCreateUser: true } });
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }
    if (op === "admin_verify") {
      const token = String(body.code ?? "").trim();
      if (!token) return json({ error: "인증번호를 입력해 주세요." }, 400);
      const { data, error } = await sb.auth.verifyOtp({ email: env("ADMIN_EMAIL"), token, type: "email" });
      if (error || !data?.session) return json({ error: "인증번호가 맞지 않거나 만료되었습니다." }, 401);
      return json({ ok: true, token: data.session.access_token });
    }

    // --- 관리자 전용 ---
    if (op === "admin_list") {
      if (!(await isAdmin(req))) return json({ error: "관리자 인증이 필요합니다." }, 401);
      const { data, error } = await sb.from("places").select("*").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const all = await placesWithData(data ?? []);
      const byCode: Record<string, any[]> = {};
      for (const p of all) (byCode[p.code ?? "(코드 없음)"] ||= []).push(p);
      return json({ total: all.length, codes: Object.entries(byCode).map(([code, places]) => ({ code, places })) });
    }
    // 한국부동산원 통계표 이름으로 ID 찾기 (Secrets에 넣을 통계표 ID 확인용)
    if (op === "reb_tables") {
      if (!(await isAdmin(req))) return json({ error: "관리자 인증이 필요합니다." }, 401);
      if (!env("REB_KEY")) return json({ error: "REB_KEY(한국부동산원 인증키)가 아직 Secrets에 없습니다." }, 400);
      const words = String(url.searchParams.get("kw") ?? "주간 아파트").trim().split(/\s+/).filter(Boolean);
      const u = new URL("https://www.reb.or.kr/r-one/openapi/SttsApiTbl.do");
      u.searchParams.set("KEY", env("REB_KEY"));
      u.searchParams.set("Type", "json");
      u.searchParams.set("pIndex", "1");
      u.searchParams.set("pSize", "1000");
      const j = await (await fetch(u)).json();
      const root: any = Object.values(j ?? {})[0];
      const rows: any[] = Array.isArray(root) ? (root.find((x: any) => x?.row)?.row ?? []) : [];
      const all = rows.map((r) => ({ id: String(r.STATBL_ID ?? ""), name: String(r.STATBL_NM ?? r.STATBL_NAME ?? "") }));
      const items = all.filter((r) => r.id && words.every((w) => r.name.includes(w))).slice(0, 60);
      return json({ items, total: all.length, hint: all.length ? "" : JSON.stringify(j).slice(0, 300) });
    }

    if (op === "admin_delete") {
      if (!(await isAdmin(req))) return json({ error: "관리자 인증이 필요합니다." }, 401);
      const { error } = await sb.from("places").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    return json({ error: "알 수 없는 요청입니다." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
