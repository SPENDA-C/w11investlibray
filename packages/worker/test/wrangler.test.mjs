import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');

/**
 * wrangler は名前付き環境へ vars / d1 / r2 / triggers を引き継がない。
 * 既定と [env.production] の写しがずれると、**本番だけ壊れて気づきにくい**。
 * ここでずれを検出する。
 */

/** `[vars]` や `[env.production.vars]` の中身をキー→値で取り出す。 */
function readTable(source, header) {
  const start = source.indexOf(`[${header}]`);
  if (start < 0) return null;
  const rest = source.slice(start + header.length + 2);
  // 次の [ ではじまる行まで
  const end = rest.search(/^\[/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const out = {};
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (m === null || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2];
  }
  return out;
}

test('既定と本番の vars は同じ項目を持つ', () => {
  const base = readTable(CONFIG, 'vars');
  const prod = readTable(CONFIG, 'env.production.vars');
  assert.ok(base !== null, '[vars] が無い');
  assert.ok(prod !== null, '[env.production.vars] が無い');
  assert.deepEqual(
    Object.keys(base).sort(),
    Object.keys(prod).sort(),
    '本番だけ項目が欠けている / 余っている',
  );
});

test('ホスト名は既定で空、本番で設定されている', () => {
  const base = readTable(CONFIG, 'vars');
  const prod = readTable(CONFIG, 'env.production.vars');

  // 既定にホスト名を入れると wrangler dev がそのホストを模擬してしまい、
  // ローカルで LP しか開けなくなる（実際にそうなった）。
  assert.equal(base['LP_HOSTNAME'], '""', '既定の LP_HOSTNAME は空にする');
  assert.equal(base['APP_HOSTNAME'], '""', '既定の APP_HOSTNAME は空にする');

  assert.match(prod['LP_HOSTNAME'], /^"[a-z0-9.-]+\.[a-z]{2,}"$/, '本番の LP_HOSTNAME');
  assert.match(prod['APP_HOSTNAME'], /^"[a-z0-9.-]+\.[a-z]{2,}"$/, '本番の APP_HOSTNAME');
  assert.notEqual(prod['LP_HOSTNAME'], prod['APP_HOSTNAME'], 'LP とアプリは別ホストにする');
});

test('workers.dev を有効にしていない', () => {
  // Access はゾーンのホスト名に紐づくので、workers.dev からは適用されない。
  assert.ok(!/^\s*workers_dev\s*=\s*true/m.test(CONFIG), 'workers_dev = true が残っている');
  assert.match(CONFIG, /^workers_dev = false/m);
});

test('本番のルートは、意図した宛先だけ', () => {
  // **数を固定するのではなく、顔ぶれを固定する。**
  // 守りたいのは「知らないホストにルートが向いていないこと」で、
  // 本数そのものではない（www を足したときにここが落ちた）。
  const patterns = [...CONFIG.matchAll(/^pattern = "([^"]+)"/gm)].map((m) => m[1]);
  const prod = readTable(CONFIG, 'env.production.vars');
  const lp = prod['LP_HOSTNAME'].replaceAll('"', '');
  const app = prod['APP_HOSTNAME'].replaceAll('"', '');

  assert.ok(patterns.includes(`${app}/*`), `アプリのルートが無い: ${patterns.join(', ')}`);

  // **apex は別の Worker（別リポジトリ）が持っている。**
  // こちらが残しているのは、URL を変えたくない 3 つだけ。
  // ワイルドカードで apex を取り返すと、向こうのトップページを
  // 丸ごと飲み込む（Cloudflare は具体的なルートを優先するため、
  // `${lp}/*` を書いた瞬間にこちらが勝ってしまう）。
  assert.ok(
    !patterns.includes(`${lp}/*`),
    `apex をワイルドカードで取り返している: ${patterns.join(', ')}`,
  );
  for (const path of ['/privacy', '/api/waitlist', '/api/health']) {
    assert.ok(
      patterns.includes(`${lp}${path}`),
      `${path} のルートが無い: ${patterns.join(', ')}`,
    );
  }

  const allowed = new Set([
    `${app}/*`,
    `${lp}/privacy`,
    `${lp}/privacy/`,
    `${lp}/api/waitlist`,
    `${lp}/api/health`,
  ]);
  const unexpected = patterns.filter((p) => !allowed.has(p));
  assert.deepEqual(unexpected, [], `意図しないルートがある: ${unexpected.join(', ')}`);

  // 同じ宛先を 2 度書いていないこと。
  assert.equal(new Set(patterns).size, patterns.length, `重複したルートがある: ${patterns.join(', ')}`);
});

test('既定にはルートを書かない（wrangler dev がホストを模擬するため）', () => {
  const beforeProd = CONFIG.slice(0, CONFIG.indexOf('[env.production]'));
  assert.ok(!/^\[\[routes\]\]/m.test(beforeProd), '既定に [[routes]] がある');
});

test('会員登録は閉じたまま', () => {
  for (const table of ['vars', 'env.production.vars']) {
    assert.equal(readTable(CONFIG, table)['MEMBER_SIGNUP_ENABLED'], '"false"', table);
  }
});

test('秘密情報を wrangler.toml に書いていない', () => {
  for (const key of ['JQUANTS_API_KEY', 'ANTHROPIC_API_KEY']) {
    const assigned = new RegExp(`^\\s*${key}\\s*=`, 'm').test(CONFIG);
    assert.ok(!assigned, `${key} が設定されている。wrangler secret put を使うこと`);
  }
});
