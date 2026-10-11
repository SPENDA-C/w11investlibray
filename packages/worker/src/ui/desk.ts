import { escapeHtml } from './format.js';

/**
 * デスク画面。GOOGLEFINANCE から取り込んだ現在値を資産種別ごとに並べる。
 *
 * **JavaScript を 1 行も使わない。** 表を出すだけなので要らない。
 * CSP の `script-src 'none'` をこの画面のためには緩めない
 * （チャートを入れる段で初めて必要になる）。
 */

export interface QuoteView {
  readonly symbolId: string;
  readonly market: string;
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly currency: string;
  readonly asOf: string;
}

/** 市場の表示名。`symbols.market` の値と揃えてある。 */
const MARKET_LABEL: Readonly<Record<string, string>> = {
  US: '米国株',
  JP: '日本株',
  FX: '為替',
  CRYPTO: '暗号資産',
};

const MARKET_ORDER = ['US', 'FX', 'CRYPTO', 'JP'];

/** 通貨に応じた桁。為替と暗号資産は株より細かい。 */
function fmtPrice(price: number, market: string): string {
  const digits = market === 'FX' ? 3 : market === 'CRYPTO' ? 2 : 2;
  return price.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function deskPage(o: {
  readonly quotes: readonly QuoteView[];
  readonly asOf: string | null;
  /** 取り込みが古いまま止まっていないか。 */
  readonly stale: boolean;
}): string {
  if (o.quotes.length === 0) {
    return `<h1>デスク</h1>
<p class="empty">まだ取り込まれていません。</p>
<p class="note">
  Google スプレッドシートに GOOGLEFINANCE の表を作り、
  <code>npm run check:sheet</code> で取れるティッカーを確かめてから、
  「現在値の取り込み」ワークフローを回してください。
  手順は <code>docs/DATA-SOURCES.md</code> の 5。
</p>`;
  }

  const byMarket = new Map<string, QuoteView[]>();
  for (const q of o.quotes) {
    const list = byMarket.get(q.market);
    if (list === undefined) byMarket.set(q.market, [q]);
    else list.push(q);
  }

  const sections = MARKET_ORDER.filter((m) => byMarket.has(m))
    .map((m) => table(m, byMarket.get(m) ?? []))
    .join('\n');

  return `<h1>デスク</h1>
<p class="meta">
  時点 ${o.asOf === null ? '—' : escapeHtml(o.asOf)}
  ${o.stale ? '<strong class="stale">（取り込みが止まっている可能性があります）</strong>' : ''}
</p>
${sections}
<p class="note">
  値は Google スプレッドシートの GOOGLEFINANCE から取り込んだものです。
  <strong>約 20 分の遅延があり、取引の約定価格ではありません。</strong>
  金・銀は現物ではなく ETF（GLD / SLV）の価格で、現物価格とは経費率のぶんだけずれます。
</p>`;
}

function table(market: string, rows: readonly QuoteView[]): string {
  const body = rows
    .slice()
    .sort((a, b) => (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0))
    .map(
      (q) => `  <tr>
    <td class="code">${escapeHtml(q.code)}</td>
    <td>${escapeHtml(q.name)}</td>
    <td class="num">${escapeHtml(fmtPrice(q.price, q.market))}</td>
    <td class="cur">${escapeHtml(q.currency)}</td>
  </tr>`,
    )
    .join('\n');

  return `<section>
<h2>${escapeHtml(MARKET_LABEL[market] ?? market)}</h2>
<table>
  <thead><tr><th>コード</th><th>名称</th><th class="num">値</th><th>通貨</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>
</section>`;
}
