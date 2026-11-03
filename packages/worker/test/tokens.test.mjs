import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  TOKENS, BRAND, CALENDAR_TOKENS, FONT_STACK, LP_FONT_STACK, layout, lpPage,
} from '../.build/worker.mjs';

const UI_DIR = fileURLToPath(new URL('../src/ui', import.meta.url));

/** 役割で名前を付けた共有パレット。ここに挙げたものは tokens.ts だけが定義する。 */
const SHARED_TOKENS = [
  '--bg', '--panel', '--ink', '--muted', '--line',
  '--accent', '--danger', '--warn', '--up', '--down', '--radius',
];

test('共有パレットは tokens.ts だけが定義する', () => {
  // 2 箇所に分かれていると、配色を変えたときに片方だけ取り残される。
  // LP とダッシュボードで色がずれるのがいちばん見苦しい壊れ方。
  const others = readdirSync(UI_DIR).filter((f) => f.endsWith('.ts') && f !== 'tokens.ts');
  assert.ok(others.length > 0, 'ui/ に他のファイルが無い');

  for (const name of others) {
    const source = readFileSync(join(UI_DIR, name), 'utf8');
    for (const token of SHARED_TOKENS) {
      // `--accent: #...` のような「定義」を探す。`var(--accent)` の参照は許す。
      const defines = new RegExp(`${token}\\s*:\\s*[^;\\n)]`).test(source);
      assert.ok(!defines, `${name} が ${token} を定義している。tokens.ts に寄せること`);
    }
  }
});

test('tokens.ts は明暗の両方を定義している', () => {
  for (const token of SHARED_TOKENS) {
    assert.ok(TOKENS.includes(`${token}:`), `${token} が tokens.ts に無い`);
  }
  assert.match(TOKENS, /prefers-color-scheme: dark/);

  // ダークで上書きしていない色があると、暗い地に明るい前提の色が残る。
  const dark = TOKENS.slice(TOKENS.indexOf('prefers-color-scheme: dark'));
  for (const token of ['--bg', '--panel', '--ink', '--muted', '--line', '--accent', '--danger']) {
    assert.ok(dark.includes(`${token}:`), `${token} がダークで上書きされていない`);
  }
});

