import {validateGraph} from './data.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Layout is a local view choice. It is not added to the backend graph payload.
export function graphLayout(graph) {
  const ids = graph.nodes.map(n => n.id).sort();
  const neighbors = new Map(ids.map(id => [id, new Set()]));
  const parents = new Map(ids.map(id => [id, new Set()]));
  for (const edge of graph.edges || []) {
    if (!neighbors.has(edge.from) || !neighbors.has(edge.to) || edge.from === edge.to) continue;
    neighbors.get(edge.from).add(edge.to); neighbors.get(edge.to).add(edge.from);
    parents.get(edge.to).add(edge.from);
  }
  const pending = new Set(ids), components = [], isolated = [];
  for (const id of ids) {
    if (!pending.delete(id)) continue;
    const component = [id];
    for (let i = 0; i < component.length; i++) {
      for (const next of neighbors.get(component[i])) if (pending.delete(next)) component.push(next);
    }
    if (component.length === 1) isolated.push(id); else components.push(component);
  }
  components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const result = [];
  let offset = 0;
  for (const component of components) {
    const remaining = new Set(component.sort()), levels = new Map();
    // Break cycles deterministically so reciprocal dependencies remain renderable.
    while (remaining.size) {
      const ready = [...remaining].filter(id => [...parents.get(id)].every(parent => !remaining.has(parent)));
      if (!ready.length) ready.push([...remaining][0]);
      for (const id of ready) {
        levels.set(id, Math.max(-1, ...[...parents.get(id)].map(parent => levels.get(parent) ?? -1)) + 1);
        remaining.delete(id);
      }
    }
    const columns = [];
    for (const id of component) (columns[levels.get(id)] ??= []).push(id);
    const rows = Math.max(...columns.map(column => column.length));
    columns.forEach((column, col) => column.forEach((id, row) => result.push({id, layout: {
      col, row: offset + row * 2 + rows - column.length,
    }})));
    offset += rows * 2 + 1;
  }
  const columns = Math.max(1, Math.min(3, ids.length));
  isolated.forEach((id, index) => result.push({id, layout: {
    col: index % columns, row: offset + Math.floor(index / columns) * 2, isolated: true,
  }}));
  return result;
}
export function validateObservation(graph) {
  if (!object(graph) || !Array.isArray(graph.nodes) || graph.nodes.some(n => !object(n) || typeof n.id !== 'string')) throw new Error('graph 缺少合法節點。');
  validateGraph(graph, {nodes: graphLayout(graph)});
  if (!Number.isFinite(Date.parse(graph.at))) throw new Error('graph.at 不是合法時間。');
  return graph;
}

export function validateDetection(value) {
  if (!object(value) || value.schema_version !== 'nightwatch.detection.v1' || typeof value.id !== 'string'
      || typeof value.node_id !== 'string' || !['active', 'recovered'].includes(value.status)
      || !integer(value.event_seq) || value.event_seq < 1 || !Number.isFinite(Date.parse(value.detected_at))) {
    throw new Error('偵測紀錄格式不符。');
  }
  return value;
}
export function validateWorkspaceState(value) {
  if (!object(value) || value.schema_version !== 'nightwatch.observation-workspace.v1'
      || !Number.isFinite(Date.parse(value.server_now)) || !object(value.investigator)
      || typeof value.investigator.available !== 'boolean') throw new Error('觀測工作台 state 格式不符。');
  validateObservation(value.graph);
  const state = value.investigator.state;
  if (state !== null) {
    if (!object(state) || state.schema_version !== 'nightwatch.investigator-state.v1'
        || typeof state.stream_id !== 'string' || !integer(state.cursor) || !integer(state.active_count)
        || !Array.isArray(state.recent_detections) || state.runner_available !== false
        || !object(state.source)) throw new Error('Investigator state 格式不符。');
    state.recent_detections.forEach(validateDetection);
  }
  return value;
}
export class DetectionStore {
  state = null;
  streamId = null;
  eventCursor = null;
  stateCursor = -1;
  detections = new Map();
  events = new Map();

  acceptState(value) {
    validateWorkspaceState(value);
    const remote = value.investigator.state;
    if (remote && remote.stream_id !== this.streamId) {
      this.streamId = remote.stream_id; this.eventCursor = remote.cursor; this.stateCursor = -1;
      this.detections.clear(); this.events.clear();
    }
    if (remote && remote.cursor < this.stateCursor) return false;
    this.state = value;
    if (remote) {
      this.stateCursor = remote.cursor;
      remote.recent_detections.forEach(row => this.acceptDetection(row));
    }
    return true;
  }
  acceptDetection(row) {
    validateDetection(row);
    const prior = this.detections.get(row.id);
    if (!prior || prior.event_seq <= row.event_seq) this.detections.set(row.id, row);
  }
  acceptEvent(value) {
    if (!object(value) || value.schema_version !== 'nightwatch.investigator-event.v1'
        || !['detection.created', 'detection.recovered'].includes(value.type)
        || !integer(value.cursor) || typeof value.event_id !== 'string'
        || value.detection_id !== value.payload?.id || value.seq !== value.payload?.event_seq) {
      throw new Error('偵測事件格式不符。');
    }
    validateDetection(value.payload);
    if (value.cursor <= (this.eventCursor ?? 0)) return false;
    if (value.cursor !== (this.eventCursor ?? 0) + 1) throw new Error('偵測事件有缺口，等待重新同步。');
    this.acceptDetection(value.payload);
    this.events.set(value.event_id, value);
    while (this.events.size > 200) this.events.delete(this.events.keys().next().value);
    this.eventCursor = value.cursor;
    return true;
  }
}

export async function requestJSON(path, options = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener('abort', cancel, {once: true});
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, {cache: 'no-store', ...options, signal: controller.signal,
      headers: {Accept: 'application/json', ...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers}});
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`${path} 回傳非 JSON（HTTP ${response.status}）。`); }
    if (!response.ok) {
      const error = new Error(`${value.error?.code || value.detail?.code || 'http_error'}：${value.error?.message_zh || `HTTP ${response.status}`}`);
      error.status = response.status; error.details = value.error?.details; throw error;
    }
    return value;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error.name === 'AbortError') throw new Error(`${path} 超過 10 秒未回應。`);
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}

const primaryNodes = new Set([
  'shop-products', 'shop-cart-read', 'shop-cart-mutate',
  'shop-checkout-request', 'shop-checkout-logic', 'shop-db-write',
]);

// Keep the full observation intact for evidence and detail views.
export function focusedGraph(graph, {all = false, search = '', selected = null} = {}) {
  if (all || !graph.nodes.some(node => primaryNodes.has(node.id))) return graph;
  const query = search.trim().toLowerCase();
  const nodes = graph.nodes.filter(node => primaryNodes.has(node.id)
    || ['warning', 'failing'].includes(node.status) || node.id === selected
    || (query && node.id.toLowerCase().includes(query)));
  const visible = new Set(nodes.map(node => node.id));
  return {...graph, nodes, edges: graph.edges.filter(edge => visible.has(edge.from) && visible.has(edge.to))};
}

export function retainLog(logs, log, limit = 200) {
  logs.set(JSON.stringify([log.monitor_id, log.event_id]), log);
  while (logs.size > limit) logs.delete(logs.keys().next().value);
}
