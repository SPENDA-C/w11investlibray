import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMonth,
  formatMonth,
  shiftMonth,
  monthGrid,
  calendarSection,
  handler,
} from '../.build/worker.mjs';
import { makeEnv } from './helpers/d1.mjs';

const ctx = { waitUntil() {}, passThroughOnException() {} };
const HOSTS = { LP_HOSTNAME: 'invest.example', APP_HOSTNAME: 'app.invest.example' };
const req = (u) => new Request(u);

const entry = (code, date, session = null) => ({
  symbolId: `JP.${code}`,
  code,
  name: `銘柄${code}`,
  announceDate: date,
  session,
});

// ---- 月の扱い ----------------------------------------------------------------

test('parseMonth — 妥当なものだけ通す', () => {
  assert.deepEqual(parseMonth('2026-11'), { year: 2026, month: 11 });
  assert.equal(parseMonth('2026-13'), null, '13 月が通っている');
  assert.equal(parseMonth('2026-00'), null, '0 月が通っている');
  assert.equal(parseMonth('2026-1'), null, 'ゼロ埋めなしが通っている');
  assert.equal(parseMonth(''), null);
  assert.equal(parseMonth('../../etc'), null);
});

test('shiftMonth — 年をまたぐ', () => {
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 11, 0), { year: 2026, month: 11 });
  assert.equal(formatMonth(2027, 1), '2027-01');
});

// ---- 升目 --------------------------------------------------------------------
//
// **曜日がずれるのが一番こわい。** 月初の余白を間違えると、
// 全部の日付が 1 列ずれて表示される。見た目では気付きにくい。

test('monthGrid — 月曜はじまりで、先頭の余白が合う', () => {
  // 2026-11-01 は日曜。月曜はじまりなら前に 6 個の余白が要る。
  const cells = monthGrid(2026, 11, []);
  const lead = cells.findIndex((c) => c.date !== null);
  assert.equal(lead, 6, `先頭の余白が ${lead} 個`);
  assert.equal(cells[6].date, '2026-11-01');
});

test('monthGrid — 月曜はじまりの月は余白ゼロ', () => {
  // 2026-06-01 は月曜。
  const cells = monthGrid(2026, 6, []);
  assert.equal(cells[0].date, '2026-06-01', '月曜はじまりなのに余白がある');
});

test('monthGrid — 升目は必ず 7 の倍数', () => {
  for (const [y, m] of [[2026, 1], [2026, 2], [2026, 11], [2027, 2], [2028, 2]]) {
    assert.equal(monthGrid(y, m, []).length % 7, 0, `${y}-${m} が 7 の倍数でない`);
  }
});

test('monthGrid — 日数が月ごとに正しい（閏年を含む）', () => {
  const days = (y, m) => monthGrid(y, m, []).filter((c) => c.date !== null).length;
  assert.equal(days(2026, 2), 28);
  assert.equal(days(2028, 2), 29, '閏年の 2 月が 29 日になっていない');
  assert.equal(days(2026, 11), 30);
  assert.equal(days(2026, 12), 31);
});

test('monthGrid — 同じ日の予定をまとめる', () => {
  const cells = monthGrid(2026, 11, [
    entry('72030', '2026-11-05'),
    entry('67580', '2026-11-05'),
    entry('99840', '2026-11-12'),
  ]);
  const d5 = cells.find((c) => c.date === '2026-11-05');
  assert.equal(d5.entries.length, 2);
  assert.equal(cells.find((c) => c.date === '2026-11-12').entries.length, 1);
});

test('monthGrid — 月外の予定は入れない', () => {
  const cells = monthGrid(2026, 11, [entry('72030', '2026-12-01')]);
  assert.equal(cells.reduce((n, c) => n + c.entries.length, 0), 0, '別の月の予定が入っている');
});

// ---- 描画 --------------------------------------------------------------------

test('calendarSection — JavaScript を出さない', () => {
  // LP の CSP は script-src none。ここに <script> が入ると画面が壊れる。
  const html = calendarSection({
    title: '日本株 決算カレンダー',
    year: 2026,
    month: 11,
    entries: [entry('72030', '2026-11-05', 'after')],
    basePath: '',
    anchor: 'cal-jp',
    emptyNote: 'まだありません',
  });
  assert.ok(!/<script/i.test(html), '<script> が入っている');
  assert.ok(!/ on[a-z]+=/i.test(html), 'インラインのイベント属性が入っている');
});

