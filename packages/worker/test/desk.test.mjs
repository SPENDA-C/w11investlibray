import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../.build/worker.mjs';
import { makeEnv } from './helpers/d1.mjs';

const ctx = { waitUntil() {}, passThroughOnException() {} };
const HOSTS = { LP_HOSTNAME: 'invest.example', APP_HOSTNAME: 'app.invest.example' };
const ACCESS = { CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud123' };
const req = (u, init) => new Request(u, init);

async function addQuotes(env, rows) {
  for (const [symbolId, market, code, price, currency, asOf] of rows) {
    await env.INVEST_DB.prepare(
      `INSERT INTO symbols (symbol_id, market, code, name, currency, updated_at)
       VALUES (?1, ?2, ?3, ?3, ?4, '2026-10-11')`,
    )
      .bind(symbolId, market, code, currency)
      .run();
    await env.INVEST_DB.prepare(
      `INSERT INTO quotes_snapshot (symbol_id, as_of, price, currency, source, fetched_at)
       VALUES (?1, ?2, ?3, ?4, 'googlefinance', ?2)`,
    )
      .bind(symbolId, asOf, price, currency)
      .run();
  }
}

// ---- 公開の可否 --------------------------------------------------------------
//
// Google の金融データは個人利用を前提とした記述があり、会員へ配る形が
// 利用条件に合うか確認できていない（docs/DATA-SOURCES.md の 5）。
// **J-Quants の再配信（同 2）と同じ扱いで、確認が済むまで閉じる。**

test('Access も未設定・フラグも false なら /desk は開かない', async () => {
  // デプロイ後・Access 設定前は必ず生じる期間。ここで開けると、
  // ホスト名を知っているだけで取り込んだ値が読めてしまう。
  const env = makeEnv(HOSTS);
  await addQuotes(env, [['US.NVDA', 'US', 'NVDA', 188.42, 'USD', '2026-10-11T03:34:56.000Z']]);
  const res = await handler.fetch(req('https://app.invest.example/desk'), env, ctx);
  assert.equal(res.status, 503);
  assert.ok(!(await res.text()).includes('188.42'), '停止中なのに値が出ている');
});

test('フラグを立てれば Access 無しでも開く', async () => {
  // 利用条件の確認が済んだとき用の口。**既定では通らないこと**が上のテスト。
  const env = makeEnv({ ...HOSTS, QUOTES_PUBLIC_ENABLED: 'true' });
  await addQuotes(env, [['US.NVDA', 'US', 'NVDA', 188.42, 'USD', '2026-10-11T03:34:56.000Z']]);
  const res = await handler.fetch(req('https://app.invest.example/desk'), env, ctx);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /188\.42/);
});

test('Access が設定済みなら、フラグが false でも認証の先で開く', async () => {
  // 自分で見るぶんには再配信の論点が立たない。ただし Access は
  // 手前で止めるので、認証が通っていなければここには来ない（401）。
  const env = makeEnv({ ...HOSTS, ...ACCESS });
  const res = await handler.fetch(req('https://app.invest.example/desk'), env, ctx);
  assert.equal(res.status, 401, 'Access 有効時に認証を素通ししている');
});

test('/desk は LP 側から到達できない', async () => {
  const env = makeEnv({ ...HOSTS, QUOTES_PUBLIC_ENABLED: 'true' });
  await addQuotes(env, [['US.NVDA', 'US', 'NVDA', 188.42, 'USD', '2026-10-11T03:34:56.000Z']]);
  const res = await handler.fetch(req('https://invest.example/desk'), env, ctx);
  assert.equal(res.status, 404, 'LP 側で応答している');
});

// ---- 中身 --------------------------------------------------------------------

test('銘柄ごとに最新の 1 行だけを出す', async () => {
  // quotes_snapshot は取り込むたびに行が増える。畳まないと同じ銘柄が並ぶ。
  const env = makeEnv({ ...HOSTS, QUOTES_PUBLIC_ENABLED: 'true' });
  await addQuotes(env, [['US.NVDA', 'US', 'NVDA', 180.0, 'USD', '2026-10-10T03:00:00.000Z']]);
  await env.INVEST_DB.prepare(
    `INSERT INTO quotes_snapshot (symbol_id, as_of, price, currency, source, fetched_at)
     VALUES ('US.NVDA', '2026-10-11T03:00:00.000Z', 188.42, 'USD', 'googlefinance', '2026-10-11T03:00:00.000Z')`,
  ).run();

  const text = await (
    await handler.fetch(req('https://app.invest.example/desk'), env, ctx)
  ).text();
  assert.match(text, /188\.42/, '最新の値が出ていない');
  assert.ok(!text.includes('180.00'), '古い行も一緒に出ている');
});

test('取り込みが無ければ、数字をでっち上げずに「まだ」と言う', async () => {
  const env = makeEnv({ ...HOSTS, QUOTES_PUBLIC_ENABLED: 'true' });
  const res = await handler.fetch(req('https://app.invest.example/desk'), env, ctx);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /まだ取り込まれていません/);
});

test('JavaScript を足していない（CSP の script-src none のまま出せること）', async () => {
  const env = makeEnv({ ...HOSTS, QUOTES_PUBLIC_ENABLED: 'true' });
  await addQuotes(env, [['FX.USDJPY', 'FX', 'USDJPY', 152.31, 'JPY', '2026-10-11T03:00:00.000Z']]);
  const res = await handler.fetch(req('https://app.invest.example/desk'), env, ctx);
  const text = await res.text();
  assert.ok(!/<script/i.test(text), 'デスクに <script> が入っている');
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'none'/);
});

test('遅延と ETF 代替であることを画面に書く', async () => {
  // **約 20 分遅れの値を、約定価格のように見せない。**
  // 金・銀は現物ではなく ETF なので、そう書く。
  const env = makeEnv({ ...HOSTS, QUOTES_PUBLIC_ENABLED: 'true' });
  await addQuotes(env, [['US.GLD', 'US', 'GLD', 250.5, 'USD', '2026-10-11T03:00:00.000Z']]);
  const text = await (
    await handler.fetch(req('https://app.invest.example/desk'), env, ctx)
  ).text();
  assert.match(text, /遅延/);
  assert.match(text, /ETF/);
});
