// Supabase Edge Function: realestate
// 관심 위치 저장, 지도 좌표 -> 지번·공시지가, 아파트 실거래가, 한국부동산원 주간 동향 중계
// 배포: supabase functions deploy realestate --no-verify-jwt
// 필요한 비밀값(secrets): APP_PASSWORD, VWORLD_KEY, VWORLD_DOMAIN, DATA_GO_KR_KEY,
//                        REB_KEY, REB_SALE_STATBL_ID, REB_JEONSE_STATBL_ID
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-password, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

const env = (k: string) => Deno.env.get(k) ?? "";

// ---------- 날짜 ----------
// 한국시간 기준 이번 주 월요일(YYYY-MM-DD)
function weekMonday(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay(); // 0=일
  const diff = day === 0 ? 6 : day - 1;
  kst.setUTCDate(kst.getUTCDate() - diff);
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
  const r = await fetch(u);
  const j = await r.json();
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

// 개별공시지가 연도별 이력 (원/㎡)
async function landPriceHistory(pnu: string) {
  const u = new URL("https://api.vworld.kr/ned/data/getIndvdLandPriceAttr");
  u.searchParams.set("key", env("VWORLD_KEY"));
  u.searchParams.set("domain", env("VWORLD_DOMAIN"));
  u.searchParams.set("pnu", pnu);
  u.searchParams.set("format", "json");
  u.searchParams.set("numOfRows", "30");
  u.searchParams.set("pageNo", "1");
  try {
    const r = await fetch(u);
    const j = await r.json();
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

async function regionFor(addr: string) {
  const t = addr.trim().split(/\s+/);
  const sido = t[0] ?? "";
  const sigungu = t[1] ?? "";
  const { data } = await sb.from("region_weekly").select("*").order("wrttime", { ascending: false }).limit(5000);
  const pick = (kind: string, name: string) =>
    (data ?? [])
      .filter((r: any) => r.kind === kind && name && r.region.includes(name))
      .slice(0, 8)
      .map((r: any) => ({ region: r.region, week: r.wrttime, pct: r.value }));
  return {
    sale: pick("sale", sigungu).length ? pick("sale", sigungu) : pick("sale", sido),
    jeonse: pick("jeonse", sigungu).length ? pick("jeonse", sigungu) : pick("jeonse", sido),
  };
}

// ---------- 스냅샷 ----------
async function makeSnapshot(place: any) {
  const [history, trades] = await Promise.all([
    landPriceHistory(place.pnu),
    aptTrades(place.pnu, place.addr ?? ""),
  ]);
  const cur = await lookupParcel(place.lat, place.lng).catch(() => null);
  const payload = {
    land: {
      year: cur?.gosiYear ?? history[0]?.year ?? null,
      won_per_m2: cur?.jiga ?? history[0]?.won_per_m2 ?? null,
      history,
    },
    trades,
  };
  const week = weekMonday();
  const { error } = await sb.from("snapshots").upsert({ place_id: place.id, week, payload });
  if (error) throw new Error(error.message);
  return { week, payload };
}

// ---------- 라우터 ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const pw = req.headers.get("x-app-password") ?? "";
    if (!env("APP_PASSWORD") || pw !== env("APP_PASSWORD")) return json({ error: "비밀번호가 맞지 않습니다." }, 401);

    const url = new URL(req.url);
    const op = url.searchParams.get("op") ?? "";
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (op === "lookup") {
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "좌표가 올바르지 않습니다." }, 400);
      const p = await lookupParcel(lat, lng);
      return json({ ...p, history: await landPriceHistory(p.pnu) });
    }

    if (op === "list") {
      const { data: places, error } = await sb.from("places").select("*").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const out = [];
      for (const p of places ?? []) {
        const { data: snaps } = await sb
          .from("snapshots").select("week,payload").eq("place_id", p.id)
          .order("week", { ascending: false }).limit(8);
        out.push({ ...p, snapshots: snaps ?? [], region: await regionFor(p.addr ?? "") });
      }
      return json({ places: out });
    }

    if (op === "add") {
      const { name, memo, lat, lng } = body;
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "이름과 위치가 필요합니다." }, 400);
      const parcel = await lookupParcel(lat, lng);
      const { data, error } = await sb.from("places")
        .upsert({ name, memo: memo ?? null, lat, lng, pnu: parcel.pnu, addr: parcel.addr, jibun: parcel.jibun }, { onConflict: "pnu" })
        .select().single();
      if (error) throw new Error(error.message);
      await makeSnapshot(data);
      return json({ ok: true, place: data });
    }

    if (op === "delete") {
      const { id } = body;
      const { error } = await sb.from("places").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    // 주 1회 자동 호출(GitHub Actions) 또는 화면의 '지금 새로고침'
    if (op === "refresh") {
      const region = { sale: await fetchRegionWeekly("sale").catch((e) => ({ error: String(e) })),
                       jeonse: await fetchRegionWeekly("jeonse").catch((e) => ({ error: String(e) })) };
      const { data: places } = await sb.from("places").select("*");
      let done = 0;
      for (const p of places ?? []) { await makeSnapshot(p); done++; }
      return json({ ok: true, week: weekMonday(), places: done, region });
    }

    return json({ error: "알 수 없는 요청입니다." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
