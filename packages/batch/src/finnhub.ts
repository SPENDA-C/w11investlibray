/**
 * Finnhub のクライアント。決算発表カレンダーを日米まとめて取る。
 *
 * **依存パッケージを足していない。** `packages/batch` の dependencies は
 * `@invest/core` だけ。やることは GET 1 本なので fetch で足りる。
 *
 * **経路と項目名をここに焼き付けない。** 既定値は「候補」であって、
 * 実際に何が返るかは `check-finnhub` の出力で決める。J-Quants の経路を
 * 推測で断定して 403 を 3 日追いかけた前例がある（docs/DATA-SOURCES.md）。
 */

export const DEFAULT_BASE_URL = 'https://finnhub.io/api/v1';

/**
 * 決算カレンダーの経路の**候補**。
 * **確認が済むまで、これを根拠にコードを書かない。**
 */
export const CANDIDATE_EARNINGS_PATH = '/calendar/earnings';

export class Finnhub {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {
    if (!apiKey) throw new Error('FINNHUB_API_KEY が未設定');
    // J-Quants で踏んだ ByteString の件と同じガード。全角や改行が
    // 混ざると、ヘッダを組む段で読みにくい例外になる。
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new Error(
        'FINNHUB_API_KEY に使えない文字が入っている（ASCII の印字可能文字だけ）。\n' +
          '  全角の記号や、貼り付けたときの改行が混ざっていないか確認する。',
      );
    }
  }

  /**
   * 生の 1 回。**状態コードと本文をそのまま返す。**
   * 判断材料を捨てないのが、このクラスの一番の仕事。
   */
  async probe(
    path: string,
    params: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    // **キーはヘッダで渡す。** クエリに載せるとサーバーのアクセスログや
    // リファラに残りうる。
    const res = await fetch(url, {
      headers: { 'X-Finnhub-Token': this.apiKey, accept: 'application/json' },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 300);
    }
    return { status: res.status, body };
  }
}

/**
 * 状態コードから「次にどこを触るか」を出す。
 * **キーの値は出さない。**
 */
export function finnhubHint(status: number, body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');

  if (status === 401 || status === 403) {
    return `  → キーが効いていない。**このプロセスが読んだのは環境変数 FINNHUB_API_KEY。**
     キーは独立したコピーが 2 箇所にある:
       1. 手元の export FINNHUB_API_KEY   → check:finnhub
       2. GitHub Actions の secret        → 取り込みのワークフロー
     finnhub.io のダッシュボードでキーが有効かも確認する。`;
  }
  if (status === 429) {
    return `  → 回数制限。無料枠は 1 分あたりの上限が低い。
     少し待ってからもう一度。定期実行の間隔も見直す。`;
  }
  if (/premium|upgrade|access/i.test(text)) {
    return `  → 契約プランの範囲外の可能性がある。本文の言い分を読むこと。
     無料枠で取れる範囲は finnhub.io の料金ページで確認する。`;
  }
  if (status === 404) {
    return `  → 経路が違う。--path で別の綴りを試す。
     **推測をコードに書かないこと。** 通ったものだけ記録する。`;
  }
  return '';
}
