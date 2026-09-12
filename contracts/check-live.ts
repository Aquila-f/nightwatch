// 對「正在跑的 control」做契約檢查:抓幾個 GET 端點,拿 schemas/ 逐一驗。
//
//   bun contracts/check-live.ts http://127.0.0.1:3300 [incident_id]
//
// 這是協調者在整合檢查點跑的東西,也是 control 的人合併前自己跑的東西。
import { join } from "node:path";
import { Reporter, SchemaStore, validateValue, listFiles, SCHEMAS_ROOT } from "./check.ts";

const base = (process.argv[2] ?? "http://127.0.0.1:3300").replace(/\/+$/, "");
const incidentId = process.argv[3];

type Check = { path: string; schema: string | null; note: string };

const checks: Check[] = [
  { path: "/health", schema: null, note: "回 {status:ok}" },
  { path: "/api/readiness", schema: "readiness.schema.json", note: "" },
  { path: "/api/state", schema: "state.schema.json", note: "" },
  { path: "/api/graph", schema: "snapshot.schema.json", note: "不帶 t" },
  { path: "/api/faults/catalog", schema: "fault-catalog.schema.json", note: "不含 truth / knobs" },
  { path: "/api/faults/instances", schema: "faults.schema.json", note: "{instances[], generation}" },
  { path: "/api/capabilities", schema: null, note: "含與 manifest 對齊的 nodes、links" },
];
if (incidentId) {
  checks.push(
    { path: `/api/incidents/${incidentId}`, schema: null, note: "攤平的 read model" },
    { path: `/api/incidents/${incidentId}/timeline`, schema: "timeline.schema.json", note: "" },
    { path: `/api/incidents/${incidentId}/report`, schema: "report.schema.json", note: "" },
  );
}

const reporter = new Reporter();
const store = new SchemaStore(reporter);
// $ref 只會解析到已載入的 schema,所以先把整個目錄載進來
await store.loadMany(await listFiles(SCHEMAS_ROOT, "*.schema.json"));
const manifestPath = join(import.meta.dir, "manifest.yaml");
let manifestNodeIDs: string[] | null = null;
let manifestLoadError: string | null = null;
try {
  const manifest = Bun.YAML.parse(await Bun.file(manifestPath).text()) as { nodes?: unknown };
  if (!manifest || !Array.isArray(manifest.nodes)) {
    manifestLoadError = "manifest.nodes 不是陣列";
  } else {
    const ids = manifest.nodes.map((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return null;
      const id = (node as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? id : null;
    });
    if (ids.some((id): id is null => id === null)) {
      manifestLoadError = "manifest.nodes 含缺少字串 id 的節點";
    } else {
      manifestNodeIDs = ids as string[];
      const duplicates = manifestNodeIDs.filter((id, index) => manifestNodeIDs?.indexOf(id) !== index);
      if (duplicates.length) manifestLoadError = `manifest.nodes 有重複 id: ${[...new Set(duplicates)].join(", ")}`;
    }
  }
} catch (error) {
  manifestLoadError = `讀取 manifest 失敗 (${String(error)})`;
}
let failed = 0;

function compareNodeIDs(label: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [`${label} 不是陣列`];
  const ids = value.map((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    const id = (node as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  });
  const problems: string[] = [];
  if (ids.some((id): id is null => id === null)) problems.push(`${label} 含缺少字串 id 的節點`);
  if (!manifestNodeIDs) return problems;

  const expected = new Set(manifestNodeIDs);
  const actual = new Set(ids.filter((id): id is string => id !== null));
  const duplicates = ids.filter((id, index): id is string => id !== null && ids.indexOf(id) !== index);
  const missing = manifestNodeIDs.filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (duplicates.length) problems.push(`${label} 有重複 id: ${[...new Set(duplicates)].join(", ")}`);
  if (missing.length) problems.push(`${label} 缺少 manifest id: ${missing.join(", ")}`);
  if (extra.length) problems.push(`${label} 有非 manifest id: ${extra.join(", ")}`);
  return problems;
}

for (const check of checks) {
  const url = base + check.path;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.log(`FAIL ${check.path}: 連不上 (${String(error)})`);
    failed += 1;
    continue;
  }
  if (!response.ok) {
    console.log(`FAIL ${check.path}: HTTP ${response.status}`);
    failed += 1;
    continue;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.log(`FAIL ${check.path}: 不是 JSON (${String(error)})`);
    failed += 1;
    continue;
  }

  // 幾個沒有 schema 的端點做最低限度的形狀檢查
  if (check.path === "/health" && (body as { status?: string })?.status !== "ok") {
    console.log(`FAIL ${check.path}: status 不是 ok`);
    failed += 1;
    continue;
  }
  if (check.path === "/api/capabilities") {
    const caps = body as { nodes?: unknown[]; links?: unknown; tools?: unknown[]; actions?: unknown[] };
    const problems: string[] = [];
    if (manifestLoadError) problems.push(manifestLoadError);
    problems.push(...compareNodeIDs("capabilities.nodes", caps.nodes));
    if (!caps.links || typeof caps.links !== "object") problems.push("缺 links");
    if (!Array.isArray(caps.tools)) problems.push("缺 tools");
    if (!Array.isArray(caps.actions)) problems.push("缺 actions");
    if (problems.length) {
      console.log(`FAIL ${check.path}: ${problems.join("; ")}`);
      failed += 1;
      continue;
    }
  }
  if (check.path === "/api/graph") {
    const problems = [
      ...(manifestLoadError ? [manifestLoadError] : []),
      ...compareNodeIDs("graph.nodes", (body as { nodes?: unknown[] })?.nodes),
    ];
    if (problems.length) {
      console.log(`FAIL ${check.path}: ${problems.join("; ")}`);
      failed += 1;
      continue;
    }
  }
  if (check.path === "/api/faults/catalog") {
    const cards = Array.isArray(body) ? body : (body as { cards?: unknown[] })?.cards;
    if (Array.isArray(cards)) {
      body = cards;
      for (const card of cards as Array<Record<string, unknown>>) {
        if ("truth" in card || "knobs" in card) {
          console.log(`FAIL ${check.path}: 卡片 ${String(card.id)} 洩漏了 truth 或 knobs`);
          failed += 1;
        }
      }
    }
  }
  if (check.path === "/api/graph" && typeof (body as { t?: unknown })?.t === "number") {
    console.log(`FAIL ${check.path}: 平時的 /api/graph 不該帶 t`);
    failed += 1;
    continue;
  }

  if (!check.schema) {
    console.log(`ok   ${check.path} ${check.note}`);
    continue;
  }
  const document = await store.load(join(SCHEMAS_ROOT, check.schema));
  if (!document) {
    console.log(`FAIL ${check.path}: 讀不到 schema ${check.schema}`);
    failed += 1;
    continue;
  }
  const before = (reporter as unknown as { messages: string[] }).messages?.length ?? 0;
  const ok = validateValue(body, document, url, reporter, store);
  if (ok) console.log(`ok   ${check.path} ${check.note}`);
  else {
    console.log(`FAIL ${check.path}: 不符合 ${check.schema}`);
    failed += 1;
  }
  void before;
}

reporter.print();
console.log(failed === 0 ? `check-live: 全部通過(${checks.length} 項)` : `check-live: ${failed} 項失敗`);
if (failed > 0) process.exitCode = 1;
