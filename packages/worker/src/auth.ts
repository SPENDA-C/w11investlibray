import type { Env } from './types.js';

/**
 * 認証。
 *
 * Phase 1 は **Cloudflare Access（Zero Trust）で自分 / 社内のみ**に限定する。
 * 市場データを登録ユーザーへ提供することが契約上の第三者提供に当たるかを
 * 確認するまで、会員登録は開けない（docs/DATA-SOURCES.md）。
 *
 * Access はゾーンのルートより手前で効くので、本来ここまで未認証の
 * リクエストは来ない。それでも JWT を検証するのは、
 * Access の設定を外したときに**気付かないまま全公開にならない**ようにするため。
 */

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

interface CachedJwks {
  readonly keys: Map<string, CryptoKey>;
  readonly fetchedAt: number;
}

let jwksCache: { teamDomain: string; value: CachedJwks } | null = null;

export interface AuthResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly email?: string;
}

/** 認証が設定されているか。空なら検証しない（ローカル開発用）。 */
export function isAccessConfigured(env: Env): boolean {
  return env.CF_ACCESS_TEAM_DOMAIN.trim() !== '' && env.CF_ACCESS_AUD.trim() !== '';
}

/**
 * **本番のホスト名は入っているのに Access が未設定** = 誰でも開ける公開状態。
 *
 * `authenticate()` は未設定なら通す作りにしてある（ローカル開発のため）。
 * その結果、デプロイ後・Access 設定前の期間だけ、
 * アプリ側がまるごと素通しになる。GO-LIVE.md は Access（B5）を
 * 手動パイプライン（B4）の後に置いているので、**この期間は必ず生じる。**
 *
 * 市場データはその間 0 件なので実害が無いが、
 * **先行登録のメールアドレスは別**。漏れたら取り返しがつかないので、
 * 個人情報を返す経路だけはこの判定で止める（index.ts）。
 *
 * ローカルの `wrangler dev` は既定環境を使い、ホスト名は
 * `[env.production]` にしか無いので、ここは常に false になる。
 * 判定の条件は `site.ts` の `resolveSite`（「どちらかが設定されている = 本番」）
 * と揃えてある。**片方ずらすと、塞いだつもりの穴が開く。**
 */
export function isUnprotectedProduction(env: Env): boolean {
  const hostsConfigured =
    (env.APP_HOSTNAME || '').trim() !== '' || (env.LP_HOSTNAME || '').trim() !== '';
  return hostsConfigured && !isAccessConfigured(env);
}

export function isMemberSignupEnabled(env: Env): boolean {
  return env.MEMBER_SIGNUP_ENABLED === 'true';
}

/**
 * GOOGLEFINANCE の現在値を、認証なしで見せてよいか。
 *
 * **既定は閉じる。** Google の金融データは個人利用を前提とした記述があり、
 * 会員へ配る形が利用条件に合うか確認できていない
 * （`docs/DATA-SOURCES.md` の 5）。`MEMBER_SIGNUP_ENABLED` と同じ考え方で、
 * 確認が済むまで `"false"` のままにする。
 */
export function isQuotesPublicEnabled(env: Env): boolean {
  return env.QUOTES_PUBLIC_ENABLED === 'true';
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  if (!isAccessConfigured(env)) {
    // 未設定でも通す。ただし本番でここに落ちていることに気付けるよう、
    // 画面側に警告を出す（ui/layout.ts）。
    return { ok: true, reason: 'access_not_configured' };
  }

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ??
    cookieValue(request.headers.get('Cookie'), 'CF_Authorization');
  if (token === null) return { ok: false, reason: 'missing_token' };

  try {
    const payload = await verifyAccessJwt(token, env);
    const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
    return email === undefined ? { ok: true } : { ok: true, email };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'invalid_token' };
  }
}

async function verifyAccessJwt(token: string, env: Env): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT の形式が不正');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(decodeUtf8(base64UrlDecode(headerB64))) as Record<string, unknown>;
  const kid = header['kid'];
  if (typeof kid !== 'string') throw new Error('JWT に kid が無い');
  if (header['alg'] !== 'RS256') throw new Error(`想定外の alg: ${String(header['alg'])}`);

  const key = await getSigningKey(env.CF_ACCESS_TEAM_DOMAIN.trim(), kid);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) throw new Error('JWT の署名が一致しない');

  const payload = JSON.parse(decodeUtf8(base64UrlDecode(payloadB64))) as Record<string, unknown>;

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = payload['exp'];
  if (typeof exp === 'number' && exp < nowSec) throw new Error('JWT の有効期限切れ');
  const nbf = payload['nbf'];
  if (typeof nbf === 'number' && nbf > nowSec + 60) throw new Error('JWT がまだ有効でない');

  // aud の検証。ここを省くと、別のアプリ向けのトークンで通ってしまう。
  const aud = payload['aud'];
  const expected = env.CF_ACCESS_AUD.trim();
  const audList = Array.isArray(aud) ? aud : [aud];
  if (!audList.some((a) => a === expected)) throw new Error('JWT の aud が一致しない');

  return payload;
}

async function getSigningKey(teamDomain: string, kid: string): Promise<CryptoKey> {
  const cached = jwksCache;
  if (
    cached !== null &&
    cached.teamDomain === teamDomain &&
    Date.now() - cached.value.fetchedAt < JWKS_CACHE_TTL_MS
  ) {
    const key = cached.value.keys.get(kid);
    if (key !== undefined) return key;
  }

  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS の取得に失敗: ${res.status}`);
  const json = (await res.json()) as { keys?: JsonWebKey[] };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of json.keys ?? []) {
    const id = (jwk as { kid?: string }).kid;
    if (typeof id !== 'string') continue;
    const imported = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(id, imported);
  }
  jwksCache = { teamDomain, value: { keys, fetchedAt: Date.now() } };

  const key = keys.get(kid);
  if (key === undefined) throw new Error(`kid ${kid} に対応する鍵が無い`);
  return key;
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/** テスト用に JWKS のキャッシュを捨てる。 */
export function resetJwksCache(): void {
  jwksCache = null;
}
