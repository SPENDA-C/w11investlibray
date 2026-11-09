import type { Env } from '../types.js';
import { lpPage } from '../ui/lp.js';
import { appUrl, lpBasePath, lpUrl } from '../site.js';
import { handleWaitlist } from './waitlist.js';
import { handleHealth } from './api.js';
import { escapeHtml } from '../ui/format.js';
import { LP_CSP } from '../headers.js';

/**
 * LP 側のルーティング。**認証を通さない。**
 * ここから市場データに触れる経路を作らないこと（`INVEST_DB` を読むのは
 * 先行登録の書き込みだけ）。
 */
export async function handleLpRequest(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const base = lpBasePath(env);
  const target = appUrl(env, '/');
  const canonical = lpUrl(env, '/');

  if (path === '/' || path === '') {
    return html(
      lpPage({
        siteName: env.SITE_NAME,
        shortName: env.SITE_SHORT_NAME,
        basePath: base,
        appUrl: target,
        ...(canonical.startsWith('https://') ? { canonicalUrl: canonical } : {}),
      }),
    );
  }

  // 監視用。公開ホストを監視対象にすることが多いので、こちらにも出す。
  // 中身はアプリ側と同じで、内部の数字は返さない。
  if (path === '/api/health') return handleHealth(env);

  // 検索エンジン向け。**LP だけを拾わせる。**
  // ダッシュボード側は別ホストで、そちらの robots.txt は全面拒否にしてある。
  if (path === '/robots.txt') {
    const sitemap = lpUrl(env, '/sitemap.xml');
    return text(
      `User-agent: *\nAllow: /\n${sitemap.startsWith('https://') ? `Sitemap: ${sitemap}\n` : ''}`,
    );
  }

  if (path === '/sitemap.xml') {
    const root = lpUrl(env, '/');
    if (!root.startsWith('https://')) return text('', 404);
    const urls = ['/', '/privacy'].map(
      (p) => `  <url><loc>${lpUrl(env, p)}</loc></url>`,
    );
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
      { headers: { 'content-type': 'application/xml; charset=utf-8' } },
    );
  }

  if (path === '/api/waitlist') {
    const res = await handleWaitlist(request, env);
    // ブラウザからのフォーム送信は、JSON ではなくページを返す。
    if (wantsHtml(request)) {
      const ok = res.status === 200;
      const message = ok ? null : await errorMessage(res);
      return html(
        lpPage({
          siteName: env.SITE_NAME,
          shortName: env.SITE_SHORT_NAME,
          basePath: base,
          appUrl: target,
          submitted: ok ? 'ok' : null,
          errorMessage: message,
        }),
        ok ? 200 : res.status,
      );
    }
    return res;
  }

  if (path === '/privacy') {
    // 「{ページ名} — {短縮名}」に揃える。正式名だと 35 文字になる。
    return html(privacyPage(env.SITE_SHORT_NAME, base));
  }

  return html(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>見つかりません</title></head><body>
<p>ページが見つかりません。<a href="${escapeHtml(base)}/">トップへ</a></p>
</body></html>`, 404);
}

function wantsHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('text/html');
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '送信に失敗した';
  } catch {
    return '送信に失敗した';
  }
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}

/**
 * LP 側の HTML。**CSP をここで自分で入れる。**
 *
 * `withSecurityHeaders` は既にある値を上書きしないので、ここで入れた
 * `LP_CSP` がそのまま残る（既定の `CSP` には Google Fonts の 2 ホストが
 * 入っていないので、書体が読めなくなる）。
 */
function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': status === 200 ? 'public, max-age=300' : 'no-store',
      'content-security-policy': LP_CSP,
    },
  });
}

/**
 * プライバシーポリシー。
 *
 * 事業者の名称・所在地・連絡先は記入済み。**空にしないこと。**
 * 個人情報保護法上、メールアドレスを取得する主体の名称と連絡先は
 * 本人が知り得る状態に置く必要がある（最終的な判断は事業者側で確認すること）。
 * `scripts/preflight.mjs` が未記入のままのデプロイを止めている。
 *
 * 保存期間と解除方法は「いまのコードが実際にやっていること」に合わせた文案が
 * 入っている。**運用を変えたらここも直す**——たとえば解除リンクを付けずに
 * 配信を始めるなら、下の「解除」の文面が嘘になる。
 */
function privacyPage(siteName: string, base: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>プライバシーポリシー — ${escapeHtml(siteName)}</title>
<style>
body { margin:0 auto; padding:2.5rem 1.5rem 4rem; max-width:720px; line-height:1.8;
  font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  background:#fbfaf9; color:#1a1a19; }
@media (prefers-color-scheme: dark) { body { background:#16161a; color:#eceae6; } }
h1 { font-size:1.5rem; } h2 { font-size:1.0625rem; margin-top:2rem; }
.todo { color:#c0392b; font-weight:600; }
a { color:#ff7d27; }
</style>
</head>
<body>
<h1>プライバシーポリシー</h1>

<h2>取得する情報</h2>
<p>先行登録の際に、メールアドレスと、お知らせの受信に同意いただいた日時を取得します。
それ以外の個人情報は取得しません。IP アドレスは保存していません。</p>

<h2>利用目的</h2>
<p>サービスの公開・提供状況のご連絡にのみ利用します。他の目的には利用しません。</p>

<h2>第三者提供</h2>
<p>ご本人の同意なく第三者へ提供することはありません。</p>

<h2>外部サービス</h2>
<p>本サイトは、表示に用いる書体（Noto Sans JP）を Google Fonts
（<a href="https://fonts.googleapis.com/">fonts.googleapis.com</a> および
fonts.gstatic.com）から読み込んでいます。この読み込みに伴い、
<strong>お使いの端末の IP アドレスと User-Agent が Google に送信されます。</strong>
当方はこれを取得・保存しません。取り扱いについては Google のプライバシーポリシーに従います。
アクセス解析ツールおよび広告配信タグは設置していません。</p>

<h2>保存期間</h2>
<p>サービス公開のご案内が完了するまで、または配信解除のお申し出をいただくまで保存します。
いずれかの時点で、速やかに削除します。</p>

<h2>解除</h2>
<p>配信の解除はいつでも可能です。お送りするメールに記載の解除方法によるか、
下記の連絡先までお知らせください。解除のご連絡をいただいた時点で、
登録いただいたメールアドレスを削除します。</p>

<h2>事業者</h2>
<p>株式会社SPENDA（代表取締役 伊藤潤平）<br>
東京都荒川区東日暮里 5-50-5 日暮里ラングウッド 3F<br>
お問い合わせ: <a href="mailto:contact@spenda-c.com">contact@spenda-c.com</a></p>

<p><a href="${escapeHtml(base)}/">トップへ戻る</a></p>
</body>
</html>`;
}
