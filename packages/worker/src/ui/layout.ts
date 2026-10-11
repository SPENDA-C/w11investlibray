import { escapeHtml } from './format.js';
import { FONT_STACK, TOKENS } from './tokens.js';

export interface LayoutOptions {
  readonly title: string;
  /** ヘッダーと <title> の接尾辞。**短縮名を渡す**（正式名は 24 文字あり長い）。 */
  readonly siteName: string;
  readonly body: string;
  /** Access が未設定のまま本番に出ていないか、画面上で気付けるようにする。 */
  readonly accessWarning?: boolean;
  readonly sampleData?: boolean;
  readonly activeNav?: 'dashboard' | 'screener' | 'desk' | 'waitlist' | null;
}

export function layout(o: LayoutOptions): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(o.title)} — ${escapeHtml(o.siteName)}</title>
<style>${TOKENS}${STYLES}</style>
</head>
<body>
<header class="site">
  <a class="brand" href="/">${escapeHtml(o.siteName)}</a>
  <nav>
    <a href="/"${o.activeNav === 'dashboard' ? ' class="on"' : ''}>ダッシュボード</a>
    <a href="/screener"${o.activeNav === 'screener' ? ' class="on"' : ''}>スクリーナー</a>
    <a href="/desk"${o.activeNav === 'desk' ? ' class="on"' : ''}>デスク</a>
    <a href="/waitlist"${o.activeNav === 'waitlist' ? ' class="on"' : ''}>先行登録</a>
  </nav>
</header>
${o.accessWarning === true ? WARN_ACCESS : ''}
${o.sampleData === true ? WARN_SAMPLE : ''}
<main>${o.body}</main>
<footer>
  <p class="disclaimer">
    本システムは情報提供および投資判断の支援を目的としたもので、特定銘柄の売買を勧誘するものではありません。
    表示されるスコアおよびシグナルは過去データに基づく機械的な計算結果であり、将来の価格や収益を保証しません。
    <strong>投資判断はご自身の責任で行ってください。</strong>
  </p>
  <p class="note">
    スコアは「条件への合致度」であり、期待リターンではありません。
    バックテストによる検証は Phase 5 で行います。
  </p>
</footer>
</body>
</html>`;
}

const WARN_ACCESS = `<div class="banner banner-danger">
  <strong>Cloudflare Access が未設定です。</strong>
  この画面は現在だれでも閲覧できる状態です。
  <code>CF_ACCESS_TEAM_DOMAIN</code> と <code>CF_ACCESS_AUD</code> を設定してください。
</div>`;

const WARN_SAMPLE = `<div class="banner banner-warn">
  <strong>サンプルデータです。</strong>本物の市場データではありません。
</div>`;

/** ダッシュボード側の見た目。パレットは tokens.ts が持つ。 */
const STYLES = `
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: ${FONT_STACK};
  font-size: 15px; line-height: 1.6;
}
a { color: inherit; }
header.site {
  display: flex; align-items: baseline; gap: 1.5rem; flex-wrap: wrap;
  padding: 1rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--panel);
}
.brand { font-weight: 700; text-decoration: none; letter-spacing: .02em; }
header nav { display: flex; gap: 1rem; }
header nav a { color: var(--muted); text-decoration: none; font-size: .9rem; }
header nav a.on, header nav a:hover { color: var(--ink); }
main { max-width: 1080px; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; }
.sub { color: var(--muted); font-size: .875rem; margin: 0 0 1.5rem; }
.banner {
  padding: .75rem 1.25rem; font-size: .875rem;
  border-bottom: 1px solid var(--line);
}
.banner-danger { background: color-mix(in srgb, var(--danger) 12%, var(--panel)); }
.banner-warn { background: color-mix(in srgb, var(--warn) 15%, var(--panel)); }
.banner code { font-size: .85em; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin-bottom: 2rem; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: .85rem 1rem; }
.card .k { color: var(--muted); font-size: .78rem; }
.card .v { font-size: 1.5rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
table { width: 100%; border-collapse: collapse; font-size: .875rem; }
th, td { padding: .6rem .75rem; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: .78rem; text-align: right; position: sticky; top: 0; background: var(--panel); }
th:first-child, td:first-child, th.l, td.l { text-align: left; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
td.num, th.num { font-variant-numeric: tabular-nums; }
td a { text-decoration: none; font-weight: 550; }
td a:hover { text-decoration: underline; }
.rank { color: var(--muted); font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: .1rem .5rem; border-radius: 100px; font-size: .75rem; border: 1px solid var(--line); }
.v-buy-now { background: color-mix(in srgb, var(--accent) 18%, transparent); border-color: var(--accent); }
.v-buy-watch { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.v-watch { color: var(--muted); }
.v-avoid { color: var(--muted); opacity: .75; }
.spark-up { color: var(--up); }
.spark-down { color: var(--down); }
.score { font-variant-numeric: tabular-nums; font-weight: 650; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem 1.15rem; }
.panel h3 { margin: 0 0 .75rem; font-size: .9rem; color: var(--muted); font-weight: 500; }
dl.kv { display: grid; grid-template-columns: auto 1fr; gap: .35rem 1rem; margin: 0; font-size: .875rem; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--accent); }
form.filters { display: flex; gap: .75rem; flex-wrap: wrap; align-items: end; margin-bottom: 1.25rem; }
form.filters label { display: flex; flex-direction: column; gap: .25rem; font-size: .78rem; color: var(--muted); }
select, input, button {
  font: inherit; font-size: .875rem; padding: .35rem .6rem; border-radius: 6px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
}
button { cursor: pointer; }
.empty { padding: 2.5rem 1rem; text-align: center; color: var(--muted); }
footer { max-width: 1080px; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; border-top: 1px solid var(--line); }
.disclaimer { font-size: .8rem; color: var(--muted); margin: 0 0 .5rem; }
.note { font-size: .78rem; color: var(--muted); margin: 0; }
`;
