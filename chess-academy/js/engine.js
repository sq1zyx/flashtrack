/*
 * Простой шахматный движок: альфа-бета + форсированный перебор взятий,
 * оценка материала и позиционные таблицы. Плюс дебютная книга из OPENINGS.
 */
(function () {
  var VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  // Таблицы с точки зрения белых, индекс 0 = a8.
  var PST = {
    p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
        0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
    n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
        -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
    b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
        -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
    r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
        -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
    q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5,
        0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
    k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
        -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
    kEnd: [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30,
        -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50]
  };

  var MATE = 100000;

  // Оценка с точки зрения белых
  function evaluate(game) {
    var board = game.board();
    var score = 0, nonPawn = 0;
    var r, f, sq;
    for (r = 0; r < 8; r++) for (f = 0; f < 8; f++) {
      sq = board[r][f];
      if (sq && sq.type !== 'p' && sq.type !== 'k') nonPawn += VAL[sq.type];
    }
    var endgame = nonPawn <= 1600;
    for (r = 0; r < 8; r++) for (f = 0; f < 8; f++) {
      sq = board[r][f];
      if (!sq) continue;
      var idx = sq.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
      var table = sq.type === 'k' && endgame ? PST.kEnd : PST[sq.type];
      var v = VAL[sq.type] + table[idx];
      score += sq.color === 'w' ? v : -v;
    }
    return score;
  }

  function orderMoves(moves) {
    return moves.sort(function (a, b) { return moveScore(b) - moveScore(a); });
  }
  function moveScore(m) {
    var s = 0;
    if (m.captured) s += 10 * VAL[m.captured] - VAL[m.piece] + 1000;
    if (m.promotion) s += VAL[m.promotion] + 900;
    if (m.san.indexOf('+') >= 0) s += 50;
    return s;
  }

  var nodes = 0, deadline = 0;

  function quiesce(game, alpha, beta, color, depth) {
    nodes++;
    var stand = color * evaluate(game);
    if (stand >= beta) return beta;
    if (alpha < stand) alpha = stand;
    if (depth <= 0) return alpha;
    var moves = orderMoves(game.moves({ verbose: true }).filter(function (m) { return m.captured || m.promotion; }));
    for (var i = 0; i < moves.length; i++) {
      game.move(moves[i]);
      var score = -quiesce(game, -beta, -alpha, -color, depth - 1);
      game.undo();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function negamax(game, depth, alpha, beta, color, ply) {
    nodes++;
    if (game.in_checkmate()) return -MATE + ply;
    if (game.in_draw() || game.in_threefold_repetition()) return 0;
    if (depth <= 0) return quiesce(game, alpha, beta, color, 4);
    var moves = orderMoves(game.moves({ verbose: true }));
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      game.move(moves[i]);
      var score = -negamax(game, depth - 1, -beta, -alpha, -color, ply + 1);
      game.undo();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
      if (Date.now() > deadline) break;
    }
    return best;
  }

  /* Возвращает ход из дебютной книги (по всем дебютам из OPENINGS) или null. */
  function bookMove(game) {
    var hist = game.history();
    var candidates = [];
    (window.OPENINGS || []).forEach(function (o) {
      if (o.moves.length <= hist.length) return;
      for (var i = 0; i < hist.length; i++) if (o.moves[i][0] !== hist[i]) return;
      if (o.group === 'Ловушки' && hist.length > 4) return;
      candidates.push(o.moves[hist.length][0]);
    });
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /* Определяет название дебюта по истории ходов (самое длинное совпадение). */
  function detectOpening(history) {
    var best = null, bestLen = 0;
    (window.OPENINGS || []).forEach(function (o) {
      var n = 0;
      while (n < history.length && n < o.moves.length && o.moves[n][0] === history[n]) n++;
      // совпала вся история или вся линия дебюта
      var full = n === history.length || n === o.moves.length;
      if (full && n > bestLen && n >= 3) { best = o; bestLen = n; }
    });
    return best;
  }

  /*
   * level: 1 — новичок (часто ошибается), 2 — любитель, 3 — сильный, 4 — мастер.
   */
  function bestMove(fen, level, history) {
    var game = new Chess(fen);
    var moves = game.moves({ verbose: true });
    if (!moves.length) return null;

    if (history && level >= 2) {
      var hg = new Chess();
      history.forEach(function (m) { hg.move(m); });
      if (hg.fen() === game.fen()) {
        var bm = bookMove(hg);
        if (bm) return bm;
      }
    }

    var depth = { 1: 1, 2: 2, 3: 3, 4: 4 }[level] || 2;
    var color = game.turn() === 'w' ? 1 : -1;
    nodes = 0;
    deadline = Date.now() + (level >= 4 ? 6000 : 3000);
    var scored = [];
    moves = orderMoves(moves);
    var alpha = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      game.move(moves[i]);
      var s = -negamax(game, depth - 1, -Infinity, level <= 2 ? Infinity : -alpha, -color, 1);
      game.undo();
      scored.push({ san: moves[i].san, score: s });
      if (s > alpha) alpha = s;
      if (Date.now() > deadline) break;
    }
    // стабильная сортировка: при равенстве первым остаётся ход с точной оценкой
    scored = scored.map(function (m, i) { m.i = i; return m; })
      .sort(function (a, b) { return b.score - a.score || a.i - b.i; });

    // Новичок иногда выбирает случайный неплохой ход, иногда ошибается
    if (level === 1) {
      var pool = scored.slice(0, Math.min(5, scored.length));
      if (Math.random() < 0.25) pool = scored;
      return pool[Math.floor(Math.random() * pool.length)].san;
    }
    if (level === 2) {
      var near = scored.filter(function (m) { return m.score >= scored[0].score - 30; });
      return near[Math.floor(Math.random() * near.length)].san;
    }
    return scored[0].san;
  }

  /* Оценка позиции в пешках с точки зрения белых (для шкалы). */
  function analyse(fen, depth) {
    var game = new Chess(fen);
    if (game.in_checkmate()) return game.turn() === 'w' ? -99 : 99;
    if (game.in_draw()) return 0;
    var color = game.turn() === 'w' ? 1 : -1;
    deadline = Date.now() + 1500;
    var s = negamax(game, depth || 2, -Infinity, Infinity, color, 0) * color;
    if (Math.abs(s) > MATE / 2) return s > 0 ? 99 : -99;
    return s / 100;
  }

  window.Engine = { bestMove: bestMove, analyse: analyse, detectOpening: detectOpening, evaluate: evaluate };
})();
