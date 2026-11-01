import { Jquants, JP_PATHS, keyHint } from '../jquants.js';

// reasonFrom はこのファイルで定義している（下）。keyHint は jquants.js から。

/**
 * 疎通確認。
 *
 * **API が実際に返してきた項目名をそのまま表示する。**
 * V2 で項目名が短縮されたうえ、プランによって返る項目も違うので、
 * 「動くはず」ではなく実際の姿を見てから設計を確定させる。
 * ここの出力を docs/DATA-SOURCES.md に貼ること。
 *
 * **失敗したときに何が悪いのかを言うのが、このコマンドの半分の仕事。**
 * 状態コードだけ出して本文を捨てていた時期があり、Light プランに
 * 上げた直後の全 403 を「契約プランの範囲外」と誤診した。
 * API は 403 の本文に理由を書いてくるので、それを必ず出す。
 */

/** Phase 1 の日次パイプラインが実際に叩くもの。ここが通らなければ先へ進めない。 */
const REQUIRED = new Set<string>([JP_PATHS.master, JP_PATHS.dailyBars, JP_PATHS.calendar]);

interface Probe {
  (path: string, params: Record<string, string>): Promise<{ status: number; body: unknown }>;
}

/**
 * 応答本文から、人が読める理由を 1 行取り出す。
 *
 * J-Quants は `{"message": "..."}` を返す。形が変わっても何か出せるように、
 * よくあるキーを順に見て、無ければ本文そのものを短く切る。
 */
export function reasonFrom(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200);
  if (body === null || typeof body !== 'object') return '';
  const obj = body as Record<string, unknown>;
  for (const key of ['message', 'Message', 'error', 'detail']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v.slice(0, 200);
  }
  return JSON.stringify(obj).slice(0, 200);
}

/**
 * `--path` で渡された「まだ確かめていない経路」。
 *
 * **ここに既定値を置かない。** 当てずっぽうのパスをコードに焼き付けて
 * 403 を眺めたのが、このプロジェクトで一番高くついた失敗。
 * 叩くのは人が明示的に渡したものだけにする。
 */
export interface ExtraProbe {
  readonly path: string;
  readonly params: Record<string, string>;
}

/** `key=value,key2=value2` を読む。空なら `{}`。 */
export function parseParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k !== '') out[k] = v;
  }
  return out;
}

export async function runCheck(
  apiKey: string,
  baseUrl: string,
  date: string,
  probe?: Probe,
  extra: readonly ExtraProbe[] = [],
): Promise<number> {
  // テストから差し込めるようにしてある。既定は本物のクライアント。
  const call: Probe = probe ?? ((path, params) => new Jquants(apiKey, baseUrl).probe(path, params));
  console.log(`J-Quants 疎通確認  base=${baseUrl}  date=${date}\n`);

  // **財務（Phase 1b）はここに入れない。** V2 での経路を確認できていないので、
  // 当てずっぽうのパスを置いて 403 を眺めることになる——それが今回の失敗そのもの。
  // 使う段になったら、仕様を確認してから足す。
  const endpoints: [string, string, Record<string, string>][] = [
    ['銘柄一覧', JP_PATHS.master, { date }],
    ['日足', JP_PATHS.dailyBars, { date }],
    ['営業日', JP_PATHS.calendar, { from: date, to: date }],
  ];

  let ok = 0;
  let forbidden = 0;
  const missingRequired: string[] = [];

  for (const [label, path, params] of endpoints) {
    const { status, body } = await call(path, params);
    if (status !== 200) {
      console.log(`✗ ${label.padEnd(14)} ${path}  HTTP ${status}`);
      // **理由を必ず出す。** ここを捨てると、次に何をすればいいか分からない。
      const reason = reasonFrom(body);
      if (reason !== '') console.log(`    → ${reason}`);
      // 401 / 403 は「次にどこを触るか」まで出す。経路違いとキー切れを取り違えない。
      const hint = keyHint(status, body);
      if (hint !== '') console.log(hint);
      if (status === 403) forbidden += 1;
      if (REQUIRED.has(path)) missingRequired.push(path);
      continue;
    }
    ok += 1;
    // V2 はどの経路もレコードを `data` に入れる。
    const rows = (body as Record<string, unknown>)['data'];
    const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    console.log(`✓ ${label.padEnd(14)} ${path}  ${list.length} 件`);
    const first = list[0];
    if (first !== undefined) {
      console.log(`    実際の項目名: ${Object.keys(first).join(', ')}`);
    }
  }

  // **確かめていない経路は、ここで試す。** 既定の 3 本とは分けて出す。
  // 通ったものだけを docs/DATA-SOURCES.md に日付付きで記録し、
  // そのあとで初めてコードに書く。
  if (extra.length > 0) {
    console.log('\n--- 未確認の経路（--path で渡されたもの）---');
    for (const e of extra) {
      const { status, body } = await call(e.path, e.params);
      const q = Object.entries(e.params)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const label = q === '' ? e.path : `${e.path}?${q}`;
      if (status !== 200) {
        console.log(`✗ ${label}  HTTP ${status}`);
        const reason = reasonFrom(body);
        if (reason !== '') console.log(`    → ${reason}`);
        const hint = keyHint(status, body);
        if (hint !== '') console.log(hint);
        continue;
      }
      const rows = (body as Record<string, unknown>)['data'];
      const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
      console.log(`✓ ${label}  ${list.length} 件`);
      const first = list[0];
      if (first !== undefined) {
        console.log(`    実際の項目名: ${Object.keys(first).join(', ')}`);
      } else {
        // 200 だが空。経路は合っているが条件が違う可能性がある。
        console.log(`    200 だが 0 件。日付や銘柄コードの指定を変えて試す`);
      }
    }
  }

  console.log('');

  // **403 の意味は、1 本ずつでは決まらない。全体を見てから言う。**
  // /equities/master は最下位のプランでも通る。全部 403 なら
  // 「プランの範囲外」ではありえない。
  if (ok === 0 && forbidden === endpoints.length) {
    console.log(`すべて 403。契約プランの範囲外ではない。
  ${JP_PATHS.master} は最下位のプランでも通るので、全部が 403 になる説明にならない。
  疑う順に:
    1. **経路が間違っている。** API Gateway は経路に一致しないリクエストへ 403 を返す。
       上の「→」に「endpoint does not exist」と書いてあればこれ（一度これで嵌まった）
    2. キーが効いていない → ダッシュボードで発行し直す
    3. プラン変更がまだ反映されていない → 少し待ってもう一度
  「→」の行が API 自身の言い分。推測より先にそれを読むこと。`);
  } else if (missingRequired.length > 0) {
    console.log(`日次パイプラインに必要な ${missingRequired.join(' / ')} が取れない。
  ここが通らないとトラック B は進められない。上の「→」の行を読むこと。`);
  }

  console.log(`
出力の読み方
  - 「実際の項目名」が既定の別名表に無いときは、
    packages/worker/src/connectors/jquants.ts と packages/batch/src/jquants.ts の
    FIELD_ALIASES に足すか、環境変数 JQUANTS_FIELD_ALIASES で上書きする。
  - 日次パイプラインに要るのは
    ${JP_PATHS.master} と ${JP_PATHS.dailyBars} と ${JP_PATHS.calendar} の 3 本。
  - 財務（Phase 1b）は V2 での経路が未確認なので、ここでは叩いていない。
  - 確認できた内容を docs/DATA-SOURCES.md に日付付きで記録すること。`);

  return missingRequired.length === 0 ? 0 : 1;
}
