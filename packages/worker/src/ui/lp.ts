import { escapeHtml } from './format.js';
import { BRAND, LP_FONT_STACK, TOKENS } from './tokens.js';

/**
 * 先行登録の LP。**市場データを一切出さない公開ページ。**
 *
 * 見た目は `spenda-agency/landing-page` の `googletool-orange-basic` を
 * 踏襲している（ダークブルーのヒーロー＋下端の波、オレンジの CTA、
 * 白いカードを影で浮かせる、`.container` は 1200px）。
 * 配色は `tokens.ts` の `BRAND` が持つ。
 *
 * **JavaScript を 1 行も使わない。**
 * 元のテンプレートはヘッダーの背景切替・モバイルメニュー・FAQ の開閉・
 * スクロールのフェード・Back to Top を JS でやっているが、
 * この Worker は CSP を `script-src 'none'` で固定している
 * （`headers.ts` / `test/headers.test.mjs`）。同じ挙動を CSS だけで組み直した。
 *
 *   ヘッダーの背景切替 → `animation-timeline: scroll()`（非対応なら常時白）
 *   FAQ の開閉         → `<details>` / `<summary>`
 *   フェードイン       → `animation-timeline: view()`（非対応なら最初から表示）
 *   Back to Top        → `#top` へのアンカー（常時表示。元も常時表示だった）
 *   モバイルメニュー   → 置いていない。狭い画面ではフッターの一覧が担う
 *
 * 表現の制約が本文の書き方を決めている。
 *   - 「儲かる」「推奨」と書かない。書けるのは「条件に合致した候補」まで
 *   - スコアは条件への合致度であって期待リターンではない、と本文で言い切る
 *   - できないこと・やらないことを隠さない。ここが差別化そのもの
 */

export interface LpOptions {
  /** 正式名。<title> と og:title に使う。 */
  readonly siteName: string;
  /** 短縮名。ヘッダーのブランド表記に使う。 */
  readonly shortName: string;
  readonly basePath: string;
  readonly appUrl: string;
  /** LP の絶対 URL。canonical と OGP に使う。ローカルでは空。 */
  readonly canonicalUrl?: string;
  /** 送信後の再表示。`ok` なら完了メッセージ、`error` なら理由を出す。 */
  readonly submitted?: 'ok' | null;
  readonly errorMessage?: string | null;
}

