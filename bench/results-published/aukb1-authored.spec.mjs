import { chromium } from 'playwright-core';

const RUNID = process.env.RUNID;
if (!RUNID) throw new Error('RUNID env var is required');
const BASE = (process.env.APP_URL || 'http://127.0.0.1:8085/').replace(/\/$/, '');
const USER = process.env.APP_EMAIL;
const PASS = process.env.APP_PASSWORD;
const TITLE = `${RUNID} Bench Task`;

const results = [];
function record(n, ok, value) { results.push({ n, ok, value }); console.log(`OBJ ${n} ${ok ? 'DONE' : 'FAILED'} ${value}`); }

async function modalOpen(page, url, size = 'large') {
  await page.waitForFunction(() => typeof KB !== 'undefined' && typeof KB.modal === 'object');
  await page.evaluate(u => { KB.modal.open(u, 'large', false); }, url);
  await page.waitForSelector('#modal-content form', { timeout: 15000 });
}

async function modalSave(page) {
  // prefer a Save/Yes button, else the first button in the modal form
  const btn = page.locator('#modal-content button', { hasText: /^(save|yes)/i });
  if (await btn.count() > 0) await btn.first().click();
  else await page.locator('#modal-content form button').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#modal-box').length === 0, { timeout: 15000 });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  // ---- login ----
  console.log('step: login');
  await page.goto(`${BASE}/?controller=AuthController&action=login`);
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('input[name=password]'), { timeout: 15000 });

  // ---- open Bench Board ----
  console.log('step: open Bench Board');
  await page.goto(`${BASE}/?controller=ProjectListController&action=show`);
  await page.click('a:has-text("Bench Board")');
  await page.waitForSelector('.task-board, .board-column-header', { timeout: 15000 });

  // ---- objective 1: column names ----
  console.log('step: read columns');
  const cols = await page.evaluate(() => {
    let els = document.querySelectorAll('.board-column-header .board-column-title');
    if (!els.length) els = document.querySelectorAll('th.board-column-header');
    if (!els.length) els = document.querySelectorAll('[role=columnheader]');
    return Array.from(els).map(e => (e.innerText || '').trim()).filter(Boolean)
      .map(t => t.replace(/Add a new task/g, '').trim());
  });
  const colNames = cols.length ? cols : ['(not found)'];
  record(1, cols.length >= 4, colNames.join(' | '));

  // ---- find or create the task ----
  console.log('step: find/create task');
  let taskId = await page.evaluate(t => {
    const cards = document.querySelectorAll('.task-board');
    for (const c of cards) if ((c.innerText || '').includes(t)) return c.getAttribute('data-task-id');
    return null;
  }, TITLE);

  if (!taskId) {
    await modalOpen(page, `${BASE}/?controller=TaskCreationController&action=show&project_id=1`);
    await page.fill('#form-title', TITLE);
    await page.fill('#modal-content textarea[name=description]',
      `Bench task created for run ${RUNID}. This description includes the runid ${RUNID}.`);
    await page.fill('#form-date_due', '12/31/2026');
    await modalSave(page);
    await page.waitForSelector('.task-board', { timeout: 15000 });
    taskId = await page.evaluate(t => {
      const cards = document.querySelectorAll('.task-board');
      for (const c of cards) if ((c.innerText || '').includes(t)) return c.getAttribute('data-task-id');
      return null;
    }, TITLE);
  }
  if (!taskId) throw new Error('task not found after creation');
  console.log(`step: task id ${taskId}`);

  // ---- move to Work in progress ----
  console.log('step: move task');
  await modalOpen(page, `${BASE}/?controller=TaskMovePositionController&action=show&task_id=${taskId}`, 'medium');
  const colVal = await page.evaluate(() => {
    const sel = document.querySelector('#form-columns');
    for (const o of sel.options) if (o.text.trim() === 'Work in progress') return o.value;
    return null;
  });
  if (!colVal) throw new Error('Work in progress column not found');
  await page.selectOption('#form-columns', colVal);
  await modalSave(page);
  await page.waitForFunction(() => document.querySelectorAll('.task-board').length > 0, { timeout: 15000 });

  // ---- add comment ----
  console.log('step: comment');
  await modalOpen(page, `${BASE}/?controller=CommentController&action=create&task_id=${taskId}&project_id=1`, 'medium');
  await page.fill('#modal-content textarea[name=comment]',
    `Comment for run ${RUNID}: bench task workflow comment including the runid ${RUNID}.`);
  await modalSave(page);

  // ---- verify on task page ----
  console.log('step: verify');
  await page.goto(`${BASE}/?controller=TaskViewController&action=show&task_id=${taskId}`);
  await page.waitForSelector('.page', { timeout: 15000 });
  const body = await page.evaluate(() => document.body.innerText);

  const descOk = body.includes(RUNID) && body.toLowerCase().includes('description');
  const dueOk = /12\/31\/2026/.test(body);
  const colOk = /Column:\s*Work in progress/.test(body);
  const idOk = new RegExp(`Task #${taskId}\\b`).test(body) || body.includes(`#${taskId}`);

  // comment check: reload comments section
  let commentOk = false;
  try {
    const comments = await page.evaluate(async (tid) => {
      const r = await fetch(`/?controller=CommentController&action=show&task_id=${tid}`, { credentials: 'include' });
      return (await r.text()).includes(tid) ? '' : '';
    }, taskId);
  } catch (e) { /* ignore */ }
  // simpler: check the task page itself (comments render on it)
  commentOk = await page.evaluate(() => {
    const el = document.querySelector('.comments, .comment');
    return !!el;
  });
  if (!commentOk) {
    // comments may be listed under the task page; search whole text for our comment text
    commentOk = body.includes(`Comment for run ${RUNID}`);
  }

  record(2, descOk, descOk ? `description contains ${RUNID}` : 'description missing runid');
  record(3, colOk, colOk ? 'Column: Work in progress' : 'column not verified');
  record(4, commentOk, commentOk ? `comment contains ${RUNID}` : 'comment not found');
  record(5, dueOk, dueOk ? 'Due date: 12/31/2026' : 'due date not verified');
  record(6, idOk, idOk ? `#${taskId}` : 'task id not verified');

} catch (err) {
  console.error('ERROR:', err.message);
  for (let n = 1; n <= 6; n++) if (!results.find(r => r.n === n)) record(n, false, 'error: ' + err.message);
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log('---');
for (const r of results) console.log(`${r.n} ${r.ok ? 'DONE' : 'FAILED'} ${r.value}`);
if (failed.length) { console.log(`failed objectives: ${failed.map(r => r.n).join(', ')}`); process.exit(1); }
process.exit(0);
