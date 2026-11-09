/**
 * デプロイ前チェック。`npm run deploy` の直前に走る。
 *
 * **テストに入れていない理由**: `database_id` が未設定なのはローカル開発では
 * 正常な状態で、CI を赤くしてはいけない。デプロイのときだけ止めたい。
 *
 * 失敗したら「何をどう直すか」まで出す。wrangler の素のエラーは
 * 原因が読み取りにくい。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = fileURLToPath(
  new URL('../packages/worker/wrangler.toml', import.meta.url),
);
const config = readFileSync(CONFIG_PATH, 'utf8');

/**
 * 運営者情報を書く場所。**角括弧が残っていたらデプロイを止める。**
 * `docs/GO-LIVE.md` の A5。
 */
const OPERATOR_FILES = ['packages/worker/src/routes/lp.ts', 'packages/worker/src/ui/lp.ts'];

const errors = [];
const warnings = [];

/** `[env.production.vars]` などのテーブルをキー→値で読む。 */
function readTable(header) {
  const start = config.indexOf(`[${header}]`);
  if (start < 0) return null;
  const rest = config.slice(start + header.length + 2);
  const end = rest.search(/^\[/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const out = {};
  for (const line of body.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m !== null) out[m[1]] = m[2];
  }
  return out;
}

const prod = readTable('env.production.vars');
if (prod === null) {
  errors.push([
    '[env.production.vars] が見つからない',
    'wrangler.toml の本番セクションが壊れている可能性がある',
  ]);
}

// --- D1 -------------------------------------------------------------------
const prodBlock = config.slice(config.indexOf('[env.production]'));
const dbId = /\[\[env\.production\.d1_databases\]\][\s\S]*?database_id\s*=\s*"([^"]*)"/.exec(prodBlock)?.[1];
if (dbId === undefined) {
  errors.push([
    '本番の database_id が見つからない',
    '[[env.production.d1_databases]] に database_id を書く',
  ]);
} else if (dbId.startsWith('REPLACE_WITH') || dbId.trim() === '') {
  errors.push([
    'database_id が未設定（プレースホルダのまま）',
    'npx wrangler d1 create invest-db を実行し、出力された id を\n' +
      '    wrangler.toml の [[env.production.d1_databases]] に貼る',
  ]);
}

// --- ホスト名とルート -------------------------------------------------------
if (prod !== null) {
  for (const key of ['LP_HOSTNAME', 'APP_HOSTNAME']) {
    if (!prod[key]) {
      errors.push([
        `本番の ${key} が空`,
        `wrangler.toml の [env.production.vars] に ${key} を設定する`,
      ]);
    }
  }
  if (prod['LP_HOSTNAME'] && prod['LP_HOSTNAME'] === prod['APP_HOSTNAME']) {
    errors.push([
      'LP とアプリのホスト名が同じ',
      'Access の適用範囲が分けられなくなる。別ホストにする',
    ]);
  }

  const patterns = [...prodBlock.matchAll(/^pattern = "([^"]+)"/gm)].map((m) => m[1]);

  // アプリ側はホストごと持っている。ここが無いとダッシュボードが出ない。
  const app = prod['APP_HOSTNAME'];
  if (app && !patterns.includes(`${app}/*`)) {
    errors.push([
      `${app} のルートが無い`,
      `[[env.production.routes]] に pattern = "${app}/*" を足す`,
    ]);
  }

  // **apex はホストごとは持っていない。**
  // `/` と記事は別リポジトリの Worker（w10cloudflare の apps/fxstock）。
  // こちらが残しているのは URL を変えたくない 3 本だけ。
  // ここを `${lp}/*` にすると、向こうのトップページを丸ごと飲み込む。
  const lp = prod['LP_HOSTNAME'];
  if (lp) {
    if (patterns.includes(`${lp}/*`)) {
      errors.push([
        `${lp}/* を取り返している`,
        'apex の / と記事は別の Worker（apps/fxstock）が持っている。\n' +
          '    ワイルドカードを書くと、具体的なルートとしてこちらが勝ち、\n' +
          '    向こうのトップページが出なくなる。残すのは完全一致の 3 本だけ。',
      ]);
    }
    for (const path of ['/privacy', '/api/waitlist', '/api/health']) {
      if (!patterns.includes(`${lp}${path}`)) {
        errors.push([
          `${lp}${path} のルートが無い`,
          `[[env.production.routes]] に pattern = "${lp}${path}" を足す`,
        ]);
      }
    }
  }

  // --- Access（警告どまり）--------------------------------------------------
  if (!prod['CF_ACCESS_TEAM_DOMAIN'] || !prod['CF_ACCESS_AUD']) {
    warnings.push([
      'Cloudflare Access が未設定',
      'ダッシュボードが誰でも見られる状態になる。\n' +
        '    Access をかける前に一度デプロイしたいだけなら、このままでよい。\n' +
        '    手順は docs/DEPLOY.md の 9',
    ]);
  }
  if (prod['MEMBER_SIGNUP_ENABLED'] === 'true') {
    warnings.push([
      '会員登録が開いている',
      'docs/DATA-SOURCES.md の「再配信の可否」が埋まっているか確認する',
    ]);
  }
}

