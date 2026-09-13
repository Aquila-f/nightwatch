import {DetectionStore, requestJSON, validateDetection, validateObservation, graphLayout, focusedGraph, retainLog} from './investigation-data.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const raw = value => `<pre class="raw">${esc(JSON.stringify(value, null, 2) ?? '未提供')}</pre>`;
const at = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ') : '—';
const number = (value, suffix = '', factor = 1) => typeof value === 'number' && Number.isFinite(value) ? `${(value * factor).toLocaleString('zh-TW', {maximumFractionDigits: 2})}${suffix}` : '—';
const health = {ok: '正常', warning: '警告', failing: '異常', unknown: '無資料'};
const store = new DetectionStore();
const errors = new Map(), logs = new Map();
let graph = null, graphReceivedAt = null, selectedNode = null, zoom = 1, fit = true, layoutSignature = '';
let stream = null, logStream = null, streamRetry = null, logRetry = null, heartbeatTimer = null, logDelay = 1000;
let lastActivity = 0, lastLogActivity = 0, disposed = false, graphGeneration = 0, refreshBusy = false;
let showAllNodes = false, journalTimer = null, renderedNodesKey = '', renderedNodeId = null, renderedEdges = '';
let journalFilter = 'all', filter = 'all', nextBefore = null, historyBusy = false, selectedDetection = null;
let historyLoaded = false, detailRequest = 0, graphDialog = null, graphRestore = null;
let graphResizeObserver = null, graphResizeFrame = null;

function setupGraphFullscreen() {
  const panel = $('graph-viewport').closest('.topology-panel');
  const anchor = document.createComment('Topology panel position');
  panel.before(anchor);
  graphDialog = document.createElement('dialog');
  graphDialog.id = 'graph-fullscreen-dialog';
  graphDialog.setAttribute('aria-label', '全螢幕服務拓樸');
  document.body.append(graphDialog);
  $('fit').insertAdjacentHTML('afterend', '<button id="graph-fullscreen" type="button" aria-haspopup="dialog" aria-expanded="false" title="全螢幕檢視拓樸"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg><span>全螢幕</span></button>');
  const button = $('graph-fullscreen');
  button.onclick = () => {
    if (graphDialog.open) { graphDialog.close(); restore(); return; }
    const viewport = $('graph-viewport');
    graphRestore = {zoom, fit, left: viewport.scrollLeft, top: viewport.scrollTop};
    graphDialog.append(panel);
    document.body.classList.add('graph-fullscreen-open');
    button.setAttribute('aria-expanded', 'true');
    button.querySelector('span').textContent = '離開全螢幕';
    button.title = '離開全螢幕（Esc）';
    graphDialog.showModal();
    fit = true;
    renderGraph();
    viewport.scrollTo(0, 0);
    button.focus({preventScroll: true});
  };
  function restore() {
    if (!graphRestore) return;
    anchor.after(panel);
    document.body.classList.remove('graph-fullscreen-open');
    button.setAttribute('aria-expanded', 'false');
    button.querySelector('span').textContent = '全螢幕';
    button.title = '全螢幕檢視拓樸';
    if (graphRestore) {
      zoom = graphRestore.zoom; fit = graphRestore.fit;
      renderGraph();
      $('graph-viewport').scrollTo(graphRestore.left, graphRestore.top);
      graphRestore = null;
    }
    button.focus({preventScroll: true});
  }
  graphDialog.addEventListener('cancel', event => {
    event.preventDefault(); graphDialog.close(); restore();
  });
  graphDialog.addEventListener('close', () => {
    // A close event is queued; it must not undo a subsequently reopened dialog.
    if (!graphDialog.open) restore();
  });
  graphResizeObserver = new ResizeObserver(() => {
    if (!graphDialog.open || !fit || disposed || graphResizeFrame !== null) return;
    graphResizeFrame = requestAnimationFrame(() => {
      graphResizeFrame = null;
      if (graphDialog.open && fit && !disposed) renderGraph();
    });
  });
  graphResizeObserver.observe($('graph-viewport'));
}

