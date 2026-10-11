import type { Env } from './types.js';
import {
  authenticate,
  isAccessConfigured,
  isMemberSignupEnabled,
  isQuotesPublicEnabled,
  isUnprotectedProduction,
} from './auth.js';
import { resolveSite } from './site.js';
import { handleLpRequest } from './routes/lp.js';
import { handleHealth, handleRanking, handleRunPipeline, handleSymbol, json } from './routes/api.js';
import { handleDashboard, handleScreener, handleSymbolPage } from './routes/ui.js';
import { handleDesk } from './routes/desk.js';
import { runDailyPipeline } from './jobs/dailyPipeline.js';
import { scheduledTargetDate } from './jobs/date.js';
import { handleWaitlistCsv, handleWaitlistPage } from './routes/waitlistAdmin.js';
import { withSecurityHeaders } from './headers.js';

/**
 * エントリポイント。
 *
 * **まずホスト名で LP とアプリを分ける**（`site.ts`）。
 *   - LP 側は誰でも見られる。市場データを一切返さない
 *   - アプリ側は Cloudflare Access の背後。`/api/health` だけ認証を外す
 *
 * 会員機能は実装してあるが `MEMBER_SIGNUP_ENABLED` で閉じてある
 * （docs/DATA-SOURCES.md）。
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // **保安ヘッダーは出口 1 箇所で被せる。**
    // 個々のルートで付けて回ると、ルートを 1 本足したときに付け忘れる。
    return withSecurityHeaders(await route(request, env, ctx));
  },

  /**
   * 日次パイプライン。Cron から呼ばれる。
   *
   * 19:30 JST に本走、翌 07:00 JST に取りこぼしの回収。
   * その日が成功済みなら `job_runs` を見てスキップするので、
   * 2 度走っても二重に書かない。
   *
   * **狙う日付は `scheduledTargetDate` が決める。** 朝の回収は前日を見る
   * （当日はまだ場が開いていない）。ここを `marketDate` のままにすると、
   * 回収run が毎朝、存在しない日のデータを取りに行く。
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const firedAt = new Date(event.scheduledTime);
    const market = (env.MARKETS || 'JP').split(',')[0]?.trim() || 'JP';
    ctx.waitUntil(
      runDailyPipeline(env, firedAt, { date: scheduledTargetDate(firedAt, market) }).then(
        (result) => {
          console.log('daily_pipeline', JSON.stringify(result));
        },
        (err: unknown) => {
          // ここで握り潰さない。job_runs には error が記録済みで、
          // /api/health が stale を返すようになる。
          console.error('daily_pipeline failed', err);
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;

/** ルーティング本体。応答は `fetch` が保安ヘッダーで包んで返す。 */
async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const { site, path, redirectTo } = resolveSite(url, env);

  // www → apex。恒久的な移動として 301 で返す。
  if (redirectTo !== undefined) {
    return Response.redirect(redirectTo, 301);
  }

  // 想定外のホスト。**アプリを返さない**（Access を通らずに開かれるため）。
  if (site === 'unknown') {
    return json({ error: '見つからない' }, 404);
  }

  // LP 側。認証は通さず、市場データにも触れない。
  if (site === 'lp') {
    try {
      return await handleLpRequest(request, env, path);
    } catch (err) {
      console.error('lp', err);
      return json({ error: '内部エラー' }, 500);
    }
  }

  // 監視用。ここだけ認証不要。内部の数字は返さない。
  if (path === '/api/health') return handleHealth(env);

  // アプリ側は Access の後ろなのでクローラーは到達しないが、
  // 設定が外れたときに索引されないよう全面拒否を返しておく。
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return json({ error: '認証が必要', reason: auth.reason }, 401);
  }

  try {
    if (path === '/') return await handleDashboard(env);
    if (path === '/screener') return await handleScreener(env, url);

    // デスク（GOOGLEFINANCE の現在値）。
    //
    // **会員に見せる前に、利用条件の確認が要る。** Google の金融データは
    // 個人利用を前提とした記述があり、会員へ配る形が条件に合うか
    // 確認できていない（docs/DATA-SOURCES.md の 5）。J-Quants の再配信
    // （同 2）と同じ扱いで、確認が済むまでフラグで閉じておく。
    //
    // **Access の内側では開く。** 自分で見るぶんには論点が立たない。
    if (path === '/desk') {
      if (!isQuotesPublicEnabled(env) && !isAccessConfigured(env)) {
        return json(
          {
            error: '現在値の公開は停止中',
            hint: 'docs/DATA-SOURCES.md の 5。Access を設定するか、確認が済んだら QUOTES_PUBLIC_ENABLED を true にする',
          },
          503,
        );
      }
      return await handleDesk(env);
    }

    const symbolPageMatch = /^\/symbol\/(.+)$/.exec(path);
    if (symbolPageMatch?.[1] !== undefined) {
      return await handleSymbolPage(env, decodeURIComponent(symbolPageMatch[1]));
    }

    if (path === '/api/ranking') return await handleRanking(env, url);

    // 集めた先行登録。**アプリ側（Access の後ろ）にだけ置く。**
    // メールアドレスは個人情報なので、LP 側から到達させない。
    //
    // **さらに、Access が実際に掛かるまでは返さない。** ホストを分けても、
    // Access 未設定の間は authenticate() が素通しするので、
    // アプリ側のホスト名さえ知っていれば誰でも CSV を落とせてしまう。
    // 市場データと違い、メールアドレスは漏れたら取り消せない。
    if (path === '/waitlist' || path === '/api/waitlist.csv') {
      if (isUnprotectedProduction(env)) {
        return json(
          {
            error: 'Cloudflare Access が未設定のため停止中',
            hint: 'docs/GO-LIVE.md の B5・B6。設定すればこの画面は開く',
          },
          503,
        );
      }
      return path === '/waitlist'
        ? await handleWaitlistPage(env)
        : await handleWaitlistCsv(env, url);
    }

    const symbolApiMatch = /^\/api\/symbol\/(.+)$/.exec(path);
    if (symbolApiMatch?.[1] !== undefined) {
      return await handleSymbol(env, url, decodeURIComponent(symbolApiMatch[1]));
    }

    if (path === '/api/run-pipeline') {
      if (request.method !== 'POST') {
        return json({ error: 'POST で呼ぶこと' }, 405);
      }
      return await handleRunPipeline(env, url);
    }

    // 会員機能は Phase 7。**規約の確認が済むまで開けない。**
    if (path.startsWith('/member')) {
      return json(
        {
          error: isMemberSignupEnabled(env)
            ? '会員機能は Phase 7 で実装する'
            : '会員機能は現在無効。docs/DATA-SOURCES.md の再配信条件を確認するまで開けない',
        },
        isMemberSignupEnabled(env) ? 501 : 403,
      );
    }

    return json({ error: `見つからない: ${path}` }, 404);
  } catch (err) {
    // 例外の中身をそのまま返さない（内部構造やキーが漏れうる）。
    console.error('unhandled', err);
    ctx.waitUntil(Promise.resolve());
    return json({ error: '内部エラー' }, 500);
  }
}