// --- Cron ------------------------------------------------------------------
// **デプロイの最後で落ちる。** ルートは張られたのに Cron だけ登録されない、
// という中途半端な状態になる（実際にそうなった）。先に止める。
//
// `0 22 * * 0-4` は Cloudflare に invalid cron string [code: 10100] で
// 拒否された。曜日に 0 を書かず 1-7 の範囲にすれば通る（同じデプロイで
// `30 10 * * 1-5` は受理されている）。
for (const m of config.matchAll(/^crons\s*=\s*\[([^\]]*)\]/gm)) {
  for (const raw of m[1].split(',')) {
    const cron = raw.trim().replace(/^["']|["']$/g, '');
    if (cron === '') continue;

    const fields = cron.split(/\s+/);
    if (fields.length !== 5) {
      errors.push([
        `cron の項目数が 5 でない: "${cron}"`,
        '分 時 日 月 曜日 の 5 つで書く',
      ]);
      continue;
    }
    if (/(^|[^0-9])0([^0-9]|$)/.test(fields[4])) {
      errors.push([
        `cron の曜日に 0 がある: "${cron}"`,
        'Cloudflare は曜日の 0 を invalid cron string [code: 10100] で拒否する。\n' +
          `    1-7 の範囲で書き直す（例: ${fields.slice(0, 4).join(' ')} 1-5）`,
      ]);
    }
  }
}

// --- 運営者情報の未記入 ------------------------------------------------------
// **LP は公開した瞬間からメールアドレスを集め始める。**
// 誰が集めているのかが分からない状態で集めてはいけないので、警告ではなく停止。
// 逃げ道（環境変数で無効化）は作らない。作れば使われる。
//
// CI では走らない（.github/workflows/ci.yml は typecheck / test / verify-seed だけ）。
const unfilled = [];
for (const rel of OPERATOR_FILES) {
  const source = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
  source.split('\n').forEach((line, i) => {
    if (line.includes('を記入')) unfilled.push(`${rel}:${i + 1}`);
  });
}
if (unfilled.length > 0) {
  errors.push([
    '運営者情報が未記入のまま',
    'LP は公開した瞬間からメールアドレスを集め始める。\n' +
      '    誰が集めているのかが分からない状態で集めてはいけない。\n' +
      `    角括弧を実際の名称・所在地・連絡先で置き換える:\n      ${unfilled.join('\n      ')}\n` +
      '    書き方は docs/GO-LIVE.md の A5',
  ]);
}

// --- workers.dev -----------------------------------------------------------
if (/^\s*workers_dev\s*=\s*true/m.test(config)) {
  errors.push([
    'workers_dev = true になっている',
    'Access はゾーンのホスト名に紐づくので、*.workers.dev には適用されない。\n' +
      '    その URL でダッシュボードが認証なしに開く。false にする',
  ]);
}

// --- 出力 -------------------------------------------------------------------
for (const [title, how] of warnings) {
  console.error(`⚠ ${title}\n    ${how}`);
}
if (errors.length === 0) {
  console.error(`✓ デプロイ前チェック通過${warnings.length > 0 ? `（警告 ${warnings.length} 件）` : ''}`);
  process.exit(0);
}
console.error('');
for (const [title, how] of errors) {
  console.error(`✗ ${title}\n    ${how}`);
}
console.error(`\n${errors.length} 件を直してから deploy すること。`);
process.exit(1);
