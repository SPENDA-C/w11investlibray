import { createSign } from 'node:crypto';

/**
 * Google スプレッドシートを読む。
 *
 * **依存パッケージを足していない。** `packages/batch` の dependencies は
 * `@invest/core` だけで、devDependencies は空。Google のクライアント
 * ライブラリを入れるとその構成が崩れるし、やることは
 * 「JWT を署名して、トークンに替えて、1 本 GET する」だけなので
 * `node:crypto` と fetch で足りる。
 *
 * **なぜシートを読むのか。** GOOGLEFINANCE は表計算の数式で、API が無い。
 * シートそのものが取得層になる。
 */

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
export const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
}

/**
 * サービスアカウントの JSON を読む。
 *
 * **鍵の中身は一切ログに出さない**（先頭数文字も出さない）。
 * 欠けているときは「どこで取り直すか」まで言う。
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON が空。\n' +
        '  Google Cloud コンソール → IAM と管理 → サービス アカウント → キー → 鍵を追加（JSON）。\n' +
        '  取得した JSON を丸ごと環境変数に入れる。',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON が JSON として読めない。\n' +
        '  ダウンロードした鍵ファイルの中身を**そのまま**入れること。\n' +
        '  パスではなく中身。改行を含んだまま渡してよい。',
    );
  }

  const obj = parsed as Record<string, unknown>;
  const clientEmail = obj['client_email'];
  const privateKey = obj['private_key'];
  const missing: string[] = [];
  if (typeof clientEmail !== 'string' || clientEmail === '') missing.push('client_email');
  if (typeof privateKey !== 'string' || privateKey === '') missing.push('private_key');
  if (missing.length > 0) {
    throw new Error(
      `サービスアカウントの JSON に ${missing.join(' と ')} が無い。\n` +
        '  サービス アカウント**鍵**の JSON を使うこと。\n' +
        '  OAuth クライアントや API キーの JSON とは別物。',
    );
  }

  return { clientEmail: clientEmail as string, privateKey: privateKey as string };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * サービスアカウント用の JWT を組んで署名する。
 * `nowSec` を引数に取るのは、テストで時刻を固定するため。
 */
export function signJwt(sa: ServiceAccount, nowSec: number, scope = SCOPE): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.clientEmail,
      scope,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${base64url(signer.sign(sa.privateKey))}`;
}

export class Sheets {
  constructor(private readonly sa: ServiceAccount) {}

  async accessToken(nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(this.sa, nowSec),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      // **本文を出す。** Google は理由を本文に書いてくる
      // （invalid_grant = 鍵が無効 / 時計がずれている、など）。
      throw new Error(`Google のトークン取得が ${res.status}: ${text.slice(0, 300)}`);
    }
    const token = (JSON.parse(text) as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || token === '') {
      throw new Error('トークンの応答に access_token が無い');
    }
    return token;
  }

  /**
   * 範囲の値を取る。
   *
   * **FORMATTED_VALUE（既定）で読む。** UNFORMATTED にすると
   * `=NOW()` がシリアル値（1899-12-30 からの日数）で返り、
   * 日付の解釈を 1 段増やすことになる。表示文字列のまま受けて、
   * こちらで明示的に解釈する（commands/sheet.ts の parseSheetTimestamp）。
   */
  async values(sheetId: string, range: string): Promise<string[][]> {
    const token = await this.accessToken();
    const url = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Sheets API が ${res.status}: ${text.slice(0, 300)}${sheetHint(res.status)}`);
    }
    const values = (JSON.parse(text) as { values?: unknown }).values;
    if (!Array.isArray(values)) return [];
    return values.map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? '')) : []));
  }
}

/** 状態コードに応じて「次にどこを触るか」を足す。 */
export function sheetHint(status: number): string {
  if (status === 403) {
    return (
      '\n  → シートがサービスアカウントに共有されていない可能性が高い。' +
      '\n     シートの「共有」に、鍵の client_email を**閲覧者**として追加する。' +
      '\n     Sheets API がプロジェクトで有効になっているかも確認する。'
    );
  }
  if (status === 404) {
    return '\n  → シート ID か範囲名が違う。URL の /d/ と /edit の間がシート ID。';
  }
  return '';
}
