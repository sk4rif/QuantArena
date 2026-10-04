export function renderAbout(): string {
  return `
  <article class="doc">
    <header class="doc-hero">
      <span class="pill">Skill, not luck</span>
      <h1>Games decided by skill</h1>
      <p class="lead">Zero Sum hosts games in which the outcome comes from your decisions. No dice, no shuffles, no hidden randomness in the result: every game is server-authoritative, the rules are published, and the same API is open to bots and humans.</p>
    </header>

    <section id="about-how">
      <h2>How a game works</h2>
      <ol>
        <li><strong>Pick a game.</strong> Each game has its own rules, arena and API.</li>
        <li><strong>Pick a level.</strong> Levels run on separate servers and differ only by the stake you put in.</li>
        <li><strong>Play or automate.</strong> Play in the browser, or connect a bot to the same endpoints.</li>
      </ol>
      <p class="hint">Every level currently open uses a simulated ledger. No real funds are accepted, held, or paid.</p>
      <p>Start from the <a href="#/">game list</a>.</p>
    </section>
  </article>`;
}