const localTime = value => Number.isFinite(typeof value === 'number' ? value : Date.parse(value)) ? new Intl.DateTimeFormat('zh-TW', {timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(new Date(value)) : '—';
let liveGraph = null, liveReceivedAt = null, viewingHistory = false;
let snapshots = [], timelineBounds = null, cursorTime = null, targetSnapshot = null;
let snapshotBusy = false, snapshotMessage = '', snapshotIndexError = '', snapshotIndexBusy = false;
let snapshotController = null, snapshotIndexController = null, snapshotRequest = 0, snapshotTimer = null, snapshotPoll = null, lastSnapshotRequest = 0;

function updateGraphMarkup(id, markup) {
  const container = $(id), range = document.createRange();
  range.selectNodeContents(container);
  const fragment = range.createContextualFragment(markup);
  const key = node => node.nodeType === 1 ? node.getAttribute('data-node') ?? node.getAttribute('data-snapshot') : null;
  function sync(parent, desired) {
    const keyed = new Map([...parent.childNodes].filter(node => key(node) !== null).map(node => [key(node), node]));
    let cursor = parent.firstChild;
    for (const next of [...desired.childNodes]) {
      const nextKey = key(next);
      let current = nextKey === null ? cursor : keyed.get(nextKey);
      if (!current || key(current) !== nextKey || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName || current.namespaceURI !== next.namespaceURI) {
        current = next.cloneNode(true);
        parent.insertBefore(current, cursor);
      } else {
        if (current !== cursor) parent.insertBefore(current, cursor);
        if (current.nodeType === 1) {
          // Keep a user's expanded node details open across observation updates.
          const keepOpen = current.localName === 'details';
          for (const attribute of [...current.attributes]) {
            if (!(keepOpen && attribute.name === 'open') && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
          }
          for (const attribute of [...next.attributes]) {
            if (!(keepOpen && attribute.name === 'open') && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
          }
          sync(current, next);
        } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      }
      cursor = current.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }
  sync(container, fragment);
}

function timelineItems() {
  return snapshots.filter(item => !timelineBounds || (item.time >= timelineBounds.from && item.time <= timelineBounds.to));
}
function renderTimeline() {
  const items = timelineItems(), range = $('snapshot-range');
  $('graph-mode').textContent = snapshotBusy ? '歷史快照載入中' : viewingHistory ? '歷史 graph' : '即時 graph';
  $('graph-live').disabled = !viewingHistory;
  $('graph-view-time').textContent = graph ? `${snapshotBusy ? '目前顯示' : viewingHistory ? '歷史快照' : '即時觀測'} ${localTime(graph.at)} (+08:00) · #${graph.seq}` : snapshotBusy ? '正在讀取歷史快照…' : '目前沒有可顯示的快照';
  $('graph-canvas').setAttribute('aria-busy', String(snapshotBusy));
  const index = items.findIndex(item => item.seq === targetSnapshot?.seq);
  $('snapshot-prev').disabled = !items.length || (viewingHistory && index === 0);
  $('snapshot-next').disabled = !viewingHistory || !items.length || index === items.length - 1;
  range.disabled = !items.length;
  if (timelineBounds) {
    // Keep native slider values small enough for accessibility APIs' numeric precision.
    range.min = 0; range.max = Math.max(1, timelineBounds.to - timelineBounds.from);
    range.value = (viewingHistory ? cursorTime ?? timelineBounds.to : timelineBounds.to) - timelineBounds.from;
    $('snapshot-from').textContent = `${localTime(timelineBounds.from)} ${viewingHistory ? '範圍起點' : '最早'}`;
    $('snapshot-to').textContent = `${localTime(timelineBounds.to)} ${viewingHistory ? '範圍終點' : '最新保存'}`;
    const span = timelineBounds.to - timelineBounds.from || 1;
    updateGraphMarkup('snapshot-ticks', items.map(item => `<i data-snapshot="${item.seq}" style="left:${(item.time - timelineBounds.from) / span * 100}%"></i>`).join(''));
  } else {
    $('snapshot-from').textContent = $('snapshot-to').textContent = '—';
    $('snapshot-ticks').textContent = '';
  }
  const label = viewingHistory ? `游標 ${localTime(cursorTime)}` : `${items.length} 張可用快照`;
  $('snapshot-target').textContent = label;
  range.setAttribute('aria-valuetext', `${label}${targetSnapshot ? `，快照 ${localTime(targetSnapshot.at)}` : ''}，台灣時間`);
  $('snapshot-note').textContent = snapshotBusy ? `正在載入 ${localTime(targetSnapshot?.at)}；${graph ? `暫時保留 ${localTime(graph.at)} 的圖，完成後切換。` : '尚無可顯示的圖。'}` : !items.length ? '目前沒有保留快照；即時觀測仍可使用。' : viewingHistory ? `選取不晚於游標的快照；快照間沒有保存的狀態不補算。右側調查與 Monitor 紀錄仍為即時。` : '拖曳可查看歷史；最右端是最新保存快照。時間均為台灣時間 (+08:00)。';
  $('snapshot-error').textContent = [snapshotIndexError, snapshotMessage].filter(Boolean).join(' ');
  $('snapshot-error').hidden = !snapshotIndexError && !snapshotMessage;
}
function cancelSnapshot() {
  clearTimeout(snapshotTimer); snapshotTimer = null;
  snapshotController?.abort(); snapshotController = null; snapshotRequest++;
}
async function loadSnapshotIndex() {
  if (snapshotIndexBusy || disposed) return;
  snapshotIndexBusy = true;
  const controller = new AbortController(); snapshotIndexController = controller;
  try {
    const all = new Map(); let before = null;
    do {
      const page = await requestJSON(`/api/graph/snapshots?limit=500${before === null ? '' : '&before_seq=' + before}`, {signal: controller.signal});
      if (!Array.isArray(page.snapshots) || !(page.next_before_seq === null || Number.isSafeInteger(page.next_before_seq))) throw new Error('快照清單或分頁格式不符。');
      let previous = before ?? Infinity;
      for (const item of page.snapshots) {
        if (!Number.isSafeInteger(item.seq) || item.seq < 0 || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || item.seq >= previous) throw new Error('快照索引缺少合法 seq、at 或未依序排列。');
        all.set(item.seq, {...item, time: Date.parse(item.at)}); previous = item.seq;
      }
      if (page.next_before_seq !== null && (!page.snapshots.length || page.next_before_seq !== previous || page.next_before_seq >= (before ?? Infinity))) throw new Error('快照分頁沒有前進。');
      before = page.next_before_seq;
    } while (before !== null && !disposed);
    if (disposed) return;
    const ordered = [...all.values()].sort((a, b) => a.time - b.time || a.seq - b.seq);
    // timestamp resolves equal times to the largest seq; expose only retrievable entries.
    snapshots = [...new Map(ordered.map(item => [item.time, item])).values()];
    snapshotIndexError = '';
    if (!viewingHistory) timelineBounds = snapshots.length ? {from: snapshots[0].time, to: snapshots[snapshots.length - 1].time} : null;
    if (viewingHistory && targetSnapshot && !all.has(targetSnapshot.seq)) {
      cancelSnapshot(); snapshotBusy = false; graph = null;
      snapshotMessage = '此快照已過期或不再可用。請選擇其他時間，或回到即時。';
      targetSnapshot = null; renderGraph();
    }
  } catch (e) {
    if (!controller.signal.aborted) snapshotIndexError = `歷史清單讀取失敗：${e.message}；按「更新資料」可重試。`;
  } finally {
    snapshotIndexBusy = false;
    if (!disposed) renderTimeline();
  }
}
function selectSnapshot(time, immediate = false) {
  if (!Number.isFinite(time) || disposed) return;
  const items = timelineItems();
  const item = [...items].reverse().find(candidate => candidate.time <= time);
  viewingHistory = true; cursorTime = time;
  if (item && targetSnapshot?.seq === item.seq && !snapshotMessage && (snapshotBusy || graph?.seq === item.seq)) {
    if (immediate && snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; void fetchSnapshot(item, snapshotRequest); }
    renderTimeline(); return;
  }
  cancelSnapshot(); targetSnapshot = item ?? null; snapshotMessage = '';
  snapshotBusy = Boolean(item);
  if (!item) { graph = null; snapshotMessage = '此時間沒有保留快照，請選擇較新的時間。'; }
  renderGraph();
  if (!item) return;
  const request = snapshotRequest;
  const delay = immediate ? 0 : Math.max(0, 150 - (Date.now() - lastSnapshotRequest));
  snapshotTimer = setTimeout(() => { snapshotTimer = null; void fetchSnapshot(item, request); }, delay);
}
async function fetchSnapshot(item, request) {
  lastSnapshotRequest = Date.now();
  const controller = new AbortController(); snapshotController = controller;
  try {
    const params = new URLSearchParams({timestamp: item.at});
    const value = await requestJSON(`/api/graph?${params}`, {signal: controller.signal});
    validateObservation(value);
    if (disposed || request !== snapshotRequest || !viewingHistory) return;
    // A pruned snapshot may resolve to a different, earlier graph. Never relabel it.
    if (Date.parse(value.at) !== item.time || value.seq !== item.seq) throw new Error('所選快照已改變或過期，請重新選擇時間。');
    graph = value; graphReceivedAt = null; snapshotMessage = '';
  } catch (e) {
    if (disposed || controller.signal.aborted || request !== snapshotRequest) return;
    graph = null;
    snapshotMessage = e.status === 404 ? '此快照已過期或沒有可用資料。請選擇其他時間。' : `歷史快照讀取失敗：${e.message}`;
    void loadSnapshotIndex();
  } finally {
    if (!disposed && request === snapshotRequest) { snapshotBusy = false; snapshotController = null; renderGraph(); }
  }
}
function stepSnapshot(direction) {
  const items = timelineItems();
  if (!items.length) return;
  const index = items.findIndex(item => item.seq === targetSnapshot?.seq);
  const item = !viewingHistory ? items[items.length - 1] : index < 0 ? (direction < 0 ? [...items].reverse().find(item => item.time < cursorTime) : items.find(item => item.time > cursorTime)) : items[index + direction];
  if (item) selectSnapshot(item.time, true);
}
function returnToLive() {
  cancelSnapshot(); viewingHistory = false; snapshotBusy = false; snapshotMessage = ''; targetSnapshot = null; cursorTime = null;
  graph = liveGraph; graphReceivedAt = liveReceivedAt;
  timelineBounds = snapshots.length ? {from: snapshots[0].time, to: snapshots[snapshots.length - 1].time} : null;
  renderGraph(); void loadSnapshotIndex(); void refresh();
}


function acceptGraph(value, receivedAt = null) {
  validateObservation(value);
  // Avoid a slow state GET rolling an independently delivered graph backwards.
  if (liveGraph && Date.parse(value.at) < Date.parse(liveGraph.at)) return;
  if (liveGraph && value.at === liveGraph.at && value.seq <= liveGraph.seq) return;
  liveGraph = value; liveReceivedAt = receivedAt; graphGeneration++;
  if (!viewingHistory) { graph = value; graphReceivedAt = receivedAt; if (!$('topology-view').hidden) renderGraph(); }
}

const nodeNames = {
  'shop-products': '商品瀏覽', 'shop-cart-read': '購物車讀取', 'shop-cart-mutate': '購物車更新',
  'shop-checkout-request': '結帳入口', 'shop-checkout-logic': '結帳處理', 'shop-db-write': '訂單寫入',
  'shop-health': '健康檢查', 'shop-db': '資料庫', 'shop-catalog-read': '商品目錄讀取',
  'shop-catalog-lookup': '商品查詢', 'shop-cart-catalog-lookup': '購物車商品查詢',
  'shop-cart-prepare': '購物車準備', 'shop-cart-complete': '購物車完成', 'shop-cart-abort': '購物車取消',
  'shop-order-cart-prepare': '訂單準備購物車', 'shop-order-catalog-lookup': '訂單商品查詢',
  'shop-order-cart-complete': '訂單完成購物車', 'shop-order-cart-abort': '訂單取消購物車',
};
const nodeName = id => nodeNames[id] || id;
function nodeIcon(kind) {
  const paths = kind === 'datastore' || kind === 'volume'
    ? '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v14c0 4 14 4 14 0V5M5 12c0 4 14 4 14 0"/>'
    : kind === 'queue' ? '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 9h10M7 13h7"/>'
    : '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4"/>';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function renderGraph() {
  renderTimeline();
  $('graph-canvas').hidden = !graph;
  $('active-phase').textContent = store.state?.investigator.state ? `${store.state.investigator.state.active_count} 個異常` : '等待偵測';
  if (!graph) {
    $('graph-empty').hidden = false; $('graph-empty').textContent = snapshotBusy ? '正在讀取歷史快照…' : '尚無可顯示的服務拓樸，請查看快照與連線訊息。';
    renderedNodesKey = ''; renderedEdges = '';
    $('nodes').textContent = ''; $('edges').innerHTML = ''; $('sources').textContent = '';
    for (const id of ['total-nodes', 'failing-count', 'warning-count', 'snapshot-at']) $(id).textContent = '—';
    $('graph-count').textContent = snapshotBusy ? '載入中' : '沒有快照'; $('match-count').textContent = '';
    $('footer-status').textContent = viewingHistory ? '歷史模式 · 尚無可顯示的快照' : '等待即時快照';
    renderNode();
    return;
  }
  if (!graph.nodes.some(n => n.id === selectedNode)) selectedNode = graph.nodes.find(n => n.id === 'shop-checkout-request')?.id ?? graph.nodes[0]?.id ?? null;
  const view = focusedGraph(graph, {all: showAllNodes, search: $('node-search').value, selected: selectedNode});
  $('graph-viewport').classList.add('topology-modern');
  const layout = graphLayout(view), signature = JSON.stringify(layout);
  if (signature !== layoutSignature) { layoutSignature = signature; fit = true; }
  const cardWidth = 204, cardHeight = 144, columnGap = 64, rowStep = 88;
  const width = Math.max(1, ...layout.map(n => n.layout.col + 1)) * (cardWidth + columnGap) - columnGap + 64;
  const height = Math.max(0, ...layout.map(n => n.layout.row)) * rowStep + cardHeight + 100;
  if (fit) {
    const viewport = $('graph-viewport');
    zoom = Math.max(.01, Math.min(1, (viewport.clientWidth - 24) / width, (viewport.clientHeight - 24) / height));
  }
  const positions = new Map(layout.map(n => [n.id, {x: 32 + n.layout.col * (cardWidth + columnGap), y: 64 + n.layout.row * rowStep}]));
  const search = $('node-search').value.toLowerCase().trim(), selectedHealth = $('health-filter').value;
  const matches = new Set(view.nodes.filter(n => (!search || n.id.toLowerCase().includes(search)) && (selectedHealth === 'all' || n.status === selectedHealth)).map(n => n.id));
  $('total-nodes').textContent = graph.nodes.length;
  $('failing-count').textContent = graph.nodes.filter(n => n.status === 'failing').length;
  $('warning-count').textContent = graph.nodes.filter(n => n.status === 'warning').length;
  $('snapshot-at').textContent = localTime(graph.at);
  $('graph-count').textContent = `顯示 ${view.nodes.length} / ${graph.nodes.length} 個節點 · ${view.edges.length} 條連線`;
  $('match-count').textContent = `${matches.size} / ${view.nodes.length} 個可見節點符合條件`;
  $('graph-empty').hidden = graph.nodes.length > 0;
  $('graph-empty').textContent = '後端快照目前沒有服務節點。';
  $('graph-canvas').style.width = `${width * zoom}px`; $('graph-canvas').style.height = `${height * zoom}px`;
  for (const id of ['nodes', 'edges']) { $(id).style.width = `${width}px`; $(id).style.height = `${height}px`; $(id).style.transform = `scale(${zoom})`; }
  $('edges').setAttribute('width', width); $('edges').setAttribute('height', height);
  $('zoom-value').textContent = `${Math.round(zoom * 100)}%`;
  const isolated = layout.filter(n => n.layout.isolated);
  const connected = layout.filter(n => !n.layout.isolated);
  const captions = `${connected.length ? '<text class="graph-section-label" x="32" y="30">服務呼叫 →</text>' : ''}${isolated.length ? `<text class="graph-section-label" x="32" y="${Math.min(...isolated.map(n => positions.get(n.id).y)) - 24}">其他可見觀測點</text>` : ''}`;
  const edgesHTML = '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1L7 4L1 7" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>' + captions + view.edges.map((e, index) => {
    const a = positions.get(e.from), b = positions.get(e.to);
    let d;
    if (b.x > a.x) {
      const start = a.x + cardWidth, end = b.x - 5, ay = a.y + cardHeight / 2, by = b.y + cardHeight / 2;
      // Long dependencies travel above the cards rather than through intermediate nodes.
      if (b.x - a.x > cardWidth + columnGap) {
        const lane = Math.min(a.y, b.y) - 16 - index % 3 * 6;
        d = `M${start} ${ay}C${start + 24} ${ay} ${start + 24} ${lane} ${start + 36} ${lane}H${end - 32}C${end - 16} ${lane} ${end - 24} ${by} ${end} ${by}`;
      } else {
        const mid = (start + end) / 2;
        d = `M${start} ${ay}C${mid} ${ay} ${mid} ${by} ${end} ${by}`;
      }
    } else {
      const start = a.x + cardWidth / 2, end = b.x + cardWidth / 2;
      const lane = Math.max(a.y, b.y) + cardHeight + 18 + index % 3 * 6;
      d = `M${start} ${a.y + cardHeight}C${start} ${lane} ${end} ${lane} ${end} ${b.y + cardHeight + 5}`;
    }
    return `<path class="edge ${e.observed ? '' : 'unobserved'} ${e.from === selectedNode || e.to === selectedNode ? 'related' : ''} ${matches.has(e.from) && matches.has(e.to) ? '' : 'dim'}" d="${d}" marker-end="url(#arrow)"><title>${esc(e.from)} → ${esc(e.to)} · ${esc(e.kind)} · ${e.observed ? '已觀測' : '近期未觀測'}</title></path>`;
  }).join('');
  if (edgesHTML !== renderedEdges) { $('edges').innerHTML = edgesHTML; renderedEdges = edgesHTML; }
  const nodesHTML = view.nodes.map(n => {
    const p = positions.get(n.id);
    return `<button class="graph-node" data-node="${esc(n.id)}" style="left:${p.x}px;top:${p.y}px" title="${esc(n.id)}" aria-label="選取 ${esc(n.id)}"><span class="node-topline"><span class="node-icon" aria-hidden="true">${nodeIcon(n.kind)}</span><span class="node-meta"></span></span><span class="node-name">${esc(nodeName(n.id))}</span><span class="node-id">${esc(n.id)}</span><span class="node-measure"><span class="node-axis"></span><span class="node-value"></span></span></button>`;
  }).join('');
  const nodesKey = JSON.stringify(view.nodes.map(n => n.id));
  if (nodesKey !== renderedNodesKey) {
    const template = document.createElement('template'); template.innerHTML = nodesHTML;
    const existing = new Map([...$('nodes').children].map(node => [node.dataset.node, node]));
    const visible = new Set(view.nodes.map(node => node.id));
    for (const [id, node] of existing) if (!visible.has(id)) node.remove();
    for (const [index, node] of view.nodes.entries()) {
      const element = existing.get(node.id) ?? template.content.children[index].cloneNode(true);
      if ($('nodes').children[index] !== element) $('nodes').insertBefore(element, $('nodes').children[index] ?? null);
    }
    renderedNodesKey = nodesKey;
  }
  {
    for (const [index, button] of [...$('nodes').children].entries()) {
      const n = view.nodes[index], p = positions.get(n.id);
      button.className = `graph-node ${n.kind} health-${n.status} ${selectedNode === n.id ? 'selected' : ''} ${matches.has(n.id) ? '' : 'dim'}`;
      button.style.left = `${p.x}px`; button.style.top = `${p.y}px`;
      button.setAttribute('aria-pressed', String(selectedNode === n.id));
      button.querySelector('.node-meta').className = `node-meta ${n.status}`;
      button.querySelector('.node-meta').innerHTML = `<i class="dot ${esc(n.status)}"></i>${esc(health[n.status])}`;
      const readings = {latency: n.p95_ms, traffic: n.traffic, errors: n.errors, saturation: n.saturation};
      const preferred = ['queue', 'volume'].includes(n.kind) ? ['saturation', 'traffic', 'latency', 'errors'] : ['latency', 'traffic', 'errors', 'saturation'];
      const axis = n.primary_axis ?? preferred.find(key => Number.isFinite(readings[key]));
      const values = {traffic: number(n.traffic, ' req/s'), errors: number(n.errors, '%', 100), latency: number(n.p95_ms, ' ms'), saturation: number(n.saturation, '%', 100), liveness: n.alive === true ? '存活' : n.alive === false ? '無回應' : '—'};
      button.querySelector('.node-axis').textContent = ({traffic: '請求量', errors: '錯誤率', latency: 'P95 延遲', saturation: n.sat_label || '飽和度', liveness: '存活狀態'})[axis] || '主要量測';
      button.querySelector('.node-value').textContent = values[axis] ?? '—';
    }
  }
  $('nodes').onclick = event => {
    const button = event.target.closest('[data-node]');
    if (button) locateNode(button.dataset.node);
  };
  $('sources').innerHTML = '<span>觀測來源</span>' + ['prometheus', 'jaeger', 'logstore'].map(key => {
    const s = graph.sources[key];
    return `<span>${key} · ${s?.ok === true ? '可用' : s?.ok === false ? '不可用' : '無資料'} · ${esc(number(s?.age_secs, ' 秒前'))}</span>`;
  }).join('');
  $('footer-status').textContent = `${snapshotBusy ? '目前顯示' : viewingHistory ? '歷史' : '即時'}快照 #${graph.seq} · 觀測時間 ${localTime(graph.at)} (+08:00)${viewingHistory ? '；右側調查與 Monitor 紀錄仍為即時' : ` · 後端接收 ${at(graphReceivedAt)}；心跳不代表新量測`}`;
  renderNode();
}
function locateNode(id) {
  if (!graph?.nodes.some(n => n.id === id)) { error('locate', `圖外來源：${id}，目前拓樸無法定位。`); return; }
  error('locate'); selectedNode = id; $('node-search').value = ''; $('health-filter').value = 'all';
  renderGraph();
  for (const node of $('nodes').querySelectorAll('[data-node]')) if (node.dataset.node === id) node.scrollIntoView({block: 'nearest', inline: 'center'});
}
function renderNode() {
  const n = graph?.nodes.find(n => n.id === selectedNode);
  if (!n) { renderedNodeId = null; $('node-detail').innerHTML = '<div class="empty">點選節點查看後端量測。</div>'; return; }
  const metrics = [['請求量', number(n.traffic, ' req/s')], ['錯誤率', number(n.errors, '%', 100)], ['P95', number(n.p95_ms, ' ms')], ['飽和度', number(n.saturation, '%', 100)], ['alive', n.alive === true ? 'true' : n.alive === false ? 'false' : '—']];
  if (renderedNodeId === n.id) {
    const panel = $('node-detail');
    const status = panel.querySelector('.node-detail-top > span');
    status.className = n.status; status.textContent = health[n.status];
    panel.querySelectorAll('.node-metrics strong').forEach((element, index) => { element.textContent = metrics[index][1]; });
    panel.querySelector('pre.raw').textContent = JSON.stringify({node: n, edges: graph.edges.filter(e => e.from === n.id || e.to === n.id)}, null, 2);
    return;
  }
  renderedNodeId = n.id;
  $('node-detail').innerHTML = `<div class="node-detail-top"><h3>${esc(n.id)}</h3><span class="${esc(n.status)}">${esc(health[n.status])}</span></div><div class="node-metrics">${metrics.map(([label, value]) => `<div><span class="metric-label">${label}</span><strong>${esc(value)}</strong></div>`).join('')}</div><p class="report-note">alive 與來源量測的定義由後端決定；調查結束不會改變服務健康。</p><details><summary>原始節點與相鄰連線</summary>${raw({node: n, edges: graph.edges.filter(e => e.from === n.id || e.to === n.id)})}</details>`;
}




function error(key, message) {
  if ((errors.get(key) ?? null) === (message || null)) return;
  if (message) errors.set(key, message); else errors.delete(key);
  $('errors').innerHTML = [...errors.values()].map(message => `<div class="error">${esc(message)}</div>`).join('');
}
function connection(text, kind = '') { $('connection').textContent = text; $('connection').className = kind; }
function acceptState(value) {
  const previous = store.streamId, previousCursor = store.stateCursor;
  if (!store.acceptState(value)) return;
  acceptGraph(value.graph, value.server_now);
  const remote = value.investigator;
  connection(remote.available ? '觀測連線正常' : '偵測來源離線', remote.available ? '' : 'stale');
  error('investigator', remote.message);
  error('observation', remote.available && remote.state?.source.status !== 'ok' ? remote.state?.source.message : null);
  if (previous !== store.streamId) {
    historyLoaded = false; nextBefore = null; selectedDetection = null;
    $('incident-detail').hidden = true;
  }
  renderCurrent(); renderHistory();
  if (previousCursor !== store.stateCursor && !$('incidents-view').hidden) void loadHistory();
  if (!$('topology-view').hidden) renderGraph();
}
function renderCurrent() {
  const remote = store.state?.investigator, state = remote?.state;
  const active = [...store.detections.values()].filter(row => row.status === 'active');
  $('investigation-phase').textContent = state ? `${state.active_count} 個未恢復異常` : '等待偵測來源';
  $('investigation-summary').innerHTML = `<h3>${remote?.available ? '持續觀測服務狀態' : '等待偵測來源連線'}</h3>
    <p class="report-note">已偵測的異常尚未執行 AI 調查。節點恢復表示監測狀態回到正常，並非根因或業務恢復驗證。</p>
    ${active.slice(0, 5).map(row => `<p><a href="#detections/${encodeURIComponent(row.id)}">${esc(row.node_id)}</a> · 已偵測，待調查</p>`).join('')}
    ${state ? `<p class="report-note">最近成功觀測：${esc(localTime(state.source.last_success_at))}</p>` : ''}`;
  $('investigation-report').innerHTML = '<div class="empty">AI 調查尚未接入，目前沒有調查報告。</div>';
  scheduleJournal();
}
function scheduleJournal() {
  if (journalTimer !== null) return;
  journalTimer = setTimeout(() => { journalTimer = null; renderJournal(); }, 150);
}
function renderJournal() {
  const rows = [
    ...[...store.events.values()].map(event => ({id: event.event_id, kind: 'system', at: event.occurred_at,
      message: event.type === 'detection.recovered' ? `${event.payload.node_id} 的節點觀測已恢復正常` : event.payload.summary,
      value: event})),
    ...[...logs.values()].map(log => ({id: log.event_id, kind: 'monitor', at: log.occurred_at, message: log.message, value: log})),
  ].filter(row => journalFilter === 'all' || row.kind === journalFilter)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 200);
  $('journal-count').textContent = `${rows.length} 筆`;
  $('journal-note').textContent = '本頁最近 200 筆事件；偵測事件可斷線續傳。完整偵測依據請查看偵測紀錄；Monitor log 不保證補回。';
  $('journal-entries').innerHTML = rows.map(row => `<article class="journal-entry ${row.kind}"><div class="journal-meta"><strong>${row.kind === 'monitor' ? 'Monitor' : '異常偵測'}</strong><time>${esc(localTime(row.at))}</time></div><p>${esc(row.message)}</p><details><summary>觀測內容</summary>${raw(row.value)}</details></article>`).join('') || '<div class="empty">目前沒有收到符合條件的事件。</div>';
}
function renderHistory() {
  const search = $('incident-search').value.trim().toLowerCase();
  const rows = [...store.detections.values()].filter(row =>
    (filter === 'all' || row.status === (filter === 'active' ? 'active' : 'recovered'))
    && `${row.id} ${row.node_id} ${row.summary}`.toLowerCase().includes(search))
    .sort((a, b) => b.created_cursor - a.created_cursor);
  $('nav-count').textContent = store.state?.investigator.state?.active_count ?? '—';
  $('incident-rows').innerHTML = rows.map(row => `<tr><td><a href="#detections/${encodeURIComponent(row.id)}">${esc(row.node_id)}</a><small>${esc(row.id)}</small></td><td>${row.status === 'active' ? '異常持續' : '觀測已恢復'}</td><td>${esc(row.summary)}</td><td>${esc(localTime(row.detected_at))}</td><td>${esc(localTime(row.recovered_at))}</td><td>尚未執行 AI 調查</td></tr>`).join('');
  $('list-empty').hidden = rows.length > 0;
  $('list-empty').textContent = store.state?.investigator.available ? '目前沒有符合條件的偵測紀錄。' : '來源離線，尚無可顯示的偵測紀錄。';
  $('list-count').textContent = `已載入 ${store.detections.size} 筆，顯示 ${rows.length} 筆`;
  $('more-detections').hidden = nextBefore === null;
  $('more-detections').disabled = historyBusy;
}
async function loadHistory(append = false) {
  if (historyBusy || disposed) return;
  historyBusy = true;
  const journal = store.streamId;
  try {
    const page = await requestJSON('/api/detections?limit=100' + (append && nextBefore !== null ? `&before=${nextBefore}` : ''));
    if (journal !== store.streamId || disposed) return;
    page.items.forEach(row => { validateDetection(row); store.acceptDetection(row); });
    nextBefore = page.next_before; historyLoaded = true; error('history');
  } catch (e) { error('history', e.message); }
  finally { historyBusy = false; renderHistory(); }
}
async function loadDetail(id) {
  const request = ++detailRequest, journal = store.streamId;
  selectedDetection = id;
  $('incident-detail').hidden = false;
  $('incident-detail').innerHTML = '<div class="empty">正在讀取偵測依據…</div>';
  try {
    const value = await requestJSON('/api/detections/' + encodeURIComponent(id));
    if (request !== detailRequest || journal !== store.streamId || disposed) return;
    validateDetection(value);
    const node = value.snapshot.nodes.find(node => node.id === value.node_id);
    $('incident-detail').innerHTML = `<h2>${esc(value.node_id)} · ${value.status === 'active' ? '異常持續' : '觀測已恢復'}</h2>
      <p>${esc(value.summary)}</p><p class="report-note">已偵測，尚未執行 AI 調查。沒有根因結論或 AI 報告。</p>
      <p>偵測時間：${esc(localTime(value.detected_at))} · 恢復時間：${esc(localTime(value.recovered_at))}</p>
      <h3>觸發時的節點觀測</h3>${raw(node)}
      <details><summary>連續確認依據</summary>${raw(value.confirmations)}</details>
      <details><summary>觸發時完整拓樸</summary>${raw(value.snapshot)}</details>
      ${value.recovery_snapshot ? `<details><summary>恢復確認依據與快照</summary>${raw({confirmations: value.recovery_confirmations, snapshot: value.recovery_snapshot})}</details>` : ''}`;
    error('detail');
  } catch (e) {
    if (request === detailRequest) { $('incident-detail').textContent = '無法讀取偵測依據。'; error('detail', e.message); }
  }
}
function route() {
  const parts = location.hash.slice(1).split('/');
  const history = ['detections', 'investigations', 'incidents'].includes(parts[0]);
  $('topology-view').hidden = history; $('incidents-view').hidden = !history; $('usage-view').hidden = true;
  $('nav-topology').classList.toggle('active', !history); $('nav-incidents').classList.toggle('active', history);
  $('page-title').textContent = history ? '偵測紀錄' : '服務拓樸';
  $('page-description').textContent = history ? '查看持續異常與恢復的觀測依據。AI 調查尚未接入。' : '即時監測服務關聯與狀態，持續確認異常。';
  if (history) {
    if (!historyLoaded) void loadHistory();
    if (parts[1]) {
      try { void loadDetail(decodeURIComponent(parts[1])); } catch { error('route', '偵測 ID 不合法'); }
    } else { selectedDetection = null; detailRequest++; $('incident-detail').hidden = true; }
    renderHistory();
  } else renderGraph();
}
async function refresh() {
  if (refreshBusy || disposed) return;
  refreshBusy = true;
  try { acceptState(await requestJSON('/api/investigator/state')); error('state'); }
  catch (e) { error('state', e.message); }
  finally { refreshBusy = false; }
  if (!$('incidents-view').hidden) void loadHistory();
}
function connect() {
  if (disposed || document.hidden || stream) return;
  const suffix = store.streamId === null ? '' : `?stream_id=${encodeURIComponent(store.streamId)}&after=${store.eventCursor}`;
  const events = new EventSource('/api/investigator/stream' + suffix);
  stream = events; lastActivity = Date.now();
  const receive = handler => event => {
    if (events !== stream || disposed) return;
    try { handler(JSON.parse(event.data)); lastActivity = Date.now(); error('stream'); }
    catch (e) { error('stream', e.message); reconnect(); }
  };
  events.addEventListener('state', receive(acceptState));
  events.addEventListener('reset', receive(value => {
    if (value.stream_id !== store.streamId || !Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error('事件重設位置不符狀態');
    store.eventCursor = value.cursor; store.events.clear(); scheduleJournal();
  }));
  events.addEventListener('detection', receive(value => {
    if (store.acceptEvent(value)) {
      renderCurrent(); renderHistory();
      if (selectedDetection === value.detection_id) void loadDetail(selectedDetection);
    }
  }));
  events.addEventListener('source_error', receive(value => error('event-source', value.message)));
  events.addEventListener('ping', receive(() => {}));
  events.onerror = () => { if (stream === events) reconnect(); };
}
function reconnect() {
  stream?.close(); stream = null; clearTimeout(streamRetry);
  connection('連線中斷，正在重連', 'stale');
  if (!disposed && !document.hidden) streamRetry = setTimeout(connect, 1000);
}
function reconnectLogs() {
  logStream?.close(); logStream = null;
  if (disposed || document.hidden || logRetry) return;
  error('monitor', 'Monitor log 連線中斷；調查串流仍獨立運作，重連不補送缺漏 log。');
  logRetry = setTimeout(() => { logRetry = null; connectLogs(); }, logDelay);
  logDelay = Math.min(8000, logDelay * 2);
}
function connectLogs() {
  if (disposed || document.hidden || logStream) return;
  lastLogActivity = Date.now();
  const events = new EventSource('/events'); logStream = events;
  const receive = handler => event => {
    if (logStream !== events || disposed) return;
    try {
      handler(JSON.parse(event.data)); lastLogActivity = Date.now(); logDelay = 1000; error('monitor');
    } catch (e) { error('monitor', `Monitor log 資料錯誤：${e.message}`); }
  };
  events.addEventListener('log', receive(log => {
    if (log.schema_version !== 'nightwatch.log.v1' || typeof log.event_id !== 'string' || !log.event_id || typeof log.monitor_id !== 'string' || !log.monitor_id || typeof log.message !== 'string' || !Number.isFinite(Date.parse(log.occurred_at)) || !['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].includes(log.level) || !Array.isArray(log.refs?.node_ids) || log.refs.node_ids.some(id => typeof id !== 'string')) throw new Error('不符合 nightwatch.log.v1。');
    retainLog(logs, log); scheduleJournal();
  }));
  events.addEventListener('ping', receive(value => {
    // Monitor /events sends an empty heartbeat, independently of investigation SSE.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ping 必須是物件。');
    if ('server_now' in value && !Number.isFinite(Date.parse(value.server_now))) throw new Error('ping 的 server_now 格式錯誤。');
  }));
  events.onerror = () => { if (logStream === events) reconnectLogs(); };
}

function dispose() {
  disposed = true; stream?.close(); logStream?.close();
  clearTimeout(streamRetry); clearTimeout(logRetry); clearTimeout(journalTimer);
  clearInterval(heartbeatTimer); clearInterval(snapshotPoll);
  cancelSnapshot(); snapshotIndexController?.abort(); graphResizeObserver?.disconnect();
  if (graphResizeFrame !== null) cancelAnimationFrame(graphResizeFrame);
}
export function startWorkspace() {
  document.title = 'NightWatch · 觀測與偵測';
  $('nav-usage').hidden = true;
  $('nav-incidents').href = '#detections'; $('nav-incidents').innerHTML = '偵測紀錄 <span id="nav-count">—</span>';
  $('source').value = 'live'; $('source').onchange = event => { const url = new URL(location.href); url.searchParams.set('source', event.target.value); location.href = url.href; };
  $('investigation-phase').parentElement.querySelector('h2').textContent = '異常偵測';
  $('agent-usage').hidden = true; $('show-journal').textContent = '觀測事件'; $('show-report').textContent = 'AI 報告';
  $('active-phase').previousElementSibling.textContent = '持續異常';
  $('graph-viewport').parentElement.querySelector('.assessment-legend').textContent = '預設顯示主要流程、警告與異常節點；可展開全部觀測點。';
  $('page-title').closest('.page-heading').insertAdjacentHTML('afterend', '<div class="investigation-actions"><button id="start-investigation" disabled>AI 調查尚未接入</button><span role="status">目前持續偵測異常與恢復；不執行模型或修復。</span></div>');
  $('snapshot-at').previousElementSibling.textContent = '顯示快照時間 · 台灣';
  $('graph-timeline').hidden = false;
  $('snapshot-range').oninput = event => { if (timelineBounds) selectSnapshot(timelineBounds.from + Number(event.target.value)); };
  $('snapshot-range').onchange = event => { if (timelineBounds) selectSnapshot(timelineBounds.from + Number(event.target.value), true); };
  $('snapshot-range').onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); stepSnapshot(['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1);
    }
  };
  $('snapshot-prev').onclick = () => stepSnapshot(-1); $('snapshot-next').onclick = () => stepSnapshot(1);
  $('graph-live').onclick = returnToLive;
  snapshotPoll = setInterval(() => { if (!document.hidden) void loadSnapshotIndex(); }, 5000);
  $('incidents-view').querySelector('thead tr').innerHTML = '<th>節點／偵測</th><th>狀態</th><th>原因</th><th>偵測時間 · 台灣</th><th>恢復時間</th><th>AI 調查</th>';
  $('incident-search').placeholder = '搜尋節點、偵測 ID 或原因…';
  $('incidents-view').querySelector('[data-status="active"]').textContent = '異常持續';
  $('incidents-view').querySelector('[data-status="closed"]').textContent = '觀測已恢復';
  $('list-count').insertAdjacentHTML('afterend', '<button id="more-detections" hidden>載入更多偵測紀錄</button>');
  $('more-detections').onclick = () => loadHistory(true);
  $('incident-search').oninput = renderHistory;
  document.querySelectorAll('[data-status]').forEach(button => button.onclick = () => {
    filter = button.dataset.status;
    document.querySelectorAll('[data-status]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); renderHistory();
  });
  document.querySelector('[data-event-source="agent"]').hidden = true;
  document.querySelectorAll('[data-event-source]').forEach(button => button.onclick = () => {
    journalFilter = button.dataset.eventSource;
    document.querySelectorAll('[data-event-source]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); scheduleJournal();
  });
  $('show-journal').onclick = () => { $('journal-panel').hidden = false; $('investigation-report').hidden = true; };
  $('show-report').onclick = () => { $('journal-panel').hidden = true; $('investigation-report').hidden = false; };
  $('node-search').insertAdjacentHTML('beforebegin', '<label class="graph-scope-toggle"><input id="show-all-nodes" type="checkbox"> 全部觀測點</label>');
  $('show-all-nodes').onchange = event => { showAllNodes = event.target.checked; renderGraph(); };
  $('node-search').oninput = renderGraph; $('health-filter').onchange = renderGraph;
  $('zoom-in').onclick = () => { fit = false; zoom = Math.min(2, zoom * 1.2); renderGraph(); };
  $('zoom-out').onclick = () => { fit = false; zoom = Math.max(.01, zoom / 1.2); renderGraph(); };
  $('fit').onclick = () => { fit = true; renderGraph(); $('graph-viewport').scrollTo(0, 0); };
  setupGraphFullscreen();
  $('refresh').onclick = refresh;
  document.querySelector('footer span:last-child').textContent = 'NightWatch · 觀測與異常偵測';
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => { if (fit) renderGraph(); });
  window.addEventListener('pagehide', dispose, {once: true});
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  document.addEventListener('visibilitychange', () => {
    stream?.close(); stream = null; logStream?.close(); logStream = null;
    clearTimeout(streamRetry); clearTimeout(logRetry);
    if (!document.hidden) { connect(); connectLogs(); void refresh(); }
  });
  heartbeatTimer = setInterval(() => {
    if (document.hidden) return;
    if (Date.now() - lastActivity > 15000 && stream) reconnect();
    if (Date.now() - lastLogActivity > 15000 && logStream) reconnectLogs();
  }, 1000);
  renderCurrent(); route(); void refresh(); void loadSnapshotIndex(); connect(); connectLogs();
}
