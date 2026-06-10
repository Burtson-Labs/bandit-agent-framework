// Bandit docs — "Test your knowledge" glossary quiz. Client-side only.
// Standard mode (10 Q, 4 options). Pass it (>=70%) and Expert mode unlocks
// (12 Q, 6 options, tougher ratings, a gold "Certificate of AI Mastery").
// Every answer cites the glossary; the certificate is nameable, downloadable
// (rendered to canvas), and shareable. Best scores + name + unlock persist.
(function () {
  var TERMS = (window.QUIZ_TERMS || []).filter(function (t) { return t && t.def && t.term && t.anchor; });
  var root = document.getElementById("quiz");
  if (!root || TERMS.length < 6) return;
  var QUIZ_URL = "https://docs.burtson.ai/quiz.html";
  var LS_BEST = "bandit_quiz_best", LS_BEST_HARD = "bandit_quiz_best_hard",
      LS_ATT = "bandit_quiz_attempts", LS_NAME = "bandit_quiz_name", LS_UNLOCK = "bandit_quiz_expert";
  var PASS = 0.7;

  var MODES = {
    standard: {
      q: Math.min(10, TERMS.length), opts: 4, title: "Certificate of AI Fluency",
      ratings: [[0.9, "Bandit Sage", "You could have written the glossary yourself."],
                [0.7, "Agent Engineer", "A strong command of the fundamentals."],
                [0.5, "Practitioner", "Solid footing — a few terms left to master."],
                [0.3, "Apprentice", "A good start. The glossary is your friend."],
                [0, "Curious Newcomer", "Everyone starts here — read on and run it back."]]
    },
    hard: {
      q: Math.min(12, TERMS.length), opts: Math.min(6, TERMS.length), title: "Certificate of AI Mastery",
      ratings: [[0.92, "Bandit Grandmaster", "Expert mode, near-flawless. Formidable."],
                [0.75, "Agent Architect", "You know this domain cold."],
                [0.5, "Senior Practitioner", "Strong — Expert mode is no joke."],
                [0, "Challenger", "Expert mode bites. Regroup and run it back."]]
    }
  };

  var MODE = "standard", cfg = MODES.standard;
  var questions = [], idx = 0, score = 0, answers = [], result = null;

  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  function build(mode) {
    MODE = mode; cfg = MODES[mode];
    var chosen = shuffle(TERMS).slice(0, cfg.q), nd = cfg.opts - 1;
    questions = chosen.map(function (c, i) {
      var others = TERMS.filter(function (t) { return t.term !== c.term; });
      if (i % 2 === 0) {
        var dd = shuffle(others).slice(0, nd).map(function (t) { return t.def; });
        return { kind: "def", prompt: "Which definition fits this term?", sub: c.term,
                 correct: c.def, options: shuffle([c.def].concat(dd)), anchor: c.anchor, term: c.term };
      }
      var td = shuffle(others).slice(0, nd).map(function (t) { return t.term; });
      return { kind: "term", prompt: "Which term matches this definition?", sub: c.def,
               correct: c.term, options: shuffle([c.term].concat(td)), anchor: c.anchor, term: c.term };
    });
    idx = 0; score = 0; answers = [];
  }

  function start() {
    var best = localStorage.getItem(LS_BEST), bestHard = localStorage.getItem(LS_BEST_HARD);
    var unlocked = localStorage.getItem(LS_UNLOCK) === "1";
    var html =
      '<div class="quiz-card quiz-start">' +
        '<p class="quiz-eyebrow">Glossary challenge</p>' +
        '<h2>Test your AI fluency</h2>' +
        '<p>' + MODES.standard.q + ' multiple-choice questions on agent &amp; LLM terms — name a term from its definition, or pick the right definition for a term. Every answer links to the glossary, and you finish with a certificate you can download and share.</p>' +
        (best ? '<p class="quiz-best">Personal best: <strong>' + esc(best) + ' / ' + MODES.standard.q + '</strong></p>' : "") +
        '<div class="quiz-actions">' +
          '<button class="quiz-btn" id="quiz-go">Start the quiz &rarr;</button>' +
          (unlocked ? '<button class="quiz-btn ghost" id="quiz-hard">&#11088; Expert mode' + (bestHard ? ' &middot; best ' + esc(bestHard) + '/' + MODES.hard.q : '') + '</button>' : '') +
        '</div>' +
        (unlocked
          ? '<p class="quiz-unlocked-note">Expert mode unlocked — ' + MODES.hard.q + ' questions, ' + MODES.hard.opts + ' options each, gold certificate.</p>'
          : '<p class="quiz-unlocked-note quiz-locked">&#128274; Score ' + Math.round(PASS * 100) + '%+ to unlock Expert mode.</p>') +
        '<button class="quiz-share-link" id="quiz-share">&#128279; Challenge a friend</button>' +
      '</div>';
    root.innerHTML = html;
    document.getElementById("quiz-go").onclick = function () { build("standard"); renderQ(); };
    var hb = document.getElementById("quiz-hard");
    if (hb) hb.onclick = function () { build("hard"); renderQ(); };
    document.getElementById("quiz-share").onclick = shareQuiz;
  }

  function shareQuiz() {
    var text = "Test your AI fluency — a quick quiz on agent & LLM terms from the Bandit Agent Framework. Can you reach Bandit Sage?";
    if (navigator.share) {
      navigator.share({ title: "Bandit AI fluency quiz", text: text, url: QUIZ_URL }).catch(function () {});
    } else {
      window.open("https://twitter.com/intent/tweet?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(QUIZ_URL), "_blank", "noopener");
    }
  }

  function renderQ() {
    var q = questions[idx], N = cfg.q;
    root.innerHTML =
      '<div class="quiz-card' + (MODE === "hard" ? " quiz-hard-card" : "") + '">' +
        '<div class="quiz-progress"><span style="width:' + (idx / N * 100) + '%"></span></div>' +
        '<p class="quiz-eyebrow">' + (MODE === "hard" ? "&#11088; Expert &middot; " : "") + 'Question ' + (idx + 1) + ' of ' + N + ' &middot; ' + q.prompt + '</p>' +
        '<p class="quiz-def' + (q.kind === "def" ? " quiz-term" : "") + '">' + esc(q.sub) + '</p>' +
        '<div class="quiz-options' + (q.kind === "def" ? " quiz-options-long" : "") + '">' +
          q.options.map(function (o, i) { return '<button class="quiz-opt" data-i="' + i + '">' + esc(o) + '</button>'; }).join("") +
        '</div>' +
        '<div class="quiz-feedback" hidden></div>' +
      '</div>';
    [].forEach.call(root.querySelectorAll(".quiz-opt"), function (b) { b.onclick = function () { answer(b); }; });
  }

  function answer(btn) {
    var q = questions[idx], N = cfg.q;
    var ok = q.options[+btn.dataset.i] === q.correct;
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
    var rs = cfg.ratings;
    for (var i = 0; i < rs.length; i++) if (p >= rs[i][0]) return { t: rs[i][1], n: rs[i][2] };
    return { t: rs[rs.length - 1][1], n: rs[rs.length - 1][2] };
  }

  function finish() {
    var N = cfg.q, p = score / N, r = rating(p), expert = MODE === "hard";
    var bestKey = expert ? LS_BEST_HARD : LS_BEST, best = +(localStorage.getItem(bestKey) || 0);
    if (score > best) localStorage.setItem(bestKey, String(score));
    localStorage.setItem(LS_ATT, String((+(localStorage.getItem(LS_ATT) || 0)) + 1));
    var justUnlocked = false;
    if (!expert && p >= PASS && localStorage.getItem(LS_UNLOCK) !== "1") { localStorage.setItem(LS_UNLOCK, "1"); justUnlocked = true; }
    var name = localStorage.getItem(LS_NAME) || "";
    var wrong = answers.filter(function (a) { return !a.ok; });
    result = { pct: Math.round(p * 100), rating: r.t, note: r.n, score: score, N: N, mode: MODE, title: cfg.title,
               date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) };
    root.innerHTML =
      '<div class="quiz-result">' +
        '<div class="certificate' + (expert ? " expert" : "") + '"><div class="cert-inner">' +
          '<img class="cert-logo" src="' + (window.QUIZ_LOGO || "https://cdn.burtson.ai/logos/bandit-stealth.png") + '" alt="">' +
          '<p class="cert-kicker">Bandit Agent Framework' + (expert ? " &middot; Expert" : "") + '</p>' +
          '<p class="cert-title">' + esc(cfg.title) + '</p>' +
          '<p class="cert-awarded">awarded to</p>' +
          '<p class="cert-name" id="cert-name-display">' + esc(name || "Anonymous Agent") + '</p>' +
          '<div class="cert-seal"><span class="cert-pct">' + result.pct + '%</span></div>' +
          '<p class="cert-rating">' + esc(r.t) + '</p>' +
          '<p class="cert-note">' + esc(r.n) + '</p>' +
          '<div class="cert-foot"><span>' + score + ' / ' + N + ' correct</span><span>' + esc(result.date) + '</span></div>' +
        '</div></div>' +
        '<label class="cert-name-label" for="cert-name">Personalize your certificate</label>' +
        '<input id="cert-name" class="cert-name-input" type="text" maxlength="28" placeholder="Type your name" value="' + esc(name) + '">' +
        '<div class="quiz-actions">' +
          '<button class="quiz-btn" id="cert-download">&#8595; Download certificate</button>' +
          '<button class="quiz-btn" id="cert-share">Share</button>' +
        '</div>' +
        '<div class="quiz-summary">' +
          '<h3>' + score + ' / ' + N + ' &middot; ' + esc(r.t) + '</h3>' +
          (justUnlocked ? '<div class="quiz-unlock">&#11088; <strong>Expert mode unlocked!</strong> Tougher questions, six options each. <button class="quiz-btn" id="go-hard">Try Expert mode &rarr;</button></div>' : '') +
          (wrong.length
            ? '<p class="quiz-review-title">Worth another look:</p><ul class="quiz-review">' +
                wrong.map(function (a) { return '<li><strong>' + esc(a.term) + '</strong> <a href="./glossary.html#' + encodeURIComponent(a.anchor) + '">Glossary &rarr;</a></li>'; }).join("") +
              '</ul>'
            : '<p class="quiz-perfect">Flawless run. &#127919;</p>') +
          '<div class="quiz-actions">' +
            '<button class="quiz-btn ghost" id="quiz-again">' + (expert ? "Replay Expert" : "Try again") + ' &rarr;</button>' +
            '<a class="quiz-btn ghost" href="./glossary.html">Study the glossary</a>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.getElementById("quiz-again").onclick = function () { build(MODE); renderQ(); };
    var gh = document.getElementById("go-hard");
    if (gh) gh.onclick = function () { build("hard"); renderQ(); };
    var ni = document.getElementById("cert-name");
    ni.addEventListener("input", function (e) {
      localStorage.setItem(LS_NAME, e.target.value);
      document.getElementById("cert-name-display").textContent = e.target.value || "Anonymous Agent";
    });
    document.getElementById("cert-download").onclick = downloadCert;
    document.getElementById("cert-share").onclick = shareCert;
  }

  // ── Certificate export (native canvas render → PNG) ──────────────────────
  function certName() {
    var ni = document.getElementById("cert-name");
    return (ni && ni.value.trim()) || localStorage.getItem(LS_NAME) || "Anonymous Agent";
  }
  function loadLogo() {
    return new Promise(function (res) {
      if (!window.QUIZ_LOGO) return res(null);
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { res(null); };
      img.src = window.QUIZ_LOGO;
    });
  }
  function roundRect(x, rx, ry, w, h, r) {
    x.beginPath(); x.moveTo(rx + r, ry);
    x.arcTo(rx + w, ry, rx + w, ry + h, r); x.arcTo(rx + w, ry + h, rx, ry + h, r);
    x.arcTo(rx, ry + h, rx, ry, r); x.arcTo(rx, ry, rx + w, ry, r); x.closePath();
  }
  function drawCert() {
    var fonts = (document.fonts && document.fonts.ready) || Promise.resolve();
    return Promise.all([loadLogo(), fonts]).then(function (r) {
      var logo = r[0], gold = result.mode === "hard";
      var c1 = gold ? "#f5c542" : "#a60ee5", c2 = gold ? "#b8860b" : "#5b1e8f", c3 = gold ? "#d4a017" : "#b842f0";
      var W = 1200, H = 820, c = document.createElement("canvas");
      c.width = W; c.height = H;
      var x = c.getContext("2d");
      x.fillStyle = "#0a0c12"; x.fillRect(0, 0, W, H);
      var cw = 760, ch = 720, cx = (W - cw) / 2, cy = (H - ch) / 2, mid = W / 2;
      var border = x.createLinearGradient(cx, cy, cx + cw, cy + ch);
      border.addColorStop(0, c1); border.addColorStop(0.45, c2); border.addColorStop(0.7, "#1a1430"); border.addColorStop(1, c1);
      roundRect(x, cx, cy, cw, ch, 22); x.fillStyle = border; x.fill();
      var inner = x.createRadialGradient(mid, cy + 40, 30, mid, cy + 40, ch);
      inner.addColorStop(0, "#171327"); inner.addColorStop(1, "#0c0e15");
      roundRect(x, cx + 5, cy + 5, cw - 10, ch - 10, 18); x.fillStyle = inner; x.fill();
      x.textAlign = "center";
      var y = cy + 64;
      if (logo) { x.globalAlpha = 0.95; x.drawImage(logo, mid - 32, y - 14, 64, 64); x.globalAlpha = 1; }
      y += 70;
      if (x.letterSpacing !== undefined) x.letterSpacing = "3px";
      x.fillStyle = "#6b7385"; x.font = "600 13px Inter, Arial, sans-serif"; x.fillText("BANDIT AGENT FRAMEWORK" + (gold ? "  ·  EXPERT" : ""), mid, y);
      if (x.letterSpacing !== undefined) x.letterSpacing = "0px";
      y += 40;
      x.fillStyle = "#ffffff"; x.font = "800 34px Inter, Arial, sans-serif"; x.fillText(result.title, mid, y);
      y += 46;
      if (x.letterSpacing !== undefined) x.letterSpacing = "2px";
      x.fillStyle = "#6b7385"; x.font = "600 13px Inter, Arial, sans-serif"; x.fillText("AWARDED TO", mid, y);
      if (x.letterSpacing !== undefined) x.letterSpacing = "0px";
      y += 44;
      x.fillStyle = "#ffffff"; x.font = "700 34px Inter, Arial, sans-serif"; x.fillText(certName(), mid, y);
      x.strokeStyle = "#2a2f3a"; x.lineWidth = 1; x.beginPath(); x.moveTo(mid - 150, y + 16); x.lineTo(mid + 150, y + 16); x.stroke();
      y += 78;
      var sr = 46, scy = y + sr;
      var seal = x.createLinearGradient(mid - sr, scy - sr, mid + sr, scy + sr);
      seal.addColorStop(0, c1); seal.addColorStop(1, c3);
      x.beginPath(); x.arc(mid, scy, sr, 0, Math.PI * 2); x.fillStyle = seal; x.fill();
      x.fillStyle = gold ? "#1a1206" : "#ffffff"; x.font = "800 26px Inter, Arial, sans-serif"; x.textBaseline = "middle"; x.fillText(result.pct + "%", mid, scy + 1); x.textBaseline = "alphabetic";
      y = scy + sr + 48;
      x.fillStyle = gold ? "#f5c542" : "#c061f0"; x.font = "700 26px Inter, Arial, sans-serif"; x.fillText(result.rating, mid, y);
      y += 32;
      x.fillStyle = "#9aa3b6"; x.font = "400 16px Inter, Arial, sans-serif"; x.fillText(result.note, mid, y);
      var fy = cy + ch - 34;
      x.strokeStyle = "#2a2f3a"; x.beginPath(); x.moveTo(cx + 36, fy - 18); x.lineTo(cx + cw - 36, fy - 18); x.stroke();
      x.fillStyle = "#6b7385"; x.font = "400 14px Inter, Arial, sans-serif";
      x.textAlign = "left"; x.fillText(result.score + " / " + result.N + " correct", cx + 36, fy);
      x.textAlign = "right"; x.fillText(result.date, cx + cw - 36, fy);
      return c;
    });
  }
  function toBlob(canvas) { return new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, "image/png"); }); }
  function downloadCert() {
    drawCert().then(toBlob).then(function (blob) {
      if (!blob) return;
      var url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = "bandit-" + (result.mode === "hard" ? "mastery" : "fluency") + "-certificate.png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    });
  }
  function shareCert() {
    var text = "I scored " + result.score + "/" + result.N + " (" + result.rating + ") on the Bandit Agent Framework AI quiz. Test your knowledge:";
    drawCert().then(toBlob).then(function (blob) {
      var file = blob ? new File([blob], "bandit-certificate.png", { type: "image/png" }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: "Bandit AI Fluency", text: text + " " + QUIZ_URL }).catch(function () {});
      } else {
        window.open("https://twitter.com/intent/tweet?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(QUIZ_URL), "_blank", "noopener");
      }
    });
  }

  start();
})();