test('LP とダッシュボードが同じパレットを配信する', () => {
  const app = layout({ title: 't', siteName: 's', body: '<p>x</p>' });
  const lp = lpPage({ siteName: 's', shortName: 's', basePath: '', appUrl: '/' });
  for (const page of [app, lp]) {
    assert.ok(page.includes('--accent: #'), 'パレットが出力に含まれていない');
    assert.ok(page.includes(FONT_STACK), '書体が出力に含まれていない');
  }
  // 同じ値が出ていること（片方だけ古い色になっていないこと）
  const pick = (html) => /--accent:\s*(#[0-9a-f]{6})/i.exec(html)?.[1];
  assert.equal(pick(app), pick(lp));
});

test('パレットは 1 ページにつき 1 回だけ出る', () => {
  const lp = lpPage({ siteName: 's', shortName: 's', basePath: '', appUrl: '/' });
  const count = (lp.match(/--accent:\s*#/g) ?? []).length;
  // ライト 1 回 + ダーク 1 回
  assert.equal(count, 2, `--accent の定義が ${count} 回出ている`);
});

// ---- LP のブランド色 --------------------------------------------------------

/** googletool-orange-basic の色。tokens.ts の BRAND だけが定義する。 */
const BRAND_TOKENS = [
  '--brand-accent', '--brand-accent-deep', '--brand-primary', '--brand-dark',
  '--brand-blue', '--brand-green', '--brand-ground', '--brand-surface',
  '--brand-text', '--brand-text-light',
];

test('ブランド色も tokens.ts だけが定義する', () => {
  const others = readdirSync(UI_DIR).filter((f) => f.endsWith('.ts') && f !== 'tokens.ts');
  for (const name of others) {
    const source = readFileSync(join(UI_DIR, name), 'utf8');
    for (const token of BRAND_TOKENS) {
      const defines = new RegExp(`${token}\\s*:\\s*[^;\\n)]`).test(source);
      assert.ok(!defines, `${name} が ${token} を定義している。tokens.ts に寄せること`);
    }
  }
  for (const token of BRAND_TOKENS) {
    assert.ok(BRAND.includes(`${token}:`), `${token} が BRAND に無い`);
  }
});

test('ブランド色は明暗で変わらない', () => {
  // LP はどの環境でも同じ色で出す（白いカードの影と、白で塗った波が
  // 明るい地を前提にしている）。ここに暗色の上書きを足すと落ちる。
  assert.ok(!BRAND.includes('prefers-color-scheme'), 'BRAND に暗色の上書きがある');
  // `light dark` に変えられても落ちるよう、終端まで見る
  assert.match(BRAND, /color-scheme:\s*light\s*;/);
});

test('ブランド色を出すのは LP だけ（ダッシュボードは出さない）', () => {
  const lp = lpPage({ siteName: 's', shortName: 's', basePath: '', appUrl: '/' });
  const app = layout({ title: 't', siteName: 's', body: '<p>x</p>' });
  assert.ok(lp.includes('--brand-accent:'), 'LP に BRAND が入っていない');
  assert.ok(!app.includes('--brand-accent:'), 'ダッシュボードに BRAND が入っている');
});

// ---- 決算カレンダーの色 ------------------------------------------------------

/** 時間帯と曜日の色。tokens.ts の CALENDAR_TOKENS だけが定義する。 */
const CAL_TOKENS = [
  '--cal-sun', '--cal-sat', '--cal-sun-bg', '--cal-sat-bg',
  '--cal-before-bg', '--cal-before-ink',
  '--cal-after-bg', '--cal-after-ink',
  '--cal-during-bg', '--cal-during-ink',
  '--cal-none-bg', '--cal-none-ink',
];

test('カレンダーの色も tokens.ts だけが定義する', () => {
  const others = readdirSync(UI_DIR).filter((f) => f.endsWith('.ts') && f !== 'tokens.ts');
  for (const name of others) {
    const source = readFileSync(join(UI_DIR, name), 'utf8');
    for (const token of CAL_TOKENS) {
      const defines = new RegExp(`${token}\\s*:\\s*[^;\\n)]`).test(source);
      assert.ok(!defines, `${name} が ${token} を定義している。tokens.ts に寄せること`);
    }
  }
  for (const token of CAL_TOKENS) {
    assert.ok(CALENDAR_TOKENS.includes(`${token}:`), `${token} が CALENDAR_TOKENS に無い`);
  }
});

// ---- 定義していない色を使っていないか ----------------------------------------

/**
 * **`var(--ground)` のような打ち間違いを落とす。**
 *
 * 定義していない変数を参照しても CSS はエラーを出さない。**その箇所が
 * 透明になるだけ**で、見ている本人が気付かない形で壊れる。実際に
 * カレンダーの曜日見出しと余白が、定義の無い `--ground` を参照していて
 * 背景が消えていた。
 *
 * 出来上がった HTML だけを見るので、どのページに何を差し込んだかの
 * 組み合わせ違い（LP にだけ BRAND を入れている等）もまとめて拾える。
 */
function undefinedVars(html) {
  const defined = new Set(
    [...html.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]),
  );
  const used = new Set([...html.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]));
  // `var(--x, 既定値)` と書いてあるものは、無くても困らないので除く。
  const withFallback = new Set(
    [...html.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/gi)].map((m) => m[1]),
  );
  return [...used].filter((v) => !defined.has(v) && !withFallback.has(v)).sort();
}

test('どのページも、定義していない色変数を参照していない', () => {
  const pages = {
    LP: lpPage({
      siteName: 's', shortName: 's', basePath: '', appUrl: '/',
      calendars: {
        jp: '', us: '',
      },
    }),
    ダッシュボード: layout({ title: 't', siteName: 's', body: '<p>x</p>' }),
  };
  for (const [name, html] of Object.entries(pages)) {
    const missing = undefinedVars(html);
    assert.deepEqual(missing, [], `${name} が定義の無い変数を参照している: ${missing.join(', ')}`);
  }
});

test('LP の書体は Noto Sans JP が先頭', () => {
  // Web フォントを読んでも、system-ui が先頭だとそちらが勝って効かない。
  assert.ok(LP_FONT_STACK.startsWith('"Noto Sans JP"'), LP_FONT_STACK);
  assert.ok(LP_FONT_STACK.includes(FONT_STACK), '読み込みに失敗したときの受け皿が要る');

  const lp = lpPage({ siteName: 's', shortName: 's', basePath: '', appUrl: '/' });
  assert.ok(lp.includes(LP_FONT_STACK));
  // 書体を読み込む <link> と、それを許す CSP は対で要る（headers.test.mjs が CSP 側）
  assert.match(lp, /fonts\.googleapis\.com\/css2\?family=Noto\+Sans\+JP/);
});
