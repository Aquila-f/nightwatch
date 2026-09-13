// Optional browser acceptance. Set PLAYWRIGHT_MODULE to an installed playwright module.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ACCEPTANCE_CONSOLE_URL;
if (!base) throw new Error('Run through detection_flow.py --browser-script tests/acceptance/detection_browser.mjs');
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(8000);
  const errors = [], urls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => urls.push(request.url()));
  await page.goto(base + '/?source=live#topology');
  await page.locator('.graph-node').first().waitFor();
  assert.equal(await page.locator('#start-investigation').isDisabled(), true);
  assert.match(await page.locator('#investigation-summary').innerText(), /尚未執行 AI 調查/);
  await page.locator('#connection-setup > summary').click();
  await page.locator('#check-connection').click();
  await page.waitForFunction(() => document.querySelector('#connection-check').textContent.includes('接收成功'));
  await page.locator('#connection-setup > summary').click();
  await page.locator('#graph-fullscreen').click();
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(dialog => dialog.open), true);
  await page.keyboard.press('Escape');
  await page.locator('#snapshot-prev').click();
  await page.waitForFunction(() => document.querySelector('#graph-mode').textContent === '歷史 graph');
  await page.locator('#graph-live').click();
  await page.locator('#nav-incidents').click();
  await page.waitForFunction(() => document.querySelectorAll('#incident-rows tr').length === 2);
  assert.match(await page.locator('#incident-rows').innerText(), /觀測已恢復/);
  await page.locator('#incident-rows a').first().click();
  await page.locator('#incident-detail h2').waitFor();
  assert.match(await page.locator('#incident-detail').innerText(), /尚未執行 AI 調查/);
  assert.ok(urls.every(url => new URL(url).origin === base), 'Browser must only contact its Guard Room origin');
  assert.deepEqual(errors, [], 'No JavaScript runtime errors');
  await mkdir('.run/acceptance', {recursive: true});
  await page.screenshot({path: '.run/acceptance/detection-history.png', fullPage: true});
  await page.locator('#nav-topology').click();
  await page.screenshot({path: '.run/acceptance/detection-topology.png', fullPage: true});
  console.log('PASS: browser topology, snapshots, fullscreen, detection history/detail, disabled AI, same-origin requests');
} finally {
  await browser.close();
}
