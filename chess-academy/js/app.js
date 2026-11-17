/* Шахматная школа «Дебют» — логика приложения. */
(function () {
  var app = document.getElementById('app');
  var OPENINGS = window.OPENINGS;
  var LESSONS = window.LESSONS;
  var PUZZLES = window.PUZZLES;
  var START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  /* ---------- Прогресс (localStorage) ---------- */
  var KEY = 'debut-progress-v1';
  function load() {
    try { var d = JSON.parse(localStorage.getItem(KEY)); if (d) return d; } catch (e) {}
    return { openings: {}, puzzles: {}, games: { played: 0, won: 0 } };
  }
  var progress = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(progress)); } catch (e) {} }
  function opProg(id) { return progress.openings[id] || (progress.openings[id] = {}); }
  function stars(id) {
    var p = progress.openings[id] || {};
    return (p.studied ? 1 : 0) + (p.trained ? 1 : 0) + (p.clean ? 1 : 0);
  }
  function starsHtml(n) {
    var s = '<span class="stars" title="1 — изучен, 2 — пройдена тренировка, 3 — тренировка без ошибок">';
    for (var i = 0; i < 3; i++) s += i < n ? '★' : '<span class="off">★</span>';
    return s + '</span>';
  }

  /* ---------- Утилиты ---------- */
  function $(sel, root) { return (root || app).querySelector(sel); }
  function norm(san) { return san.replace(/[+#?!]/g, ''); }
  function sideName(c) { return c === 'w' ? 'За белых' : 'За чёрных'; }
  var LEVELS = { 1: 'Новичок', 2: 'Любитель', 3: 'Продвинутый' };
  function levelPill(l) { return '<span class="pill lvl' + l + '">' + LEVELS[l] + '</span>'; }
  function movesText(list, max) {
    var out = [];
    for (var i = 0; i < Math.min(list.length, max || list.length); i++) {
      out.push((i % 2 === 0 ? (i / 2 + 1) + '.' : '') + list[i]);
    }
    return out.join(' ') + (max && list.length > max ? ' …' : '');
  }
  function fenAfter(moves, n) {
    var g = new Chess();
    for (var i = 0; i < n; i++) g.move(moves[i]);
    return g;
  }
  function miniBoard(el, fen, orientation) {
    var b = new Board(el, { orientation: orientation || 'w' });
    b.interactive = false;
    b.setPosition(fen);
    return b;
  }
  function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

  /* Список ходов: sans, opts { cur, onClick, tags, hideAfter, future } */
  function renderMoves(el, sans, opts) {
    opts = opts || {};
    var html = '';
    var total = opts.total || sans.length;
    for (var i = 0; i < total; i++) {
      if (i % 2 === 0) html += '<div class="num">' + (i / 2 + 1) + '.</div>';
      var cls = 'mv';
      if (i === opts.cur) cls += ' cur';
      if (opts.future != null && i > opts.future) cls += ' future';
      var hidden = opts.hideAfter != null && i > opts.hideAfter;
      if (hidden) cls += ' hidden';
      var tag = opts.tags && opts.tags[i] ? '<span class="tag ' + opts.tags[i].cls + '">' + opts.tags[i].sym + '</span>' : '';
      html += '<div class="' + cls + '" data-i="' + i + '">' + (hidden ? '…' : (sans[i] || '')) + tag + '</div>';
    }
    if (total % 2 === 1) html += '<div></div>';
    el.innerHTML = html || '<div class="muted" style="grid-column:1/-1;padding:4px 8px">Ходов пока нет</div>';
    if (opts.onClick) {
      el.querySelectorAll('.mv').forEach(function (m) {
        m.addEventListener('click', function () { opts.onClick(+m.dataset.i); });
      });
    }
    var cur = el.querySelector('.cur') || el.querySelector('.mv:not(.hidden):last-of-type');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- Роутер ---------- */
  var cleanup = [];
  function onCleanup(fn) { cleanup.push(fn); }
  function later(fn, ms) { var t = setTimeout(fn, ms); onCleanup(function () { clearTimeout(t); }); return t; }
  function onKey(fn) { document.addEventListener('keydown', fn); onCleanup(function () { document.removeEventListener('keydown', fn); }); }

  function route() {
    cleanup.forEach(function (f) { f(); });
    cleanup = [];
    var parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
    var name = parts[0] || 'home';
    document.querySelectorAll('.nav a').forEach(function (a) {
      var r = a.dataset.route;
      a.classList.toggle('active', r === name || (r === 'openings' && name === 'opening') ||
        (r === 'lessons' && name === 'lesson') || (r === 'puzzles' && name === 'puzzle'));
    });
    window.scrollTo(0, 0);
    var views = { home: home, openings: openingsList, opening: openingView, lessons: lessonsList,
      lesson: lessonView, puzzles: puzzlesList, puzzle: puzzleView, play: playView };
    (views[name] || home)(parts[1]);
  }
  window.addEventListener('hashchange', route);

  /* ---------- Главная ---------- */
  function home() {
    var studied = OPENINGS.filter(function (o) { return stars(o.id) >= 1; }).length;
    var mastered = OPENINGS.filter(function (o) { return stars(o.id) === 3; }).length;
    var solved = PUZZLES.filter(function (p) { return progress.puzzles[p.id]; }).length;
    var next = OPENINGS.slice().sort(function (a, b) { return a.level - b.level; })
      .filter(function (o) { return stars(o.id) < 3; })[0];

    app.innerHTML =
      '<section class="hero">' +
        '<div>' +
          '<h1>Научись играть в шахматы уверенно</h1>' +
          '<p class="lead">Разбирай дебюты ход за ходом с пояснениями, закрепляй их в тренировке, решай задачи и играй с ботом-тренером, который оценивает каждый твой ход.</p>' +
          '<div class="btn-row">' +
            '<a class="btn primary" href="#/opening/' + (next ? next.id : 'italian') + '">' + (studied ? 'Продолжить обучение' : 'Начать с дебютов') + '</a>' +
            '<a class="btn" href="#/play">Сыграть с ботом</a>' +
          '</div>' +
          '<div class="stats">' +
            '<div class="stat"><b>' + studied + '/' + OPENINGS.length + '</b><span>дебютов изучено</span></div>' +
            '<div class="stat"><b>' + mastered + '</b><span>освоено на ★★★</span></div>' +
            '<div class="stat"><b>' + solved + '/' + PUZZLES.length + '</b><span>задач решено</span></div>' +
            '<div class="stat"><b>' + progress.games.won + '/' + progress.games.played + '</b><span>побед над ботом</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="board" id="hero-board"></div>' +
      '</section>' +
      (next ? '<div class="card note info" style="margin-bottom:8px"><b>Следующий шаг:</b> ' + next.name + ' — ' + next.summary +
        ' <a href="#/opening/' + next.id + '">Открыть →</a></div>' : '') +
      '<div class="section-title"><h2>План обучения</h2><span class="muted">Иди по шагам — так быстрее всего вырастет сила игры</span></div>' +
      '<div class="tiles">' +
        tile('📘', '1. Основы', 'Ценность фигур, правила дебюта и как искать хороший ход.', '#/lessons') +
        tile('♙', '2. Дебюты за белых', 'Итальянская партия, Лондонская система, Ферзевый гамбит.', '#/openings') +
        tile('♟', '3. Дебюты за чёрных', 'Каро-Канн, Скандинавская, Славянская и Сицилианская.', '#/openings') +
        tile('⚡', '4. Тактика', 'Вилки, связки, маты — решай задачи и находи удары.', '#/puzzles') +
        tile('🤖', '5. Практика', 'Играй с ботом: он узнаёт дебют и разбирает каждый ход.', '#/play') +
      '</div>';
    var g = fenAfter(OPENINGS[0].moves.map(function (m) { return m[0]; }), 5);
    miniBoard($('#hero-board'), g.fen());
  }
  function tile(ico, title, text, href) {
    return '<a class="card tile" href="' + href + '"><div class="ico">' + ico + '</div><h3>' + title + '</h3><p>' + text + '</p></a>';
  }

  /* ---------- Список дебютов ---------- */
  var filter = { side: 'all', level: 'all' };
  function openingsList() {
    app.innerHTML =
      '<h1>Дебюты</h1>' +
      '<p class="muted">Каждый дебют можно изучить по шагам с пояснениями, а потом закрепить в тренировке — сыграть его по памяти.</p>' +
      '<div class="filters">' +
        '<div class="seg" id="f-side">' + seg([['all', 'Все'], ['w', 'За белых'], ['b', 'За чёрных']], filter.side) + '</div>' +
        '<div class="seg" id="f-level">' + seg([['all', 'Любой уровень'], ['1', 'Новичок'], ['2', 'Любитель'], ['3', 'Продвинутый']], filter.level) + '</div>' +
      '</div>' +
      '<div id="op-list"></div>';
    bindSeg('#f-side', function (v) { filter.side = v; draw(); });
    bindSeg('#f-level', function (v) { filter.level = v; draw(); });
    function draw() {
      var groups = {};
      OPENINGS.forEach(function (o) {
        if (filter.side !== 'all' && o.side !== filter.side) return;
        if (filter.level !== 'all' && String(o.level) !== filter.level) return;
        (groups[o.group] = groups[o.group] || []).push(o);
      });
      var html = '';
      Object.keys(groups).forEach(function (g) {
        html += '<div class="group-title">' + g + '</div><div class="op-grid">';
        groups[g].forEach(function (o) {
          html += '<a class="card op-card" href="#/opening/' + o.id + '">' +
            '<div class="top"><h3 style="margin:0">' + o.name + '</h3>' + starsHtml(stars(o.id)) + '</div>' +
            '<div class="moves">' + movesText(o.moves.map(function (m) { return m[0]; }), 8) + '</div>' +
            '<p>' + o.summary + '</p>' +
            '<div class="meta"><span class="pill ' + o.side + '">' + sideName(o.side) + '</span>' + levelPill(o.level) +
            '<span class="pill">' + o.eco + '</span></div></a>';
        });
        html += '</div>';
      });
      $('#op-list').innerHTML = html || '<p class="muted">Ничего не найдено.</p>';
    }
    draw();
  }
  function seg(items, cur) {
    return items.map(function (it) {
      return '<button data-v="' + it[0] + '" class="' + (it[0] === cur ? 'on' : '') + '">' + it[1] + '</button>';
    }).join('');
  }
  function bindSeg(sel, fn) {
    var el = $(sel);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      el.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
      fn(b.dataset.v);
    });
  }

  /* ---------- Страница дебюта ---------- */
  function openingView(id) {
    var o = OPENINGS.filter(function (x) { return x.id === id; })[0];
    if (!o) { location.hash = '#/openings'; return; }
    var sans = o.moves.map(function (m) { return m[0]; });
    var N = sans.length;
    var mode = 'learn';
    var idx = 0;           // сколько ходов сыграно
    var mistakes = 0, hintLevel = 0, busy = false, done = false;

    app.innerHTML =
      '<a class="back" href="#/openings">← Все дебюты</a>' +
      '<div class="study">' +
        '<div class="board-col"><div class="board" id="board"></div></div>' +
        '<div class="side-panel">' +
          '<div>' +
            '<h1 style="margin-bottom:6px">' + o.name + '</h1>' +
            '<div class="btn-row" style="align-items:center"><span class="pill ' + o.side + '">' + sideName(o.side) + '</span>' +
            levelPill(o.level) + '<span class="pill">' + o.eco + '</span>' + '<span id="stars">' + starsHtml(stars(o.id)) + '</span></div>' +
          '</div>' +
          '<div class="seg" id="mode">' + seg([['learn', '📖 Изучение'], ['train', '🎯 Тренировка']], 'learn') + '</div>' +
          '<div class="note" id="note"></div>' +
          '<div id="controls"></div>' +
          '<div class="movelist" id="moves"></div>' +
          '<div class="card"><h3>Главные идеи</h3><ul class="ideas">' +
            o.ideas.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul></div>' +
        '</div>' +
      '</div>';

    var boardEl = $('#board');
    var board = new Board(boardEl, {
      orientation: o.side,
      movableColor: function () { return o.side; },
      onMove: onUserMove
    });

    bindSeg('#mode', function (v) { mode = v; start(); });

    function marksFor(n) {
      if (n === 0) return {};
      var g = fenAfter(sans, n - 1);
      var m = g.move(sans[n - 1]);
      return { lastMove: [m.from, m.to] };
    }

    function setNote(html, cls) {
      var n = $('#note');
      n.className = 'note' + (cls ? ' ' + cls : '');
      n.innerHTML = html;
    }
    function moveLabel(i) { return (Math.floor(i / 2) + 1) + (i % 2 === 0 ? '. ' : '… ') + sans[i]; }

    /* --- Режим изучения --- */
    function showLearn(n) {
      idx = Math.max(0, Math.min(N, n));
      board.interactive = false;
      board.setPosition(fenAfter(sans, idx).fen());
      board.setMarks(marksFor(idx));
      if (idx === 0) setNote('<b>Начальная позиция.</b> ' + o.summary + '<br><span class="muted">Жми «Вперёд» или стрелку → на клавиатуре.</span>');
      else setNote('<b>' + moveLabel(idx - 1) + '</b> — ' + o.moves[idx - 1][1]);
      renderMoves($('#moves'), sans, { cur: idx - 1, future: idx - 1, onClick: function (i) { showLearn(i + 1); } });
      $('#pos').textContent = idx + ' / ' + N;
      $('#prev').disabled = $('#first').disabled = idx === 0;
      $('#next').disabled = $('#last').disabled = idx === N;
      if (idx === N) {
        var p = opProg(o.id);
        if (!p.studied) { p.studied = true; save(); $('#stars').innerHTML = starsHtml(stars(o.id)); }
        setNote('<b>' + moveLabel(idx - 1) + '</b> — ' + o.moves[idx - 1][1] +
          '<br><br>✅ Линия изучена! Теперь переключись на <b>«Тренировку»</b> и сыграй её по памяти.', 'good');
      }
    }

    /* --- Режим тренировки --- */
    function trainStep() {
      board.setPosition(fenAfter(sans, idx).fen());
      renderMoves($('#moves'), sans, { cur: idx - 1, hideAfter: idx - 1, total: N });
      $('#bar').style.width = Math.round(idx / N * 100) + '%';
      $('#mist').textContent = mistakes;
    }

    function myTurn() { return (idx % 2 === 0 ? 'w' : 'b') === o.side; }

    function opponentMove() {
      if (idx >= N) return finish();
      busy = true;
      board.interactive = false;
      later(function () {
        idx++;
        trainStep();
        board.setMarks(marksFor(idx));
        setNote('Соперник: <b>' + moveLabel(idx - 1) + '</b> — ' + o.moves[idx - 1][1] +
          (idx < N ? '<br><span class="muted">Твой ход. Какой ход в этом дебюте?</span>' : ''), 'info');
        busy = false;
        board.interactive = true;
        hintLevel = 0;
        if (idx >= N) finish();
      }, 650);
    }

    function onUserMove(from, to) {
      if (mode !== 'train' || busy || done || !myTurn()) return false;
      var g = fenAfter(sans, idx);
      var m = g.move({ from: from, to: to, promotion: 'q' });
      if (!m) return false;
      if (norm(m.san) === norm(sans[idx])) {
        idx++;
        hintLevel = 0;
        trainStep();
        board.setMarks({ lastMove: [from, to], good: to });
        setNote('✅ Верно! <b>' + moveLabel(idx - 1) + '</b> — ' + o.moves[idx - 1][1], 'good');
        if (idx >= N) finish(); else opponentMove();
        return true;
      }
      mistakes++;
      $('#mist').textContent = mistakes;
      shake(boardEl);
      board.setMarks({ lastMove: marksFor(idx).lastMove, bad: from });
      setNote('❌ <b>' + m.san + '</b> — в этом дебюте так не играют. Вспомни идею: <i>' +
        o.moves[idx][1] + '</i><br><span class="muted">Нужна помощь? Нажми «Подсказка».</span>', 'bad');
      return false;
    }

    function hint() {
      if (mode !== 'train' || done || !myTurn()) return;
      var g = fenAfter(sans, idx);
      var m = g.move(sans[idx]);
      hintLevel++;
      if (hintLevel === 1) {
        board.setMarks({ lastMove: marksFor(idx).lastMove, hint: m.from });
        setNote('💡 Сходи фигурой с подсвеченного поля <b>' + m.from + '</b>.', 'info');
      } else {
        board.setMarks({ lastMove: marksFor(idx).lastMove, hint: m.to, good: m.from });
        setNote('💡 Правильный ход: <b>' + sans[idx] + '</b> (' + m.from + '–' + m.to + ').', 'info');
      }
    }

    function finish() {
      done = true;
      board.interactive = false;
      var p = opProg(o.id);
      p.studied = true;
      p.trained = true;
      if (mistakes === 0) p.clean = true;
      p.last = Date.now();
      p.runs = (p.runs || 0) + 1;
      save();
      $('#stars').innerHTML = starsHtml(stars(o.id));
      var nextOp = OPENINGS[(OPENINGS.indexOf(o) + 1) % OPENINGS.length];
      $('#controls').innerHTML =
        '<div class="card result"><div class="big">' + (mistakes === 0 ? '🏆' : '👍') + '</div>' +
        '<h2>' + (mistakes === 0 ? 'Без единой ошибки!' : 'Дебют пройден') + '</h2>' +
        '<p class="muted">' + (mistakes === 0 ? 'Отлично, линия освоена.' : 'Ошибок: ' + mistakes + '. Повтори ещё раз, чтобы получить третью звезду.') + '</p>' +
        '<div class="btn-row" style="justify-content:center"><button class="btn primary" id="again">Ещё раз</button>' +
        '<a class="btn" href="#/opening/' + nextOp.id + '">Следующий: ' + nextOp.name + ' →</a></div></div>';
      $('#again').onclick = start;
    }

    function start() {
      cleanup.forEach(function (f) { f(); });
      cleanup = [];
      idx = 0; mistakes = 0; hintLevel = 0; busy = false; done = false;
      board.setOrientation(o.side);
      board.setMarks({});
      if (mode === 'learn') {
        $('#controls').innerHTML =
          '<div class="btn-row" style="align-items:center">' +
          '<button class="btn" id="first" title="В начало">⏮</button>' +
          '<button class="btn" id="prev" title="Назад">◀ Назад</button>' +
          '<button class="btn primary" id="next" title="Вперёд">Вперёд ▶</button>' +
          '<button class="btn" id="last" title="В конец">⏭</button>' +
          '<span class="muted" id="pos" style="margin-left:6px"></span>' +
          '<button class="btn small" id="flip" style="margin-left:auto">⇅ Перевернуть</button></div>';
        $('#first').onclick = function () { showLearn(0); };
        $('#prev').onclick = function () { showLearn(idx - 1); };
        $('#next').onclick = function () { showLearn(idx + 1); };
        $('#last').onclick = function () { showLearn(N); };
        $('#flip').onclick = function () { board.flip(); };
        onKey(function (e) {
          if (e.key === 'ArrowRight') showLearn(idx + 1);
          if (e.key === 'ArrowLeft') showLearn(idx - 1);
        });
        showLearn(0);
      } else {
        $('#controls').innerHTML =
          '<div class="progress" style="margin-bottom:10px"><div id="bar" style="width:0"></div></div>' +
          '<div class="btn-row" style="align-items:center">' +
          '<button class="btn" id="hint">💡 Подсказка</button>' +
          '<button class="btn" id="restart">↺ Заново</button>' +
          '<span class="muted" style="margin-left:auto">Ошибок: <b id="mist">0</b></span></div>';
        $('#hint').onclick = hint;
        $('#restart').onclick = start;
        board.interactive = true;
        trainStep();
        if (o.side === 'b') {
          setNote('Ты играешь <b>чёрными</b>. Дождись хода белых и отвечай по дебюту.', 'info');
          opponentMove();
        } else {
          setNote('Ты играешь <b>белыми</b>. Сыграй дебют «' + o.name + '» по памяти. Начинай!', 'info');
        }
      }
    }
    start();
  }

  /* ---------- Уроки ---------- */
  function lessonsList() {
    app.innerHTML = '<h1>Уроки</h1><p class="muted">Короткие уроки о главном: от ценности фигур до тактических приёмов.</p>' +
      '<div class="lesson-grid">' + LESSONS.map(function (l, i) {
        return '<a class="card lesson" href="#/lesson/' + l.id + '"><div class="board" id="lb' + i + '"></div>' +
          '<div><span class="pill">' + l.tag + '</span><h3 style="margin:8px 0 6px">' + l.title + '</h3><p>' + l.body[0] + '</p></div></a>';
      }).join('') + '</div>';
    LESSONS.forEach(function (l, i) { miniBoard($('#lb' + i), l.fen); });
  }

  function lessonView(id) {
    var i = LESSONS.map(function (l) { return l.id; }).indexOf(id);
    if (i < 0) { location.hash = '#/lessons'; return; }
    var l = LESSONS[i];
    var prev = LESSONS[i - 1], next = LESSONS[i + 1];
    app.innerHTML =
      '<a class="back" href="#/lessons">← Все уроки</a>' +
      '<div class="study">' +
        '<div class="board-col"><div class="board" id="board"></div>' +
          '<p class="muted" style="margin-top:10px;font-size:.88rem">Можно двигать фигуры, чтобы проверить идеи. «Сбросить» вернёт позицию.</p></div>' +
        '<div class="side-panel">' +
          '<div><span class="pill">' + l.tag + '</span><h1 style="margin-top:8px">' + l.title + '</h1></div>' +
          '<div class="card lesson-body">' + l.body.map(function (p) { return '<p>' + p + '</p>'; }).join('') + '</div>' +
          '<div class="btn-row">' +
            '<button class="btn" id="reset">↺ Сбросить позицию</button>' +
            (prev ? '<a class="btn" href="#/lesson/' + prev.id + '">← ' + prev.title + '</a>' : '') +
            (next ? '<a class="btn primary" href="#/lesson/' + next.id + '">' + next.title + ' →</a>' :
              '<a class="btn primary" href="#/puzzles">К задачам →</a>') +
          '</div>' +
        '</div>' +
      '</div>';
    var board = new Board($('#board'), {
      onMove: function (from, to) {
        var m = board.game.move({ from: from, to: to, promotion: 'q' });
        board.setMarks({ lastMove: [m.from, m.to] });
        return true;
      }
    });
    board.setPosition(l.fen);
    $('#reset').onclick = function () { board.setPosition(l.fen); board.setMarks({}); };
  }

  /* ---------- Задачи ---------- */
  function puzzlesList() {
    var solved = PUZZLES.filter(function (p) { return progress.puzzles[p.id]; }).length;
    app.innerHTML = '<h1>Задачи</h1><p class="muted">Найди лучший ход. Решено: <b>' + solved + ' из ' + PUZZLES.length + '</b></p>' +
      '<div class="progress" style="max-width:360px;margin-bottom:22px"><div style="width:' + Math.round(solved / PUZZLES.length * 100) + '%"></div></div>' +
      '<div class="puzzle-grid">' + PUZZLES.map(function (p, i) {
        var turn = p.fen.split(' ')[1];
        return '<a class="card puzzle-card" href="#/puzzle/' + p.id + '"><div class="board" id="pb' + i + '"></div>' +
          '<div class="row"><span>' + (i + 1) + '. ' + p.title + '</span>' + (progress.puzzles[p.id] ? '<span class="solved">✓</span>' : '') + '</div>' +
          '<div class="row"><span class="turn"><i class="' + turn + '"></i><small class="muted">' + (turn === 'w' ? 'Ход белых' : 'Ход чёрных') + '</small></span>' +
          levelPill(p.level) + '</div></a>';
      }).join('') + '</div>';
    PUZZLES.forEach(function (p, i) { miniBoard($('#pb' + i), p.fen, p.fen.split(' ')[1]); });
  }

  function puzzleView(id) {
    var i = PUZZLES.map(function (p) { return p.id; }).indexOf(id);
    if (i < 0) { location.hash = '#/puzzles'; return; }
    var p = PUZZLES[i];
    var next = PUZZLES[(i + 1) % PUZZLES.length];
    var me = p.fen.split(' ')[1];
    var step = 0, solvedNow = false, busy = false, hintLevel = 0;

    app.innerHTML =
      '<a class="back" href="#/puzzles">← Все задачи</a>' +
      '<div class="study">' +
        '<div class="board-col"><div class="board" id="board"></div></div>' +
        '<div class="side-panel">' +
          '<div><h1 style="margin-bottom:6px">' + (i + 1) + '. ' + p.title + '</h1>' +
          '<div class="btn-row" style="align-items:center"><span class="turn"><i class="' + me + '"></i>' +
          (me === 'w' ? 'Ход белых' : 'Ход чёрных') + '</span>' + levelPill(p.level) +
          (progress.puzzles[p.id] ? '<span class="solved">✓ решена</span>' : '') + '</div></div>' +
          '<div class="note info" id="note">Найди лучший ход' + (p.solution.length > 1 ? ' (решение в ' + Math.ceil(p.solution.length / 2) + ' хода)' : '') + '.</div>' +
          '<div class="btn-row">' +
            '<button class="btn" id="hint">💡 Подсказка</button>' +
            '<button class="btn" id="reset">↺ Заново</button>' +
            '<a class="btn primary" href="#/puzzle/' + next.id + '">Следующая →</a>' +
          '</div>' +
        '</div>' +
      '</div>';
    var boardEl = $('#board');
    var board = new Board(boardEl, { orientation: me, movableColor: function () { return me; }, onMove: onMove });
    board.setPosition(p.fen);

    function note(html, cls) { var n = $('#note'); n.className = 'note ' + (cls || ''); n.innerHTML = html; }

    function onMove(from, to) {
      if (busy || solvedNow) return false;
      var g = new Chess(board.game.fen());
      var m = g.move({ from: from, to: to, promotion: 'q' });
      var expected = p.solution[step];
      var isMate = g.in_checkmate();
      if (!(norm(m.san) === norm(expected) || isMate)) {
        shake(boardEl);
        board.setMarks({ bad: from });
        note('❌ <b>' + m.san + '</b> — не лучший ход. Попробуй ещё!', 'bad');
        return false;
      }
      board.game.move(m.san);
      board.setMarks({ lastMove: [from, to], good: to });
      step++;
      hintLevel = 0;
      if (isMate || step >= p.solution.length) {
        solvedNow = true;
        progress.puzzles[p.id] = true;
        save();
        note('🎉 Правильно! <b>' + m.san + '</b>' + (isMate ? ' — мат!' : '') + ' Задача решена.', 'good');
        return true;
      }
      note('✅ <b>' + m.san + '</b> — верно! Соперник отвечает…', 'good');
      busy = true;
      later(function () {
        var r = board.game.move(p.solution[step]);
        step++;
        board.setMarks({ lastMove: [r.from, r.to] });
        note('Соперник сыграл <b>' + r.san + '</b>. Твой ход — добивай!', 'info');
        busy = false;
      }, 600);
      return true;
    }

    $('#hint').onclick = function () {
      if (solvedNow || busy) return;
      hintLevel++;
      var g = new Chess(board.game.fen());
      var m = g.move(p.solution[step]);
      if (hintLevel === 1) note('💡 ' + p.hint, 'info');
      else if (hintLevel === 2) { board.setMarks({ hint: m.from }); note('💡 ' + p.hint + '<br>Ходи фигурой с поля <b>' + m.from + '</b>.', 'info'); }
      else { board.setMarks({ hint: m.to, good: m.from }); note('💡 Решение: <b>' + m.san + '</b>', 'info'); }
    };
    $('#reset').onclick = function () {
      cleanup.forEach(function (f) { f(); }); cleanup = [];
      step = 0; solvedNow = false; busy = false; hintLevel = 0;
      board.setPosition(p.fen); board.setMarks({});
      note('Найди лучший ход.', 'info');
    };
  }

  /* ---------- Игра с ботом ---------- */
  var playSettings = { color: 'w', level: '2' };
  function playView() {
    var game, userColor, level, tags, evals, thinking = false, over = false, evalBefore = 0, showEval = true;

    app.innerHTML =
      '<div class="study">' +
        '<div class="board-col"><div class="board-wrap">' +
          '<div class="evalbar" id="evalbar"><div class="fill" id="evalfill" style="height:50%"></div></div>' +
          '<div class="board" id="board"></div></div></div>' +
        '<div class="side-panel">' +
          '<div><h1 style="margin-bottom:4px">Игра с ботом-тренером</h1>' +
          '<p class="muted" style="margin:0">Бот знает все дебюты из библиотеки и оценивает каждый твой ход.</p></div>' +
          '<div class="card" style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end">' +
            '<label class="field">Цвет<div class="seg" id="s-color">' + seg([['w', 'Белые'], ['b', 'Чёрные'], ['r', 'Случайно']], playSettings.color) + '</div></label>' +
            '<label class="field">Сила бота<div class="seg" id="s-level">' + seg([['1', 'Новичок'], ['2', 'Любитель'], ['3', 'Сильный']], playSettings.level) + '</div></label>' +
            '<button class="btn primary" id="new">Новая игра</button>' +
          '</div>' +
          '<div class="turn" id="status"></div>' +
          '<div class="note info" id="opening">Дебют: —</div>' +
          '<div class="note" id="coach">Сделай первый ход. После каждого хода тренер подскажет, насколько он хорош.</div>' +
          '<div class="btn-row">' +
            '<button class="btn" id="hint">💡 Подсказка</button>' +
            '<button class="btn" id="undo">↶ Вернуть ход</button>' +
            '<button class="btn" id="flip">⇅ Перевернуть</button>' +
            '<button class="btn" id="eval">Оценка: вкл</button>' +
            '<button class="btn" id="resign">🏳 Сдаться</button>' +
          '</div>' +
          '<div class="movelist" id="moves"></div>' +
        '</div>' +
      '</div>';

    var boardEl = $('#board');
    var board = new Board(boardEl, {
      movableColor: function () { return userColor; },
      onMove: userMove
    });

    bindSeg('#s-color', function (v) { playSettings.color = v; });
    bindSeg('#s-level', function (v) { playSettings.level = v; });
    $('#new').onclick = newGame;
    $('#flip').onclick = function () { board.flip(); $('#evalbar').classList.toggle('flipped', board.orientation === 'b'); };
    $('#eval').onclick = function () {
      showEval = !showEval;
      $('#eval').textContent = 'Оценка: ' + (showEval ? 'вкл' : 'выкл');
      $('#evalbar').style.visibility = showEval ? 'visible' : 'hidden';
    };
    $('#undo').onclick = undo;
    $('#hint').onclick = hint;
    $('#resign').onclick = function () {
      if (over || !game.history().length) return;
      endGame('Ты сдался. Ничего страшного — разбери партию и попробуй снова!', false);
    };

    function coach(html, cls) { var n = $('#coach'); n.className = 'note ' + (cls || ''); n.innerHTML = html; }

    function setEval(v) {
      var c = Math.max(-8, Math.min(8, v));
      $('#evalfill').style.height = (50 + c * 6) + '%';
      $('#evalbar').title = 'Оценка: ' + (v > 0 ? '+' : '') + (Math.abs(v) >= 99 ? 'мат' : v.toFixed(1));
    }

    function newGame() {
      cleanup.forEach(function (f) { f(); }); cleanup = [];
      game = new Chess();
      userColor = playSettings.color === 'r' ? (Math.random() < .5 ? 'w' : 'b') : playSettings.color;
      level = +playSettings.level;
      tags = []; evals = []; over = false; thinking = false; evalBefore = 0.3;
      board.setOrientation(userColor);
      $('#evalbar').classList.toggle('flipped', userColor === 'b');
      sync();
      setEval(0.3);
      coach('Ты играешь <b>' + (userColor === 'w' ? 'белыми' : 'чёрными') + '</b> против бота «' +
        { 1: 'Новичок', 2: 'Любитель', 3: 'Сильный' }[level] + '». ' +
        (userColor === 'w' ? 'Твой ход!' : 'Бот начинает.'), 'info');
      if (userColor === 'b') botMove();
    }

    function sync(lastMove) {
      board.setPosition(game.fen());
      var hist = game.history({ verbose: true });
      var lm = lastMove || (hist.length ? [hist[hist.length - 1].from, hist[hist.length - 1].to] : null);
      board.setMarks(lm ? { lastMove: lm } : {});
      board.interactive = !thinking && !over;
      renderMoves($('#moves'), game.history(), { cur: game.history().length - 1, tags: tags });
      var t = game.turn();
      $('#status').innerHTML = '<i class="' + t + '"></i>' + (over ? 'Партия окончена' : thinking ? 'Бот думает…' :
        (t === userColor ? 'Твой ход' : 'Ход бота') + (game.in_check() ? ' — шах!' : ''));
      var op = Engine.detectOpening(game.history());
      $('#opening').innerHTML = op ? 'Дебют: <b>' + op.name + '</b> · <a href="#/opening/' + op.id + '">изучить →</a>' :
        (game.history().length < 3 ? 'Дебют: —' : 'Дебют: позиция вне библиотеки — играй по принципам!');
    }

    function classify(loss) {
      if (loss < 0.3) return { cls: 'ok', sym: '✓', text: 'Хороший ход', note: 'good' };
      if (loss < 0.9) return { cls: 'inacc', sym: '?!', text: 'Неточность', note: '' };
      if (loss < 2.0) return { cls: 'mist', sym: '?', text: 'Ошибка', note: 'bad' };
      return { cls: 'blun', sym: '??', text: 'Зевок', note: 'bad' };
    }

    function userMove(from, to) {
      if (thinking || over || game.turn() !== userColor) return false;
      var fenBefore = game.fen();
      var m = game.move({ from: from, to: to, promotion: 'q' });
      if (!m) return false;
      thinking = true;
      sync([from, to]);
      $('#status').innerHTML = '<i class="' + game.turn() + '"></i>Тренер анализирует…';
      later(function () {
        var sign = userColor === 'w' ? 1 : -1;
        var after = Engine.analyse(game.fen(), 2);
        var loss = (evalBefore - after) * sign;
        var inBook = isBook(game.history());
        var q = inBook ? { cls: 'ok', sym: '📖', text: 'Книжный ход', note: 'good' } : classify(loss);
        tags[game.history().length - 1] = q;
        setEval(after);
        var msg = '<b>' + m.san + ' — ' + q.text + '.</b> ';
        if (inBook) msg += 'Ты играешь по теории дебюта.';
        else if (q.cls === 'ok') msg += 'Так держать.';
        else {
          var best = Engine.bestMove(fenBefore, 3, null);
          if (best && norm(best) !== norm(m.san)) msg += 'Сильнее было <b>' + best + '</b>. ';
          if (q.cls === 'blun') msg += 'Проверяй перед ходом: какие фигуры остаются без защиты и что угрожает сопернику.';
          if (q.cls === 'mist') msg += 'Позиция заметно ухудшилась.';
        }
        coach(msg, q.note);
        thinking = false;
        if (checkEnd()) return;
        botMove();
      }, 60);
      return true;
    }

    function isBook(hist) {
      return OPENINGS.some(function (o) {
        if (o.moves.length < hist.length) return false;
        for (var i = 0; i < hist.length; i++) if (o.moves[i][0] !== hist[i]) return false;
        return true;
      });
    }

    function botMove() {
      thinking = true;
      sync();
      later(function () {
        var san = Engine.bestMove(game.fen(), level, game.history());
        var m = game.move(san);
        thinking = false;
        sync([m.from, m.to]);
        if (checkEnd()) return;
        later(function () {
          evalBefore = Engine.analyse(game.fen(), 2);
          setEval(evalBefore);
        }, 30);
      }, 350);
    }

    function checkEnd() {
      if (!game.game_over()) return false;
      if (game.in_checkmate()) {
        var userWon = game.turn() !== userColor;
        endGame(userWon ? '🏆 Мат! Ты победил. Отличная партия!' : 'Мат. Бот победил — посмотри, где тренер отметил ошибки.', userWon);
      } else {
        var why = game.in_stalemate() ? 'Пат' : game.in_threefold_repetition() ? 'Троекратное повторение' :
          game.insufficient_material() ? 'Недостаточно материала' : 'Правило 50 ходов';
        endGame('🤝 Ничья: ' + why + '.', false);
      }
      return true;
    }

    function endGame(text, won) {
      over = true;
      progress.games.played++;
      if (won) progress.games.won++;
      save();
      sync();
      var counts = { inacc: 0, mist: 0, blun: 0 };
      tags.forEach(function (t) { if (t && counts[t.cls] != null) counts[t.cls]++; });
      coach(text + '<br><span class="muted">Твоя статистика: неточностей — ' + counts.inacc + ', ошибок — ' + counts.mist +
        ', зевков — ' + counts.blun + '.</span>', won ? 'good' : 'info');
    }

    function undo() {
      if (thinking) return;
      var hist = game.history();
      if (!hist.length) return;
      if (over) over = false;
      // откатываем до хода игрока
      game.undo();
      tags.length = game.history().length;
      if (game.turn() !== userColor && game.history().length) { game.undo(); tags.length = game.history().length; }
      if (game.turn() !== userColor) { sync(); botMove(); return; }
      sync();
      evalBefore = Engine.analyse(game.fen(), 2);
      setEval(evalBefore);
      coach('Ход возвращён. Подумай ещё раз!', 'info');
    }

    function hint() {
      if (thinking || over || game.turn() !== userColor) return;
      var hist = game.history();
      var book = null;
      OPENINGS.forEach(function (o) {
        if (book || o.moves.length <= hist.length) return;
        for (var i = 0; i < hist.length; i++) if (o.moves[i][0] !== hist[i]) return;
        book = o;
      });
      var san = book ? book.moves[hist.length][0] : Engine.bestMove(game.fen(), 3, null);
      var g = new Chess(game.fen());
      var m = g.move(san);
      board.setMarks({ lastMove: board.marks.lastMove, hint: m.from, good: m.to });
      coach('💡 ' + (book ? 'По теории (' + book.name + '): <b>' + san + '</b> — ' + book.moves[hist.length][1] :
        'Тренер предлагает: <b>' + san + '</b>'), 'info');
    }

    newGame();
  }

  route();
})();
