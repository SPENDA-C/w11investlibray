/**
 * Node 側の J-Quants クライアント。
 *
 * Worker 側（`packages/worker/src/connectors/jquants.ts`）と別実装になっているのは、
 * Worker のコードが `@cloudflare/workers-types` に依存していて Node から読めないため。
 * **ただし項目名の別名表はここが持ち、Worker とは独立に動く。**
 * 別名を足すときは両方に入れること（`npm run check` の出力をそのまま貼れる形にしてある）。
 *
 * 計算（指標・スコア・バックテスト）は共有していて、そちらは `@invest/core` の 1 本だけ。
 * ここで重複しているのは HTTP の取り回しだけで、検証の意味は損なわれない。
 */

export const DEFAULT_BASE_URL = 'https://api.jquants.com/v2';

/**
 * V2 の経路。**V1 とは名前がまったく違う。**
 *
 *   /listed/info              → /equities/master
 *   /prices/daily_quotes      → /equities/bars/daily
 *   /markets/trading_calendar → /markets/calendar
 *
 * V1 の名前のまま /v2 に投げると、API Gateway が経路なしとして **403** を返す。
 * 「契約プランの範囲外」に見えるので、原因に辿り着くまで遠回りした。
 * 出典は本番運用中の実装（spenda-agency/w09jquantsclaude の
 * `src/jqsd/jquants.py`）。**推測で書かないこと。**
 *
 * Worker 側（packages/worker/src/connectors/jquants.ts の JP_PATHS）と
 * 同じ値を持つ。**片方だけ直すと本番とバックフィルがずれる。**
 */
export const JP_PATHS = {
  master: '/equities/master',
  dailyBars: '/equities/bars/daily',
  calendar: '/markets/calendar',
} as const;

export const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  date: ['Date', 'date', 'Dt'],
  code: ['Code', 'code', 'Cd'],
  open: ['Open', 'O', 'AdjustmentOpen'],
  high: ['High', 'H', 'AdjustmentHigh'],
  low: ['Low', 'L', 'AdjustmentLow'],
  close: ['Close', 'C', 'AdjustmentClose'],
  volume: ['Volume', 'V', 'Vo', 'AdjustmentVolume'],
  turnover: ['TurnoverValue', 'Va', 'TurnoverVa', 'TuVa', 'Turnover'],
  adjustmentFactor: ['AdjustmentFactor', 'AdjFactor', 'AdjustmentF', 'AdjFa', 'AdjF'],
  companyName: ['CoName', 'CompanyName', 'CompanyNameJapanese', 'Name', 'Nm', 'CoNm'],
  sector33: ['S33Nm', 'S33', 'Sector33CodeName', 'Sector33Code', 'Sc33Nm'],
  sector17: ['S17Nm', 'S17', 'Sector17CodeName', 'Sector17Code', 'Sc17Nm'],
  holidayDivision: ['HolDiv', 'HolidayDivision', 'HolidayDiv', 'HdDiv'],
};

export type Row = Record<string, unknown>;

/**
 * 401 / 403 に「次にどこを触るか」を足す。
 *
 * **403 は 2 種類ある。** どちらも同じ状態コードで返ってくるので、
 * API 自身の言い分（本文）で分ける:
 *
 *   1. 経路が無い → API Gateway が経路なしとして 403。**キーは無関係。**
 *      V1 の名前を /v2 に投げてこれを踏み、プランを上げてキーを 2 度
 *      発行し直すまで気付かなかった。ここでキーの話をすると同じ遠回りになる
 *   2. キーが効いていない → 期限切れ・失効・別のキー
 *
 * 2 のときに 3 箇所すべてを出すのは、**キーが独立したコピーで 3 つあり、
 * 1 つ更新しても残りは古いまま**だから。Actions は即落ちるので気付くが、
 * Cloudflare の secret が古いと **毎日の Cron が静かに失敗し続ける**。
 *
 * **キーの値は出さない。** 先頭数文字も出さない（ログに残る）。
 */
