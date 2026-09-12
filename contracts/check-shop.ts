// 店面內部端點的契約檢查(對 SHOP-INTERNAL.md §1 §2)。
// 對一個跑著的店面服務打:/healthz、/readyz、/internal/config 的 GET / PUT(合併、冪等、400)。
// 用法:bun contracts/check-shop.ts http://127.0.0.1:18081 catalog
//       bun contracts/check-shop.ts http://127.0.0.1:19080/svc/catalog catalog   (假 stack 也要過)
// 只讀不寫:最後會把設定推回 v1 的出廠值。
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const service = process.argv[3] ?? "";
if (!base || !service) {
  console.error("用法:bun contracts/check-shop.ts <服務網址> <服務名>");
  process.exit(2);
}

// 出廠旋鈕表(SHOP-INTERNAL.md §2);其他服務是空表
const pristine: Record<string, Record<string, unknown>> = {
  catalog: { "db.leak_per_minute": 0 },
  cart: { error_rate: 0 },
  payment: { "provider.active": "primary", "provider.primary.error_rate": 0, "provider.primary.latency_ms": 80 },
  fulfillment: { "worker.process_ms": 200 },
  shipping: { "audit.verbosity": "info" },
};
const expectKnobs = pristine[service] ?? {};

let failed = 0;
function report(ok: boolean, name: string, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}
async function get(path: string) {
  const r = await fetch(base + path);
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}
async function put(body: string) {
  const r = await fetch(base + "/internal/config", { method: "PUT", headers: { "content-type": "application/json" }, body });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}
const isObj = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

const health = await get("/healthz");
report(health.status === 200, "GET /healthz 200", `status=${health.status}`);
const ready = await get("/readyz");
report(ready.status === 200 || ready.status === 503, "GET /readyz 200 或 503", `status=${ready.status}`);

const cfg = await get("/internal/config");
report(cfg.status === 200 && isObj(cfg.json), "GET /internal/config 200 且是 JSON 物件");
if (isObj(cfg.json)) {
  report(typeof cfg.json.revision === "string", "config.revision 是字串", `revision=${cfg.json.revision}`);
  report(isObj(cfg.json.knobs), "config.knobs 是物件");
  const keys = Object.keys(cfg.json.knobs ?? {}).sort();
  const want = Object.keys(expectKnobs).sort();
  report(JSON.stringify(keys) === JSON.stringify(want), `knobs 的鍵跟 §2 的 ${service} 旋鈕表一樣`, `有=${keys.join(",") || "(空)"} 要=${want.join(",") || "(空)"}`);
  for (const [k, v] of Object.entries(expectKnobs)) {
    const got = cfg.json.knobs?.[k];
    report(typeof got === typeof v, `knob ${k} 型別 ${typeof v}`, `拿到 ${JSON.stringify(got)}`);
  }
}

// 合併語意:只送一顆旋鈕,其他旋鈕要留著
const firstKnob = Object.keys(expectKnobs)[0];
if (firstKnob !== undefined) {
  const newVal = typeof expectKnobs[firstKnob] === "number" ? (expectKnobs[firstKnob] as number) + 1 : "secondary";
  const p1 = await put(JSON.stringify({ revision: "v2-check", knobs: { [firstKnob]: newVal } }));
  report(p1.status === 200 && p1.json?.revision === "v2-check", "PUT 一顆旋鈕 → 200、revision 變 v2-check", `status=${p1.status}`);
  const after = await get("/internal/config");
  const keysAfter = Object.keys(after.json?.knobs ?? {}).sort();
  report(JSON.stringify(keysAfter) === JSON.stringify(Object.keys(expectKnobs).sort()), "PUT 是合併:其他旋鈕還在", `鍵=${keysAfter.join(",")}`);
  report(after.json?.knobs?.[firstKnob] === newVal, `PUT 後 ${firstKnob} 反映新值`, `=${JSON.stringify(after.json?.knobs?.[firstKnob])}`);
  const p2 = await put(JSON.stringify({ revision: "v2-check", knobs: { [firstKnob]: newVal } }));
  report(p2.status === 200, "同樣的 PUT 再送一次 → 200(冪等)", `status=${p2.status}`);
  // 回 v1:送完整出廠表
  const p3 = await put(JSON.stringify({ revision: "v1", knobs: expectKnobs }));
  const back = await get("/internal/config");
  report(p3.status === 200 && back.json?.revision === "v1" && JSON.stringify(back.json?.knobs) === JSON.stringify({ ...back.json?.knobs, ...expectKnobs }), "PUT 完整出廠表回 v1", `revision=${back.json?.revision}`);
}
const bad = await put("not json");
report(bad.status === 400, "壞 JSON → 400", `status=${bad.status}`);
const notObj = await put("[1,2]");
report(notObj.status === 400, "body 不是物件 → 400", `status=${notObj.status}`);

if (service === "shipping") {
  const r = await fetch(base + "/internal/volume/rotate", { method: "POST" });
  const j: any = await r.json().catch(() => null);
  report(r.status === 200 && typeof j?.freed_bytes === "number", "POST /internal/volume/rotate → {freed_bytes}", `status=${r.status}`);
}

console.log(failed === 0 ? "check-shop: 全部通過" : `check-shop: ${failed} 項沒過`);
process.exit(failed === 0 ? 0 : 1);
