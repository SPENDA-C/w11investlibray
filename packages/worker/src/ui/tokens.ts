/**
 * デザイントークン。**配色と書体はここが唯一の定義。**
 *
 * LP（`lp.ts`）とダッシュボード（`layout.ts`）が同じ値を別々に持っていると、
 * 配色を変えたときに片方だけ取り残される。**LP とアプリで色がずれる**のが
 * いちばん見苦しい壊れ方なので、パレットは 1 箇所に寄せてある。
 *
 * 出しているものは 2 つある。
 *
 *   `TOKENS` — 役割で名前を付けた共有パレット。明暗の両方を持つ。
 *              LP もダッシュボードも先頭に入れる。
 *   `BRAND`  — LP のブランド色。**明暗で変わらない。** LP だけが入れる。
 *
 * **なぜ 2 つに分かれているか。** ダッシュボードは長時間見る道具なので
 * ダークモードが要る。LP は名刺なので、どの環境でも同じ色で出したい
 * （白いカードに落とす影と、ヒーロー下の波（白で塗った SVG）は
 * 明るい地を前提にしている）。LP 側は `color-scheme: light` を宣言して
 * `--brand-*` だけを使う。
 *
 * 色の出どころは `spenda-agency/landing-page` の `googletool-orange-basic`。
 *
 * `test/tokens.test.mjs` が、他のファイルでパレットを再定義していないことを
 * 検査している。
 */

/**
 * 本文の書体。和文が読める順に並べる。
 * ダッシュボードはここまで（外部への通信を増やさない）。
 */
export const FONT_STACK =
  'system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';

/**
 * LP の書体。**Noto Sans JP を先頭に置く。**
 *
 * `FONT_STACK` は system-ui が先頭なので、Web フォントを読み込んでも
 * そちらが勝って効かない。LP はデザイン指定が Noto Sans JP なので
 * 先頭に足したものを使う（後ろは `FONT_STACK` そのまま＝読み込みに
 * 失敗しても和文が出る）。
 *
 * 読み込み元は Google Fonts。**訪問者の IP が Google に渡る**ので、
 * プライバシーポリシーの「外部サービス」に書いてある。
 */
export const LP_FONT_STACK = `"Noto Sans JP", ${FONT_STACK}`;

/**
 * すべてのページの先頭に入れる。パレット、ダークの上書き、最小限のリセット。
 *
 * 色は「役割」で名前を付けてある（`--accent` であって `--orange` ではない）。
 * テンプレートの色に差し替えても、使う側のコードを直さずに済む。
 */
export const TOKENS = `
:root {
  /* 地と文字 */
  --bg: #fbfaf9;
  --panel: #ffffff;
  --ink: #1a1a19;
  --muted: #6b6a67;
  --line: #e5e3df;

  /* 役割色。--accent はブランドのオレンジ */
  --accent: #ff7d27;
  --danger: #a4402f;
  --warn: #8a6d1f;

  /* 相場の上下。**--accent とは別に持つ。**
     上げ下げは意味が決まっているので、ブランド色に引きずらせない */
  --up: #2f6f4f;
  --down: #a4402f;

  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a;
    --panel: #1e1e23;
    --ink: #eceae6;
    --muted: #9b9a96;
    --line: #32323a;

    /* 暗い地の上ではオレンジを少し明るくしないと沈む */
    --accent: #ff9350;
    --danger: #e08272;
    --warn: #d9b45c;

    --up: #6dbd92;
    --down: #e08272;
  }
}
* { box-sizing: border-box; }
`;

/**
 * LP のブランド色。**`prefers-color-scheme` で変えない。**
 *
 * LP は `color-scheme: light` を宣言して、この 8 色だけで組む。
 * ここに暗色の上書きを足さないこと（白いカードの影と
 * ヒーロー下の波が明るい地を前提にしている）。
 */
export const BRAND = `
:root {
  color-scheme: light;

  --brand-accent: #ff7d27;        /* ビビッドオレンジ。CTA と強調 */
  --brand-accent-deep: #ff5c00;   /* グラデーションの終端とホバー */
  --brand-primary: #2c3e50;       /* ダークブルー。見出しとフッター */
  --brand-dark: #1a252f;          /* グラデーションの終端 */
  --brand-blue: #3498db;          /* 補助色1。手順の番号 */
  --brand-green: #27ae60;         /* 補助色2 */
  --brand-ground: #f5f7fa;        /* 節の地（bg-light） */
  --brand-surface: #ffffff;       /* カードの地 */
  --brand-text: #333333;
  --brand-text-light: #7f8c8d;

  /* 影。カードの浮きは 3 段階しか使わない */
  --brand-shadow-1: 0 2px 6px rgba(0, 0, 0, .06);
  --brand-shadow-2: 0 4px 16px rgba(34, 49, 108, .08);
  --brand-shadow-3: 0 8px 30px rgba(0, 0, 0, .06);
}
`;

/**
 * 決算カレンダーの色。**ここが唯一の定義**（`ui/calendar.ts` で色を書かない）。
 *
 * 分類は**発表の時間帯だけ**にしてある。いま持っているデータで
 * 確実に言えるのがこれしかないため——Finnhub の `hour` は
 * `bmo` / `amc` / 空 の 3 通りしか実測できていない（`docs/DATA-SOURCES.md` §6）。
 * **業種やテーマで色を分けない。** 分類の根拠が無いまま色を付けると、
 * 見た人が意味を読み取ってしまう。
 *
 * `during`（場中）は Finnhub の出力では一度も観測していないが、
 * 綴りとしては存在しうるので色だけ用意してある。
 *
 * 明暗で変えない。LP は `color-scheme: light` 固定（`BRAND` と同じ理由）。
 */
export const CALENDAR_TOKENS = `
:root {
  /* 曜日。日曜を赤、土曜を青にするのは日本のカレンダーの慣習 */
  --cal-sun: #d64545;
  --cal-sat: #2f80c4;
  --cal-sun-bg: #fdf4f4;
  --cal-sat-bg: #f3f8fc;

  /* 発表の時間帯。地と文字で 1 組 */
  --cal-before-bg: #e8f2fb;   /* 寄前 */
  --cal-before-ink: #1d6ca8;
  --cal-after-bg: #fff0e4;    /* 引後 */
  --cal-after-ink: #c4560f;
  --cal-during-bg: #e8f6ed;   /* 場中 */
  --cal-during-ink: #1e7a46;
  --cal-none-bg: #eef0f3;     /* 時間未定 */
  --cal-none-ink: #5f6b7a;
}
`;
