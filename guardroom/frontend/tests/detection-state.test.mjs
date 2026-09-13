import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DetectionStore} from '../src/investigation-data.js';

const graph = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/catalog_pool_leak/state.json', import.meta.url))).graph_now;
const detection = (status = 'active', seq = 1) => ({schema_version: 'nightwatch.detection.v1', id: 'det-a',
  node_id: 'a', status, event_seq: seq, created_cursor: 1, detected_at: new Date().toISOString()});
const state = (cursor = 0, stream = 'one', rows = []) => ({schema_version: 'nightwatch.observation-workspace.v1',
  server_now: new Date().toISOString(), graph, investigator: {available: true, message: null, state: {
    schema_version: 'nightwatch.investigator-state.v1', stream_id: stream, cursor, active_count: rows.length,
    runner_available: false, source: {}, recent_detections: rows,
  }}});
const event = (cursor, row = detection()) => ({schema_version: 'nightwatch.investigator-event.v1',
  event_id: `evt-${cursor}`, cursor, detection_id: row.id, seq: row.event_seq,
  type: row.status === 'active' ? 'detection.created' : 'detection.recovered', payload: row});

test('reconnect snapshots do not skip unread events or roll recovered detections backwards', () => {
  const store = new DetectionStore();
  store.acceptState(state());
  store.acceptState(state(2, 'one', [detection('recovered', 2)]));
  assert.equal(store.eventCursor, 0);
  assert.equal(store.acceptEvent(event(1)), true);
  assert.equal(store.detections.get('det-a').status, 'recovered');
  assert.equal(store.acceptEvent(event(1)), false);
  store.acceptEvent(event(2, detection('recovered', 2)));
  assert.equal(store.eventCursor, 2);
});

test('journal replacement resets cursors and cached detections', () => {
  const store = new DetectionStore();
  store.acceptState(state(3, 'one', [detection()]));
  store.acceptState(state(0, 'two'));
  assert.equal(store.eventCursor, 0);
  assert.equal(store.detections.size, 0);
  assert.equal(store.acceptEvent(event(1)), true);
});

test('gaps are rejected without advancing replay position', () => {
  const store = new DetectionStore();
  store.acceptState(state());
  assert.throws(() => store.acceptEvent(event(2)), /缺口/);
  assert.equal(store.eventCursor, 0);
});
