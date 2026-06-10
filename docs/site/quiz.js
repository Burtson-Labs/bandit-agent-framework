// Bandit docs — "Test your knowledge" glossary quiz. Runs entirely client-side:
// reads window.QUIZ_TERMS (injected by the page), builds a fresh round each
// attempt (random terms, random question type, shuffled options), cites every
// answer in the glossary, and awards a certificate. Best score + name persist
// in localStorage.
(function () {
  var TERMS = (window.QUIZ_TERMS || []).filter(function (t) { return t && t.def && t.term && t.anchor; });
  var root = document.getElementById("quiz");
  if (!root || TERMS.length < 4) return;
  var N = Math.min(10, TERMS.length);
  var LS_BEST = "bandit_quiz_best", LS_ATT = "bandit_quiz_attempts", LS_NAME = "bandit_quiz_name";

  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  var questions = [], idx = 0, score = 0, answers = [];

  // Two question kinds for variety + difficulty:
  //  - "term": show a definition, pick the matching term (recognition).
  //  - "def":  show a term, pick the matching definition out of four real ones (harder).
  function build() {
    var chosen = shuffle(TERMS).slice(0, N);
    // Keep a roughly even mix of the two kinds, then the per-question order is
    // already random because `chosen` is shuffled.
    questions = chosen.map(function (c, i) {
      var others = TERMS.filter(function (t) { return t.term !== c.term; });
      var byDef = (i % 2 === 0);
      if (byDef) {
        var defDistract = shuffle(others).slice(0, 3).map(function (t) { return t.def; });
        return { kind: "def", prompt: "Which definition fits this term?", sub: c.term,
                 correct: c.def, options: shuffle([c.def].concat(defDistract)), anchor: c.anchor, term: c.term };
      }
      var termDistract = shuffle(others).slice(0, 3).map(function (t) { return t.term; });
      return { kind: "term", prompt: "Which term matches this definition?", sub: c.def,
               correct: c.term, options: shuffle([c.term].concat(termDistract)), anchor: c.anchor, term: c.term };
    });
    idx = 0; score = 0; answers = [];
  }

  function start() {
    var best = localStorage.getItem(LS_BEST);
    root.innerHTML =
      '<div class="quiz-card quiz-start">' +
        '<p class="quiz-eyebrow">Glossary challenge</p>' +
        '<h2>Test your AI fluency</h2>' +
        '<p>' + N + ' multiple-choice questions on agent &amp; LLM terms — some ask you to name a term from its definition, some to pick the right definition for a term. Every answer links back to the glossary, and you finish with a certificate.</p>' +
        (best ? '<p class="quiz-best">Personal best: <strong>' + esc(best) + ' / ' + N + '</strong></p>' : "") +
        '<button class="quiz-btn" id="quiz-go">Start the quiz &rarr;</button>' +
      '</div>';
    document.getElementById("quiz-go").onclick = function () { build(); renderQ(); };
  }

  function renderQ() {
    var q = questions[idx];
    root.innerHTML =
      '<div class="quiz-card">' +
        '<div class="quiz-progress"><span style="width:' + (idx / N * 100) + '%"></span></div>' +
        '<p class="quiz-eyebrow">Question ' + (idx + 1) + ' of ' + N + ' &middot; ' + q.prompt + '</p>' +
        '<p class="quiz-def' + (q.kind === "def" ? " quiz-term" : "") + '">' + esc(q.sub) + '</p>' +
        '<div class="quiz-options' + (q.kind === "def" ? " quiz-options-long" : "") + '">' +
          q.options.map(function (o, i) { return '<button class="quiz-opt" data-i="' + i + '">' + esc(o) + '</button>'; }).join("") +
        '</div>' +
        '<div class="quiz-feedback" hidden></div>' +
      '</div>';
    [].forEach.call(root.querySelectorAll(".quiz-opt"), function (b) { b.onclick = function () { answer(b); }; });
  }

  function answer(btn) {
    var q = questions[idx];
    var chosen = q.options[+btn.dataset.i];
    var ok = chosen === q.correct;
    if (ok) score++;
    answers.push({ term: q.term, anchor: q.anchor, ok: ok });
    [].forEach.call(root.querySelectorAll(".quiz-opt"), function (b) {
      b.disabled = true;
      if (q.options[+b.dataset.i] === q.correct) b.classList.add("right");
      else if (b === btn) b.classList.add("wrong");
    });
    var fb = root.querySelector(".quiz-feedback");
    fb.hidden = false;
    fb.innerHTML =
      '<p>' + (ok ? '<span class="quiz-ok">&#10003; Correct.</span>'
                  : '<span class="quiz-no">&#10007; The answer was <strong>' + esc(q.term) + '</strong>.</span>') +
        ' <a href="./glossary.html#' + encodeURIComponent(q.anchor) + '">Read it in the glossary &rarr;</a></p>' +
      '<button class="quiz-btn quiz-next">' + (idx + 1 < N ? "Next question &rarr;" : "See your score &rarr;") + '</button>';
    fb.querySelector(".quiz-next").onclick = function () { idx++; if (idx < N) renderQ(); else finish(); };
  }

  function rating(p) {
    if (p >= 0.9) return { t: "Bandit Sage", n: "You could have written the glossary yourself." };
    if (p >= 0.7) return { t: "Agent Engineer", n: "A strong command of the fundamentals." };
    if (p >= 0.5) return { t: "Practitioner", n: "Solid footing — a few terms left to master." };
    if (p >= 0.3) return { t: "Apprentice", n: "A good start. The glossary is your friend." };
    return { t: "Curious Newcomer", n: "Everyone starts here — read on and run it back." };
  }

  function finish() {
    var p = score / N, r = rating(p);
    var best = +(localStorage.getItem(LS_BEST) || 0);
    if (score > best) localStorage.setItem(LS_BEST, String(score));
    localStorage.setItem(LS_ATT, String((+(localStorage.getItem(LS_ATT) || 0)) + 1));
    var name = localStorage.getItem(LS_NAME) || "";
    var wrong = answers.filter(function (a) { return !a.ok; });
    var date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    root.innerHTML =
      '<div class="quiz-result">' +
        '<div class="certificate"><div class="cert-inner">' +
          '<img class="cert-logo" src="https://cdn.burtson.ai/logos/bandit-stealth.png" alt="">' +
          '<p class="cert-kicker">Bandit Agent Framework</p>' +
          '<p class="cert-title">Certificate of AI Fluency</p>' +
          '<p class="cert-awarded">awarded to</p>' +
          '<p class="cert-name" id="cert-name-display">' + esc(name || "Anonymous Agent") + '</p>' +
          '<div class="cert-seal"><span class="cert-pct">' + Math.round(p * 100) + '%</span></div>' +
          '<p class="cert-rating">' + esc(r.t) + '</p>' +
          '<p class="cert-note">' + esc(r.n) + '</p>' +
          '<div class="cert-foot"><span>' + score + ' / ' + N + ' correct</span><span>' + esc(date) + '</span></div>' +
        '</div></div>' +
        '<input id="cert-name" class="cert-name-input" type="text" maxlength="28" placeholder="Type your name for the certificate" value="' + esc(name) + '">' +
        '<div class="quiz-summary">' +
          '<h3>' + score + ' / ' + N + ' &middot; ' + esc(r.t) + '</h3>' +
          (wrong.length
            ? '<p class="quiz-review-title">Worth another look:</p><ul class="quiz-review">' +
                wrong.map(function (a) { return '<li><strong>' + esc(a.term) + '</strong> <a href="./glossary.html#' + encodeURIComponent(a.anchor) + '">Glossary &rarr;</a></li>'; }).join("") +
              '</ul>'
            : '<p class="quiz-perfect">Flawless run. &#127919;</p>') +
          '<div class="quiz-actions">' +
            '<button class="quiz-btn" id="quiz-again">Try again &rarr;</button>' +
            '<a class="quiz-btn ghost" href="./glossary.html">Study the glossary</a>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.getElementById("quiz-again").onclick = start;
    var ni = document.getElementById("cert-name");
    ni.addEventListener("input", function (e) {
      localStorage.setItem(LS_NAME, e.target.value);
      document.getElementById("cert-name-display").textContent = e.target.value || "Anonymous Agent";
    });
  }

  start();
})();