test('calendarSection — 予定が変わりうることを書く', () => {
  const html = calendarSection({
    title: 'x', year: 2026, month: 11,
    entries: [entry('72030', '2026-11-05')],
    basePath: '', anchor: 'cal-jp', emptyNote: 'まだありません',
  });
  assert.match(html, /予定は変更されることがあります/);
});

test('calendarSection — 空なら数字をでっち上げない', () => {
  const html = calendarSection({
    title: 'x', year: 2026, month: 11, entries: [],
    basePath: '', anchor: 'cal-jp', emptyNote: 'まだ取り込まれていません',
  });
  assert.match(html, /まだ取り込まれていません/);
  assert.ok(!/発表予定 0 件/.test(html));
});

test('calendarSection — 銘柄名を HTML エスケープする', () => {
  const html = calendarSection({
    title: 'x', year: 2026, month: 11,
    entries: [{ ...entry('1', '2026-11-05'), name: '<img src=x onerror=alert(1)>' }],
    basePath: '', anchor: 'cal-jp', emptyNote: '',
  });
  assert.ok(!/<img/i.test(html), '銘柄名がエスケープされていない');
  assert.match(html, /&lt;img/);
});

// ---- LP に出ること -----------------------------------------------------------

/** symbols と earnings_calendar に 1 件入れる。 */
async function seed(env, symbolId, market, code, name, date) {
  await env.INVEST_DB.prepare(
    `INSERT INTO symbols (symbol_id, market, code, name, currency, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'JPY', '2026-11-01')`,
  ).bind(symbolId, market, code, name).run();
  await env.INVEST_DB.prepare(
    `INSERT INTO earnings_calendar (symbol_id, announce_date, session, source, confirmed, fetched_at)
     VALUES (?1, ?2, NULL, 'jquants', 1, '2026-11-01')`,
  ).bind(symbolId, date).run();
}

test('データが 1 件も無い市場は、枠ごと出さない', async () => {
  // **公開 LP に空の升目を並べない。** 訪問者には作りかけに見えるだけで、
  // 何も伝わらない。取り込みが始まれば自動的に現れる。
  const env = makeEnv(HOSTS);
  const html = await (await handler.fetch(req('https://invest.example/'), env, ctx)).text();
  assert.ok(!html.includes('id="cal-jp"'), 'データが無いのにカレンダーが出ている');
  assert.ok(!html.includes('id="cal-us"'), 'データが無いのにカレンダーが出ている');
});

test('データがある市場だけカレンダーが出る', async () => {
  const env = makeEnv(HOSTS);
  await seed(env, 'JP.72030', 'JP', '7203', 'トヨタ自動車', '2026-11-05');
  const html = await (await handler.fetch(req('https://invest.example/'), env, ctx)).text();
  assert.match(html, /id="cal-jp"/, '日本株のカレンダーが出ていない');
  assert.ok(!html.includes('id="cal-us"'), '米国株は空なのに出ている');
});

test('当月が空でも、データがあれば枠は残す（翌月に送れるように）', async () => {
  const env = makeEnv(HOSTS);
  await seed(env, 'JP.72030', 'JP', '7203', 'トヨタ自動車', '2026-12-05');
  const html = await (
    await handler.fetch(req('https://invest.example/?cal-jp=2026-11'), env, ctx)
  ).text();
  assert.match(html, /id="cal-jp"/, '当月が空なだけで枠ごと消えている');
  assert.match(html, /2026年12月/, '翌月への導線が無い');
});

test('月の指定が壊れていても落ちない', async () => {
  const env = makeEnv(HOSTS);
  for (const q of ['?cal-jp=2026-13', '?cal-jp=../../etc', '?cal-jp=']) {
    const res = await handler.fetch(req(`https://invest.example/${q}`), env, ctx);
    assert.equal(res.status, 200, q);
  }
});

test('LP に JavaScript を足していない', async () => {
  const env = makeEnv(HOSTS);
  const res = await handler.fetch(req('https://invest.example/'), env, ctx);
  const html = await res.text();
  assert.ok(!/<script/i.test(html), 'LP に <script> が入っている');
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'none'/);
});