export function keyHint(status: number, body: unknown): string {
  if (status !== 401 && status !== 403) return '';

  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');

  // **契約が切れている。** キーは正しいので、置き場所を案内すると
  // まるごと誤案内になる（実際にそう出して遠回りさせた）。
  if (/no active subscription|subscription status/i.test(text)) {
    return `  → **契約が有効でない。** キーの置き場所の問題ではない。
     https://jpx-jquants.com/ で契約状態を確認する。
     無料プランも含めて「契約が無い」状態だと、最下位の経路も 403 になる。
     支払いが止まっている・期間が終了している・解約済みのいずれか。
     **契約を戻すまで、日次パイプラインも止まったままになる。**`;
  }

  if (/endpoint does not exist/i.test(text)) {
    return `  → 経路が違う。**キーの問題ではない。**
     API Gateway は経路に一致しないリクエストへ 403 を返す。
     packages/batch/src/jquants.ts の JP_PATHS と、叩いているパスを見比べること。`;
  }

  return `  → キーが効いていない。**このプロセスが読んだのは環境変数 JQUANTS_API_KEY。**
     キーは独立したコピーが 3 箇所にある。1 つ更新しても残りは古いまま:
       1. 手元の export JQUANTS_API_KEY   → check:datasource・手元の backfill
       2. Cloudflare Worker の secret     → 毎日の Cron
          npx wrangler secret put JQUANTS_API_KEY --env production
       3. GitHub Actions の secret        → このワークフロー
          Settings → Secrets and variables → Actions
     手順は docs/DEPLOY.md の「キーを更新したとき」。`;
}

export interface FetchPage {
  readonly rows: Row[];
  readonly status: number;
}

export class Jquants {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly extraAliases: Record<string, readonly string[]> = {},
  ) {
    if (!apiKey) throw new Error('JQUANTS_API_KEY が未設定');
  }

  /** 生の 1 ページ。`check` が状態コードを見たいので分けてある。 */
  async probe(path: string, params: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { 'x-api-key': this.apiKey, accept: 'application/json' } });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 300);
    }
    return { status: res.status, body };
  }

  /**
   * **レコードは `data` キーに入る。** V1 は経路ごとに違うキーだったが、
   * V2 は全経路 `data` で揃っている。既定値にしてあるのは、
   * また変わったときに 1 箇所で受けられるようにするため。
   */
  async getAll(path: string, params: Record<string, string>, key = 'data'): Promise<Row[]> {
    const rows: Row[] = [];
    let paginationKey: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const url = new URL(`${this.baseUrl}${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (paginationKey !== undefined) url.searchParams.set('pagination_key', paginationKey);

      const res = await fetch(url, { headers: { 'x-api-key': this.apiKey, accept: 'application/json' } });
      if (res.status === 429) {
        // レート制限。素直に待って同じページをやり直す。
        await sleep(5000);
        continue;
      }
      if (!res.ok) {
        // **本文を必ず出す。** 状態コードだけ出して本文を捨てていた時期があり、
        // 「契約プランの範囲外」と誤診して遠回りした。理由は API が書いてくる。
        const text = await res.text();
        const hint = keyHint(res.status, text);
        throw new Error(
          `J-Quants ${path} が ${res.status}: ${text.slice(0, 200)}${hint === '' ? '' : `\n${hint}`}`,
        );
      }
      const json = (await res.json()) as Record<string, unknown>;
      const chunk = json[key];
      if (Array.isArray(chunk)) rows.push(...(chunk as Row[]));
      const next = json['pagination_key'];
      if (typeof next !== 'string' || next === '') break;
      paginationKey = next;
    }
    return rows;
  }

  field(row: Row, canonical: string): unknown {
    const candidates = [...(this.extraAliases[canonical] ?? []), ...(FIELD_ALIASES[canonical] ?? [])];
    for (const name of candidates) {
      const v = row[name];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  numberOf(row: Row, canonical: string): number | null {
    const v = this.field(row, canonical);
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  stringOf(row: Row, canonical: string): string | null {
    const v = this.field(row, canonical);
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