export function lpPage(o: LpOptions): string {
  const action = `${o.basePath}/api/waitlist`;
  const base = escapeHtml(o.basePath);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!--
  正式名だけを入れる。キャッチコピーを足すと 42 文字になり、
  検索結果（全角 30 文字前後で切られる）で後半が丸ごと消える。
  正式名自体が「インカムゲインを究める資産運用」と中身を説明している。
-->
<title>${escapeHtml(o.siteName)}</title>
<meta name="description" content="日本株 5,000 銘柄を毎営業日おなじ計算で機械的にスクリーニングし、条件に合致した候補とその根拠を 1 画面に集約する投資判断支援システム。先行登録を受け付けています。">
<meta property="og:title" content="${escapeHtml(o.siteName)}">
<meta property="og:description" content="毎日、全銘柄を同じ物差しで測る。条件に合致した候補と、その根拠まで。">
<meta property="og:type" content="website">
<meta property="og:locale" content="ja_JP">${
    o.canonicalUrl
      ? `
<link rel="canonical" href="${escapeHtml(o.canonicalUrl)}">
<meta property="og:url" content="${escapeHtml(o.canonicalUrl)}">`
      : ''
  }
<!--
  書体は Noto Sans JP（デザイン指定）。**外部への通信はこの 2 つだけ。**
  読み込めなくても FONT_STACK の和文にそのまま落ちる（display=swap）。
  訪問者の IP が Google に渡るので、/privacy の「外部サービス」に書いてある。
  CSP の style-src / font-src もこの 2 つのために開けてある（headers.ts）。
-->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&amp;display=swap">
<style>${TOKENS}${BRAND}${STYLES}</style>
</head>
<body id="top">

<header class="site-head">
  <div class="container head-inner">
    <a class="logo" href="${base}/"><span class="brand">${escapeHtml(o.shortName)}</span></a>
    <nav class="nav">
      <ul class="nav-list">
        <li><a class="nav-link" href="#problem">課題</a></li>
        <li><a class="nav-link" href="#about">できること</a></li>
        <li><a class="nav-link" href="#nots">他社との違い</a></li>
        <li><a class="nav-link" href="#status">公開の段階</a></li>
        <li><a class="nav-link" href="#faq">よくある質問</a></li>
      </ul>
    </nav>
    <div class="head-cta">
      <a class="btn btn-primary btn-sm" href="#contact">先行登録</a>
    </div>
  </div>
</header>

<main>

<section class="hero">
  <div class="container">
    <div class="hero-text reveal">
      <span class="hero-badge">日本株・毎営業日・全銘柄</span>
      <h1 class="hero-title">毎日、全銘柄を<br>同じ物差しで測る。</h1>
      <p class="hero-sub">「値上がりしそう」ではなく「条件に合致した」を出します。なぜ今この銘柄なのかを、指標の内訳まで開いて示します。</p>
      <ul class="hero-cards">
        <li class="hero-card">
          <span class="hero-card-label">対象</span>
          <span class="hero-card-main">5,000銘柄</span>
          <span class="hero-card-sub">日本株を毎営業日ぜんぶ</span>
        </li>
        <li class="hero-card">
          <span class="hero-card-label">判定</span>
          <span class="hero-card-main">8つの条件</span>
          <span class="hero-card-sub">移動平均／MACD／RSI／出来高</span>
        </li>
        <li class="hero-card">
          <span class="hero-card-label">表示</span>
          <span class="hero-card-main">根拠まで</span>
          <span class="hero-card-sub">スコアの内訳と損切り・利確の水準</span>
        </li>
      </ul>
    </div>
  </div>
  <div class="hero-wave" aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 320" preserveAspectRatio="none">
      <path fill="#ffffff" d="M0,192L48,213.3C96,235,192,277,288,282.7C384,288,480,256,576,224C672,192,768,160,864,160C960,160,1056,192,1152,197.3C1248,203,1344,181,1392,170.7L1440,160L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z"></path>
    </svg>
  </div>
</section>

<section class="cta-band" id="signup">
  <div class="container">
    <div class="cta-band-inner reveal">
      <h2 class="cta-band-title">公開の準備ができたら、お知らせします</h2>
      <p class="cta-band-note">メールアドレスだけで登録できます。費用はかかりません。</p>
      ${formBlock(action, o, 'top')}
    </div>
  </div>
</section>

<section class="band" id="problem">
  <div class="container">
    <div class="section-head reveal">
      <span class="section-label">PROBLEM</span>
      <h2 class="section-title">こんなところで、<span class="accent">止まっていませんか？</span></h2>
      <p class="section-sub"><span class="highlight">日本株を自分で選んでいる個人投資家</span>の方へ。銘柄選びの「毎回ゼロからやり直している感じ」について。</p>
    </div>
    <ul class="cards-3">
      ${problem(iconSearch, '銘柄が多すぎて、<b>どこから見ればいいか</b>分からない')}
      ${problem(iconShuffle, 'スクリーナーの条件を少し変えるたびに、<b>結果が総入れ替え</b>になる')}
      ${problem(iconCross, 'ゴールデンクロスで拾っても、<b>だましが多い</b>')}
      ${problem(iconWhy, 'なぜその銘柄が出てきたのか、<b>あとから説明できない</b>')}
      ${problem(iconRuler, '損切りと利確の水準を、<b>毎回その場の気分で</b>決めている')}
      ${problem(iconHistory, 'そのやり方が<b>過去に通用したのか</b>を確かめる手段がない')}
    </ul>
  </div>
</section>

<section class="band ground">
  <div class="container">
    <div class="section-head reveal">
      <span class="section-label">INSIGHT</span>
      <h2 class="section-title">スクリーナーを使っても<span class="accent">解決しない 3 つの理由</span></h2>
    </div>
    <ul class="reasons">
      <li class="reason reveal">
        <span class="reason-n">01</span>
        <h3 class="reason-title">条件が 1 本しかないから</h3>
        <p>5 日線が 25 日線を上抜けただけなら、下降トレンドの途中の一時的な戻りも同じ顔で出てきます。<b>上抜けたという事実は、それ単体では何も選別していません。</b></p>
      </li>
      <li class="reason reveal">
        <span class="reason-n">02</span>
        <h3 class="reason-title">数字の出どころが見えないから</h3>
        <p>「スコア 82」とだけ出ても、何がどう効いて 82 なのかが分からなければ、外れたときに直しようがありません。<b>直せない仕組みは、使い続けるほど当てずっぽうに近づきます。</b></p>
      </li>
      <li class="reason reveal">
        <span class="reason-n">03</span>
        <h3 class="reason-title">検証が未来を覗いているから</h3>
        <p>決算の数字を発表日より前に使う。上場廃止した銘柄を除いて集計する。<b>この 2 つだけで、過去の成績は簡単に良く見えます。</b>そして本番では再現しません。</p>
      </li>
    </ul>
    <div class="reason-conclusion reveal">
      <p>だからこそ——<br><b class="accent">「同じ計算を毎日回し、条件の内訳ごと出し、その時点で入手できた情報だけで検証する」</b><br>という当たり前を、仕組みとして固定しました。</p>
    </div>
  </div>
</section>

<section class="band" id="about">
  <div class="container">
    <div class="about-box reveal">
      <span class="section-label">ABOUT</span>
      <h2 class="section-title">${escapeHtml(o.shortName)} とは</h2>
      <p class="about-lede">日本株 5,000 銘柄について、RSI・MACD・移動平均・ATR・出来高を<b>毎営業日おなじ手順で計算</b>し、あらかじめ決めた条件に合致した銘柄だけを、その<b>根拠の内訳ごと</b>並べる投資判断支援システムです。値上がりを予測する道具ではありません。</p>
      <ul class="checks">
        <li>指標の計算は機械的。同じ入力からは必ず同じ結果が出る</li>
        <li>8 つの条件のうちいくつ揃ったかで判定。上抜けただけでは候補にしない</li>
        <li>スコアの内訳・合致した条件・損切りと利確の水準まで表示する</li>
        <li>ルールの検証には、その時点で入手できた情報だけを使う</li>
      </ul>
    </div>
  </div>
</section>

<section class="band ground" id="features">
  <div class="container">
    <div class="section-head reveal">
      <span class="section-label">FEATURES</span>
      <h2 class="section-title">やって<span class="accent">いること</span></h2>
      <p class="section-sub">毎営業日の夕方、この 3 つが順番に走ります。</p>
    </div>
    <ul class="cards-3 features">
      <li class="feature reveal">
        <span class="feature-icon blue">${iconCalc}</span>
        <h3 class="feature-title">毎日、機械的に計算する</h3>
        <p>RSI・MACD・移動平均・ATR・出来高を、全銘柄について毎営業日そのまま計算します。<b>ここに AI は使いません。</b>同じ入力からは必ず同じ結果が出ます。</p>
      </li>
      <li class="feature reveal">
        <span class="feature-icon green">${iconLayers}</span>
        <h3 class="feature-title">条件を重ねて絞る</h3>
        <p>25 日線の向き、株価と 75 日線の位置、MACD、RSI の水準、出来高——<b>8 つの条件のうちいくつ揃ったか</b>で判定します。上抜けただけの銘柄は落ちます。</p>
      </li>
      <li class="feature reveal">
        <span class="feature-icon orange">${iconOpen}</span>
        <h3 class="feature-title">根拠ごと出す</h3>
        <p>スコアの内訳、合致した条件、ATR から機械的に決めた損切り・利確の水準まで表示します。<b>数字の出どころを最後まで追えます。</b></p>
      </li>
    </ul>
  </div>
</section>

<section class="band" id="nots">
  <div class="container">
    <div class="section-head reveal">
      <span class="section-label">POLICY</span>
      <h2 class="section-title">よくある株式スクリーナーとの<span class="accent">違い</span></h2>
    </div>
    <ul class="nots">
      <li class="not reveal">
        <h3>AI に株価を予測させない</h3>
        <p>AI の役割はニュースの分類・要約・説明に限ります。値動きの予測はさせません。当たったかどうかを検証できない出力を、判断材料として出さないためです。</p>
      </li>
      <li class="not reveal">
        <h3>スコアを「期待リターン」と呼ばない</h3>
        <p>スコアは条件への合致度です。何パーセント上がるかを表す数字ではありません。100 点の銘柄が下がることも、40 点の銘柄が上がることもあります。</p>
      </li>
      <li class="not reveal">
        <h3>検証していないルールを推奨しない</h3>
        <p>過去データで検証していないルールを「おすすめ」として画面に出しません。検証では、その時点で入手できた情報だけを使います（決算は発表日以降、ニュースは公開日以降）。</p>
      </li>
      <li class="not reveal">
        <h3>上場廃止した銘柄を消さない</h3>
        <p>生き残った銘柄だけで検証すると、成績が実態より良く出ます。廃止された銘柄も残したまま検証します。都合の悪い履歴を消さない、という約束です。</p>
      </li>
    </ul>
  </div>
</section>

<section class="band ground" id="status">
  <div class="container">
    <div class="section-head reveal">
      <span class="section-label">STATUS</span>
      <h2 class="section-title">公開の<span class="accent">段階</span></h2>
      <p class="section-sub">できていないことを、できているように書きません。いまはここまでです。</p>
    </div>
    <div class="status-cards">
      <div class="status-card status-card-main reveal">
        <span class="status-badge">いま動いている</span>
        <h3>Phase 1<small>日本株・テクニカル</small></h3>
        <ul class="status-list">
          <li>日本株の日足の取り込みと株式分割の調整</li>
          <li>RSI・MACD・移動平均・ATR・出来高の計算</li>
          <li>8 条件のゴールデンクロス判定</li>
          <li>0〜100 のスコアリングと候補の並べ替え</li>
          <li>銘柄ごとの内訳画面と損切り・利確の水準</li>
        </ul>
      </div>
      <div class="status-card reveal">
        <h3>これから<small>順次ご案内します</small></h3>
        <ul class="status-list muted-list">
          <li>ニュースの分類・要約（Phase 1b）</li>
          <li>日本株の全銘柄へ拡大（Phase 2）</li>
          <li>米国株（Phase 3）／為替（Phase 4）</li>
          <li>バックテストの結果公開（Phase 5）</li>
          <li>条件を自分で組むしくみ（Phase 7）</li>
        </ul>
        <p class="status-note">公開できる範囲は、市場データの提供元との取り決めを確認しながら決めています。確認が済んだものから順にご案内します。</p>
      </div>
    </div>
  </div>
</section>

<section class="band" id="flow">
  <div class="container">
    <div class="section-head reveal">
      <span class="section-label">FLOW</span>
      <h2 class="section-title">登録から利用<span class="accent">までの流れ</span></h2>
    </div>
    <ol class="flow">
      ${flowStep('1', '先行登録', 'このページのフォームから、メールアドレスを登録します。費用はかかりません。')}
      ${flowStep('2', '公開のご案内', '準備が整い次第、登録いただいたアドレスにご連絡します。')}
      ${flowStep('3', 'ログイン', 'ご案内したダッシュボードにログインします。')}
      ${flowStep('4', '毎営業日の候補を見る', '夕方に当日の計算が終わり、条件に合致した銘柄が並びます。')}
      ${flowStep('5', '根拠を開く', 'スコアの内訳、合致した条件、損切りと利確の水準を確認します。')}
      ${flowStep('6', '判断はご自身で', '出るのは候補と根拠までです。売買の判断はご自身で行っていただきます。')}
    </ol>
  </div>
</section>

<section class="band ground" id="message">
  <div class="container">
    <div class="section-head reveal">
      <span class="section-label">MESSAGE</span>
      <h2 class="section-title">つくって<span class="accent">いる理由</span></h2>
    </div>
    <div class="message-box reveal">
      <p>株の情報は足りていないのではなく、多すぎます。指標も、記事も、通知も、いくらでも出てきます。それでも「なぜ今この銘柄なのか」を自分の言葉で言えないまま買ってしまうことがあります。</p>
      <p>足りないのは情報ではなく、<b>毎回おなじ物差しで測ること</b>と、<b>その物差しを後から点検できること</b>だと考えました。だから指標の計算には AI を使わず、コードを 1 本だけ持つようにしました。画面に出る数字と、過去を検証するときに使う数字が、同じ計算から出ます。</p>
      <p>当たる仕組みではありません。<b>外れたときに、どこが外れたのかを追える仕組み</b>です。地味ですが、続けられるのはそちらだと思っています。</p>
    </div>
  </div>
</section>

<section class="band" id="faq">
  <div class="container">
    <div class="section-head reveal">
      <span class="section-label">FAQ</span>
      <h2 class="section-title">よくある<span class="accent">質問</span></h2>
    </div>
    <div class="faq-list">
      ${faq('いつ公開されますか？', '公開時期はまだお約束できません。市場データの提供元との取り決めの確認が残っているためです。先行登録いただいた方に、準備が整い次第ご連絡します。')}
      ${faq('料金はかかりますか？', '先行登録は無料です。公開後の料金は未定で、決まり次第ご案内します。登録した時点で費用が発生することはありません。')}
      ${faq('AI が銘柄を選ぶのですか？', 'いいえ。銘柄の選別は指標の機械的な計算だけで行います。AI の役割はニュースの分類・要約・説明に限っていて、値動きの予測はさせません。')}
      ${faq('スコアが高いほど上がりやすいということですか？', 'いいえ。スコアは<b>条件への合致度</b>であって、期待リターンではありません。高いスコアの銘柄が下がることも、低いスコアの銘柄が上がることもあります。')}
      ${faq('どの指標を使っていますか？', 'RSI・MACD・移動平均（5／25／75 日）・ATR・出来高です。ゴールデンクロスの判定には、これらを組み合わせた 8 つの条件を使います。')}
      ${faq('対象はどの市場ですか？', '第 1 段階は日本株です。米国株と為替は、その後の段階で追加する予定です。')}
      ${faq('自分で条件を組めますか？', '公開時点ではできません。条件を自分で組むしくみは後の段階で予定しています。まずは検証済みの条件だけを提供します。')}
      ${faq('登録したメールアドレスはどう扱われますか？', '公開・提供状況のご連絡にのみ使います。第三者へ提供することはありません。IP アドレスは保存していません。詳しくは<a href="' + base + '/privacy">プライバシーポリシー</a>をご覧ください。')}
      ${faq('配信を止めたいときは？', 'いつでも解除できます。お送りするメールに解除の方法を記載します。')}
    </div>
  </div>
</section>

<section class="final-cta" id="contact">
  <div class="container">
    <div class="final-cta-box reveal">
      <span class="section-label light">CONTACT</span>
      <h2 class="section-title">まずは<span class="accent">先行登録</span>から</h2>
      <p class="final-cta-note">公開の準備ができたらお知らせします。メールアドレスだけで登録できます。</p>
      ${formBlock(action, o, 'foot')}
    </div>
  </div>
</section>

</main>

<footer class="site-foot">
  <div class="container">
    <div class="foot-top">
      <div class="foot-info">
        <div class="foot-logo">${escapeHtml(o.shortName)}</div>
        <p class="foot-desc">${escapeHtml(o.siteName)}</p>
      </div>
      <div class="foot-links">
        <div class="foot-col">
          <h3 class="foot-col-title">サービス</h3>
          <ul>
            <li><a href="#about">できること</a></li>
            <li><a href="#features">やっていること</a></li>
            <li><a href="#nots">他社との違い</a></li>
            <li><a href="#status">公開の段階</a></li>
          </ul>
        </div>
        <div class="foot-col">
          <h3 class="foot-col-title">このサイトについて</h3>
          <ul>
            <li><a href="${base}/privacy">プライバシーポリシー</a></li>
            <li><a href="#faq">よくある質問</a></li>
            <li><a href="#flow">ご利用の流れ</a></li>
          </ul>
        </div>
        <div class="foot-col">
          <h3 class="foot-col-title">お問い合わせ</h3>
          <ul>
            <li><a href="#contact">先行登録</a></li>
            <li><a href="${escapeHtml(o.appUrl)}">ログイン</a></li>
          </ul>
        </div>
      </div>
    </div>
    <p class="disclaimer">本サービスは情報提供および投資判断の支援を目的としたものであり、特定の銘柄の売買を勧誘するものではありません。表示されるスコアおよびシグナルは、過去データに基づく機械的な計算結果であり、将来の価格や収益を保証するものではありません。<b>投資判断はご自身の責任で行ってください。</b></p>
    <div class="foot-bottom">
      <p class="copyright">運営: 株式会社SPENDA ／ お問い合わせ: <a href="mailto:contact@spenda-c.com">contact@spenda-c.com</a></p>
    </div>
  </div>
</footer>

<a class="back-to-top" href="#top" aria-label="ページの先頭へ戻る">${iconUp}</a>

</body>
</html>`;
}

/** 悩みカード 1 枚。アイコンは Font Awesome ではなくインライン SVG（外部依存を増やさない）。 */
function problem(icon: string, html: string): string {
  return `<li class="problem reveal"><span class="problem-icon">${icon}</span><p>${html}</p></li>`;
}

/** 流れの 1 ステップ。 */
function flowStep(n: string, title: string, body: string): string {
  return `<li class="flow-item reveal">
        <span class="flow-n">${n}</span>
        <div class="flow-body"><h3 class="flow-title">${title}</h3><p>${body}</p></div>
      </li>`;
}

/**
 * FAQ の 1 問。
 *
 * **`<details>` で組む。** 元のテンプレートは JS でクラスを付け外ししているが、
 * この挙動はブラウザが持っている。CSP を `script-src 'none'` のまま保てる。
 */
function faq(q: string, a: string): string {
  return `<details class="faq-item reveal">
        <summary class="faq-q"><span>${q}</span></summary>
        <div class="faq-a"><p>${a}</p></div>
      </details>`;
}

/**
 * 登録フォーム。ページ内に 2 か所置くので、id が衝突しないよう接尾辞を取る。
 *
 * `company` は人には見えないハニーポット。自動投稿だけが埋める。
 */
function formBlock(action: string, o: LpOptions, suffix: string): string {
  if (o.submitted === 'ok') {
    return `<div class="done" role="status">
      <strong>登録を受け付けました。</strong>
      公開の準備ができましたらご連絡します。
    </div>`;
  }
  const emailId = `email-${suffix}`;
  const consentId = `consent-${suffix}`;
  return `<form class="signup-form" method="post" action="${escapeHtml(action)}">
  ${o.errorMessage ? `<p class="error" role="alert">${escapeHtml(o.errorMessage)}</p>` : ''}
  <input type="hidden" name="source" value="lp">
  <div class="hp" aria-hidden="true">
    <label for="company-${suffix}">会社名（入力しないでください）</label>
    <input id="company-${suffix}" type="text" name="company" tabindex="-1" autocomplete="off">
  </div>
  <div class="row">
    <label class="sr-only" for="${emailId}">メールアドレス</label>
    <input id="${emailId}" type="email" name="email" required autocomplete="email"
           placeholder="you@example.com" maxlength="254">
    <button class="btn btn-primary" type="submit">先行登録する</button>
  </div>
  <label class="consent" for="${consentId}">
    <input id="${consentId}" type="checkbox" name="consent" required>
    <span>公開のお知らせをメールで受け取ることに同意します。いつでも解除できます。</span>
  </label>
</form>`;
}

// ---- アイコン ---------------------------------------------------------------
// Font Awesome を読み込むと CSS とフォントで 100KB 超える。
// 使うのは 10 個だけなのでインライン SVG にしてある（外部通信も増えない）。

const svg = (d: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const iconSearch = svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>');
const iconShuffle = svg('<path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>');
const iconCross = svg('<path d="M3 17l6-7 4 4 8-9"/><path d="M3 8l6 7 4-4 8 9"/>');
const iconWhy = svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 113.5 2.3c-.7.4-1 .9-1 1.7"/><path d="M12 17h.01"/>');
const iconRuler = svg('<rect x="2" y="8" width="20" height="8" rx="1.5"/><path d="M7 8v3M12 8v4M17 8v3"/>');
const iconHistory = svg('<path d="M3.5 12a8.5 8.5 0 108.5-8.5A8.5 8.5 0 005.5 6"/><path d="M3 3v4h4"/><path d="M12 7.5V12l3 2"/>');
const iconCalc = svg('<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M8 6.5h8"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5h.01M8.5 18h.01M12 18h.01M15.5 18h.01"/>');
const iconLayers = svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>');
const iconOpen = svg('<path d="M3 5.5h7a3 3 0 013 3V20a2.5 2.5 0 00-2.5-2.5H3z"/><path d="M21 5.5h-7a3 3 0 00-3 3V20a2.5 2.5 0 012.5-2.5H21z"/>');
const iconUp = svg('<path d="M12 19V6"/><path d="M6 12l6-6 6 6"/>');

/**
 * LP の見た目。**`googletool-orange-basic` の骨格をそのまま写している。**
 * 数値（1200px / 12px 28px / 28px / 36px / 6px / 8px / 60px …）は
 * 元の style.css の値。パレットは tokens.ts の BRAND。
 */
const STYLES = `
:root { --maxw: 1200px; }

html { scroll-behavior: smooth; scroll-padding-top: 88px; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }

body {
  margin: 0;
  background: var(--brand-surface);
  color: var(--brand-text);
  font-family: ${LP_FONT_STACK};
  font-size: 16px; line-height: 1.6; text-wrap: pretty;
  overflow-x: hidden;
}
h1, h2, h3 { font-weight: 700; line-height: 1.4; margin: 0 0 1rem; }
p { margin: 0 0 1.5rem; }
ul, ol { list-style: none; margin: 0; padding: 0; }
a { color: var(--brand-accent); text-decoration: none; transition: color .3s ease; }
a:hover { color: var(--brand-accent-deep); }
b { font-weight: 700; }
svg { width: 1em; height: 1em; display: block; }

.container { width: 100%; max-width: var(--maxw); margin: 0 auto; padding: 0 20px; }
.accent { color: var(--brand-accent); }
.highlight { color: #c0392b; font-weight: 700; }

/* ---- ボタン ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 12px 28px; font: inherit; font-size: 16px; font-weight: 700;
  border: none; border-radius: 6px; cursor: pointer; text-align: center;
  transition: background-color .3s ease, box-shadow .3s ease, transform .3s ease;
}
.btn-primary {
  background: var(--brand-accent); color: #fff;
  box-shadow: 0 4px 10px rgba(255, 125, 39, .25);
}
.btn-primary:hover {
  background: var(--brand-accent-deep); color: #fff;
  transform: translateY(-2px); box-shadow: 0 6px 12px rgba(255, 125, 39, .3);
}
.btn-sm { padding: 10px 22px; font-size: 14px; }

/* ---- ヘッダー ----
   元のテンプレートは JS でスクロール量を見て .scrolled を付け外ししている。
   ここは CSS のスクロール駆動アニメーションで同じことをする。
   **非対応のブラウザは常時「白いヘッダー」になる**（下の素の宣言）。
   透けないだけで、読めなくなる壊れ方はしない。 */
.site-head {
  position: fixed; top: 0; left: 0; width: 100%; z-index: 1000;
  background-color: var(--brand-surface);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .1);
}
.head-inner { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 20px; }
.logo { display: block; }
.brand { font-size: 22px; font-weight: 700; letter-spacing: .01em; color: var(--brand-primary); }
.nav-list { display: flex; gap: 26px; }
.nav-link { position: relative; font-size: 14px; font-weight: 500; color: var(--brand-primary); }
.nav-link::after {
  content: ""; position: absolute; left: 0; bottom: -5px;
  width: 0; height: 2px; background: var(--brand-accent); transition: width .3s ease;
}
.nav-link:hover::after { width: 100%; }

@supports (animation-timeline: scroll()) {
  @media (prefers-reduced-motion: no-preference) and (min-width: 768px) {
    .site-head, .brand, .nav-link {
      animation-timing-function: linear;
      animation-fill-mode: both;
      animation-timeline: scroll();
      animation-range: 0 120px;
    }
    /* **地と文字で keyframes を分ける。** 1 本にまとめて .brand にも掛けると、
       文字の後ろに白い箱が出る（実際にそうなった）。 */
    .site-head { animation-name: head-solid; }
    .brand, .nav-link { animation-name: head-ink; }
    @keyframes head-solid {
      from { background-color: transparent; box-shadow: 0 2px 10px rgba(0, 0, 0, 0); }
      to   { background-color: var(--brand-surface); box-shadow: 0 2px 10px rgba(0, 0, 0, .1); }
    }
    @keyframes head-ink {
      from { color: #fff; }
      to   { color: var(--brand-primary); }
    }
  }
}

/* ---- 節の共通 ---- */
.band { padding: 60px 0; }
.ground { background: var(--brand-ground); }
.section-head { text-align: center; margin-bottom: 30px; }
.section-label {
  display: block; font-size: 11px; font-weight: 700; letter-spacing: 2.5px;
  color: var(--brand-accent); text-transform: uppercase; margin-bottom: 10px;
}
.section-label.light { color: rgba(255, 255, 255, .55); }
.section-title { font-size: 28px; font-weight: 700; margin: 0 0 10px; }
.section-sub { font-size: 16px; color: #555; max-width: 800px; margin: 0 auto; }

/* ---- ヒーロー ---- */
.hero {
  position: relative; overflow: hidden;
  padding: 130px 0 90px;
  background: linear-gradient(120deg, var(--brand-primary) 0%, var(--brand-dark) 100%);
  color: #fff;
}
.hero-text { max-width: 900px; margin: 0 auto; text-align: center; }
.hero-badge {
  display: inline-block; margin-bottom: 18px;
  padding: 6px 16px; border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, .35);
  font-size: 12px; font-weight: 700; letter-spacing: .12em;
}
.hero-title { font-size: 36px; line-height: 1.4; margin: 0; }
.hero-sub { font-size: 17px; opacity: .9; margin: 15px 0 30px; }
.hero-cards {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 20px;
  margin: 20px 0 0;
}
.hero-card {
  flex: 0 1 240px; min-width: 200px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 20px 14px; border-radius: 18px;
  background: #fff; color: var(--brand-primary);
  box-shadow: 0 4px 24px rgba(34, 49, 108, .15);
}
.hero-card-label { font-size: .95rem; font-weight: 700; margin-bottom: 8px; }
.hero-card-main { color: var(--brand-accent); font-size: 1.6rem; font-weight: 700; line-height: 1.2; }
.hero-card-sub { font-size: .85rem; font-weight: 500; margin-top: 6px; }
.hero-wave { position: absolute; left: 0; bottom: -1px; width: 100%; line-height: 0; }
.hero-wave svg { width: 100%; height: 90px; }

/* ---- 登録の帯（ヒーロー直下） ---- */
.cta-band { padding: 50px 0 60px; background: var(--brand-surface); }
.cta-band-inner {
  max-width: 720px; margin: 0 auto; text-align: center;
  padding: 32px 28px; border-radius: 16px;
  background: var(--brand-surface); box-shadow: var(--brand-shadow-3);
  border-top: 4px solid var(--brand-accent);
}
.cta-band-title { font-size: 21px; margin: 0 0 8px; color: var(--brand-primary); }
.cta-band-note { font-size: 14px; color: var(--brand-text-light); margin: 0 0 20px; }

/* ---- 悩みカード ---- */
.cards-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; max-width: 1100px; margin: 30px auto 0; }
.problem {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 24px 20px; border-radius: 12px;
  background: var(--brand-surface); box-shadow: var(--brand-shadow-2);
  border-top: 4px solid var(--brand-accent);
  transition: transform .3s ease, box-shadow .3s ease;
}
.problem:hover { transform: translateY(-5px); box-shadow: 0 8px 24px rgba(34, 49, 108, .12); }
.problem-icon { font-size: 2.2rem; color: var(--brand-accent); margin-bottom: 15px; }
.problem p { margin: 0; font-size: 15px; line-height: 1.7; }

/* ---- 原因 ---- */
.reasons { display: grid; grid-template-columns: repeat(3, 1fr); gap: 25px; max-width: 1100px; margin: 30px auto 0; }
.reason { padding: 30px 24px; border-radius: 16px; background: var(--brand-surface); box-shadow: 0 6px 20px rgba(34, 49, 108, .08); }
.reason-n { display: block; font-size: 2.4rem; font-weight: 900; color: var(--brand-accent); line-height: 1; margin-bottom: 15px; }
.reason-title { font-size: 18px; color: var(--brand-primary); margin: 0 0 12px; }
.reason p { font-size: 14px; line-height: 1.8; margin: 0; color: #444; }
.reason-conclusion {
  max-width: 900px; margin: 35px auto 0; padding: 25px 30px; text-align: center;
  background: var(--brand-surface); border-radius: 12px; border-left: 5px solid var(--brand-accent);
  box-shadow: var(--brand-shadow-1);
}
.reason-conclusion p { font-size: 17px; line-height: 1.9; margin: 0; }

/* ---- サービス説明 ---- */
.about-box {
  max-width: 900px; margin: 0 auto; padding: 40px; border-radius: 16px;
  background: var(--brand-surface); box-shadow: var(--brand-shadow-2);
}
.about-box .section-title { text-align: left; }
.about-lede { font-size: 16px; line-height: 1.9; }
.checks { display: grid; gap: 12px; }
.checks li { position: relative; padding-left: 28px; font-size: 15px; line-height: 1.7; }
.checks li::before {
  content: "✓"; position: absolute; left: 0; top: 0;
  color: var(--brand-accent); font-weight: 700;
}

/* ---- 特徴 ---- */
.features { gap: 25px; }
.feature { padding: 30px; border-radius: 16px; background: var(--brand-surface); box-shadow: var(--brand-shadow-3); transition: transform .3s ease, box-shadow .3s ease; }
.feature:hover { transform: translateY(-10px); box-shadow: 0 15px 35px rgba(0, 0, 0, .1); }
.feature-icon {
  display: flex; align-items: center; justify-content: center;
  width: 70px; height: 70px; border-radius: 20px; margin-bottom: 18px;
  font-size: 30px; color: #fff;
}
.feature-icon.blue { background: var(--brand-blue); }
.feature-icon.green { background: var(--brand-green); }
.feature-icon.orange { background: var(--brand-accent); }
.feature-title { font-size: 19px; color: var(--brand-primary); margin: 0 0 12px; }
.feature p { font-size: 14px; line-height: 1.8; margin: 0; }

/* ---- やらないこと ---- */
.nots { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; max-width: 1000px; margin: 30px auto 0; }
.not { padding: 26px 28px; border-radius: 12px; background: var(--brand-surface); box-shadow: var(--brand-shadow-2); border-left: 5px solid var(--brand-primary); }
.not h3 { font-size: 17px; color: var(--brand-primary); margin: 0 0 10px; }
.not p { font-size: 14px; line-height: 1.8; margin: 0; }

/* ---- 公開の段階 ---- */
.status-cards { display: flex; flex-wrap: wrap; justify-content: center; align-items: stretch; gap: 30px; max-width: 1000px; margin: 30px auto 0; }
.status-card {
  position: relative; flex: 1 1 380px; max-width: 480px;
  display: flex; flex-direction: column;
  padding: 40px 30px; border-radius: 12px;
  background: var(--brand-surface); box-shadow: 0 4px 16px rgba(0, 0, 0, .08);
}
.status-card-main { border: 3px solid var(--brand-accent); }
.status-badge {
  position: absolute; top: -14px; left: 50%; transform: translateX(-50%);
  padding: 6px 18px; border-radius: 20px; white-space: nowrap;
  background: var(--brand-accent); color: #fff; font-size: 13px; font-weight: 700;
  box-shadow: 0 2px 8px rgba(255, 125, 39, .3);
}
.status-card h3 { font-size: 24px; color: var(--brand-primary); margin: 0 0 18px; text-align: center; }
.status-card h3 small { display: block; margin-top: 6px; font-size: 14px; font-weight: 500; color: var(--brand-text-light); }
.status-list { display: grid; gap: 12px; align-content: start; flex-grow: 1; }
.status-list li { position: relative; padding-left: 25px; font-size: 15px; line-height: 1.7; }
.status-list li::before { content: "✓"; position: absolute; left: 0; color: var(--brand-accent); font-weight: 700; }
.muted-list li { color: #666; }
.muted-list li::before { content: "–"; color: var(--brand-text-light); }
.status-note { margin: 20px 0 0; padding: 14px 16px; border-radius: 8px; background: #fff5ec; font-size: 13px; line-height: 1.8; color: #8a5a2b; }

/* ---- 流れ ---- */
.flow { position: relative; max-width: 800px; margin: 30px auto 0; }
.flow::before { content: ""; position: absolute; top: 0; left: 19px; width: 2px; height: 100%; background: var(--brand-blue); opacity: .3; }
.flow-item { position: relative; display: flex; gap: 25px; padding-bottom: 35px; }
.flow-item:last-child { padding-bottom: 0; }
.flow-n {
  position: relative; z-index: 2; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border-radius: 50%;
  background: var(--brand-blue); color: #fff; font-size: 16px; font-weight: 700;
}
.flow-title { font-size: 18px; color: var(--brand-primary); margin: 6px 0 8px; }
.flow-item p { font-size: 14px; line-height: 1.8; margin: 0; }

/* ---- メッセージ ---- */
.message-box {
  max-width: 800px; margin: 30px auto 0; padding: 40px 46px;
  border-radius: 16px; background: var(--brand-surface);
  box-shadow: 0 4px 20px rgba(34, 49, 108, .08); line-height: 2;
}
.message-box p:last-child { margin-bottom: 0; }

/* ---- FAQ ----
   JS のアコーディオンではなく <details>。開閉はブラウザが持っている。 */
.faq-list { max-width: 900px; margin: 30px auto 0; }
.faq-item { margin-bottom: 15px; border-radius: 8px; overflow: hidden; background: var(--brand-surface); box-shadow: var(--brand-shadow-1); }
.faq-q {
  display: flex; align-items: center; justify-content: space-between; gap: 15px;
  padding: 18px 22px; cursor: pointer; list-style: none;
  font-size: 16px; font-weight: 600; line-height: 1.5; color: #333;
}
.faq-q::-webkit-details-marker { display: none; }
.faq-q::after {
  content: "+"; flex: none; min-width: 24px; text-align: center;
  font-size: 24px; font-weight: 700; color: var(--brand-accent);
}
.faq-item[open] .faq-q::after { content: "−"; }
.faq-q:hover { color: var(--brand-accent); }
.faq-q:focus-visible { outline: 2px solid var(--brand-accent); outline-offset: -2px; }
.faq-a { padding: 18px 22px; background: #fff8f2; border-top: 1px solid #e1e5eb; }
.faq-a p { margin: 0; font-size: 14px; line-height: 1.8; color: #444; }

/* ---- 最終 CTA ---- */
.final-cta { padding: 60px 0; background: linear-gradient(135deg, var(--brand-primary), var(--brand-dark)); color: #fff; }
.final-cta-box { max-width: 720px; margin: 0 auto; text-align: center; }
.final-cta .section-title { color: #fff; }
.final-cta-note { font-size: 16px; opacity: .9; margin: 0 0 26px; }
.final-cta .consent { color: rgba(255, 255, 255, .8); }
.final-cta input[type="email"] { border-color: transparent; }
.final-cta .done { background: rgba(255, 255, 255, .12); border-color: rgba(255, 255, 255, .5); }

/* ---- フォーム ---- */
.signup-form { display: grid; gap: 14px; text-align: left; }
.row { display: flex; gap: 10px; flex-wrap: wrap; }
input[type="email"] {
  flex: 1 1 16rem; min-width: 0; min-height: 50px;
  font: inherit; font-size: 16px; padding: 12px 14px;
  border: 1px solid #d8dce3; border-radius: 6px;
  background: #fff; color: var(--brand-text);
}
input[type="email"]:focus-visible { outline: 2px solid var(--brand-accent); outline-offset: 1px; }
.signup-form .btn { min-height: 50px; }
.consent { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; line-height: 1.7; color: var(--brand-text-light); }
.consent input { flex: none; width: 18px; height: 18px; margin-top: 4px; accent-color: var(--brand-accent); }
.done {
  padding: 16px 18px; border-radius: 8px;
  border: 1px solid var(--brand-accent); background: #fff5ec; text-align: left;
}
.error { margin: 0; font-size: 14px; font-weight: 700; color: #c0392b; }

/* 人には見せない。自動投稿だけが埋める項目。 */
.hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ---- フッター ---- */
.site-foot { background: var(--brand-primary); color: #fff; padding-top: 60px; }
.foot-top { display: flex; flex-wrap: wrap; gap: 40px; padding-bottom: 40px; }
.foot-info { flex: 2 1 300px; }
.foot-logo { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
.foot-desc { font-size: 14px; opacity: .7; margin: 0; }
.foot-links { display: flex; flex-wrap: wrap; gap: 40px; flex: 3 1 480px; }
.foot-col { flex: 1 1 160px; }
.foot-col-title { position: relative; font-size: 16px; margin: 0 0 22px; padding-bottom: 10px; }
.foot-col-title::after { content: ""; position: absolute; left: 0; bottom: 0; width: 40px; height: 2px; background: var(--brand-accent); }
.foot-col li { margin-bottom: 12px; }
.foot-col a { font-size: 14px; color: rgba(255, 255, 255, .7); }
.foot-col a:hover { color: var(--brand-accent); padding-left: 5px; }
.disclaimer {
  margin: 0; padding: 20px 0; font-size: 12.5px; line-height: 1.9;
  color: rgba(255, 255, 255, .6); border-top: 1px solid rgba(255, 255, 255, .1);
}
.foot-bottom { padding: 20px 0; text-align: center; border-top: 1px solid rgba(255, 255, 255, .1); }
.copyright { margin: 0; font-size: 13px; color: rgba(255, 255, 255, .6); }

/* ---- Back to Top ----
   元は JS で 400px 超えたら出していた。常時表示にしてある
   （そもそも元のマークアップも .visible を最初から付けていた）。 */
.back-to-top {
  position: fixed; right: 30px; bottom: 30px; z-index: 900;
  display: flex; align-items: center; justify-content: center;
  width: 50px; height: 50px; border-radius: 50%;
  background: var(--brand-accent); color: #fff; font-size: 22px;
  box-shadow: 0 4px 15px rgba(255, 125, 39, .3);
}
.back-to-top:hover { background: var(--brand-accent-deep); color: #fff; }

/* ---- スクロールのフェード ----
   元は IntersectionObserver。CSS のビュー駆動アニメーションで置き換える。
   **非対応なら何も起きず、最初から表示されている。** */
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .reveal {
      animation: reveal linear both;
      animation-timeline: view();
      animation-range: entry 0% cover 22%;
    }
    @keyframes reveal {
      from { opacity: 0; transform: translateY(24px); }
      to { opacity: 1; transform: none; }
    }
  }
}

/* ---- 画面幅 ---- */
@media (max-width: 1023px) {
  .cards-3, .reasons { grid-template-columns: repeat(2, 1fr); }
  .about-box { padding: 32px 26px; }
  .message-box { padding: 32px 28px; }
}
@media (max-width: 767px) {
  /* 狭い画面ではヘッダーの一覧を畳む。**ハンバーガーは置いていない**
     （開閉に JS が要る）。同じ行き先はフッターの一覧が持っている。 */
  .nav { display: none; }
  .hero { padding: 110px 0 70px; }
  .hero-title { font-size: 27px; }
  .hero-sub { font-size: 15px; }
  .hero-wave svg { height: 55px; }
  .section-title { font-size: 22px; }
  .section-sub { font-size: 15px; }
  .cards-3, .reasons, .nots { grid-template-columns: 1fr; }
  .band { padding: 45px 0; }
  .cta-band-inner { padding: 26px 20px; }
  .about-box, .message-box { padding: 26px 20px; }
  .reason-conclusion { padding: 22px 20px; }
  .feature { padding: 24px 22px; }
  .status-card { padding: 32px 22px; }
  .flow-item { gap: 18px; }
  .signup-form .btn { width: 100%; }
  .back-to-top { right: 16px; bottom: 16px; width: 44px; height: 44px; }
}
@media (max-width: 480px) {
  .hero-title { font-size: 24px; }
  .brand { font-size: 18px; }
  .hero-card { flex: 1 1 100%; }
}
`;
