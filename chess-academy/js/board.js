/*
 * Интерактивная доска: клик или перетаскивание, подсветка ходов,
 * последнего хода, шаха и подсказок.
 */
(function () {
  var FILES = 'abcdefgh';

  function injectSprite() {
    if (document.getElementById('piece-sprite')) return;
    var holder = document.createElement('div');
    holder.innerHTML = window.PIECE_SPRITE;
    document.body.appendChild(holder.firstChild);
  }

  function pieceSvg(p) {
    return '<svg class="piece" viewBox="0 0 40 40"><use href="#' + p.color + p.type + '"/></svg>';
  }

  function Board(el, opts) {
    injectSprite();
    this.el = el;
    this.opts = opts || {};
    this.orientation = this.opts.orientation || 'w';
    this.game = new Chess();
    this.selected = null;
    this.marks = {};
    this.interactive = true;
    this.el.classList.add('board');
    this._bindPointer();
    this.render();
  }

  Board.prototype.setPosition = function (fen) {
    this.game.load(fen);
    this.selected = null;
    this.render();
  };

  Board.prototype.setOrientation = function (c) {
    this.orientation = c;
    this.render();
  };

  Board.prototype.flip = function () {
    this.setOrientation(this.orientation === 'w' ? 'b' : 'w');
  };

  /* marks: { lastMove: [from, to], hint: sq, good: sq, bad: sq } */
  Board.prototype.setMarks = function (marks) {
    this.marks = marks || {};
    this.render();
  };

  Board.prototype.squareAt = function (row, col) {
    var f = this.orientation === 'w' ? col : 7 - col;
    var r = this.orientation === 'w' ? 8 - row : row + 1;
    return FILES[f] + r;
  };

  Board.prototype.render = function () {
    var html = '';
    var g = this.game;
    var legal = [];
    if (this.selected) {
      legal = g.moves({ square: this.selected, verbose: true }).map(function (m) { return m.to; });
    }
    var checkSq = null;
    if (g.in_check()) {
      var b = g.board();
      for (var r = 0; r < 8; r++) for (var f = 0; f < 8; f++) {
        var p = b[r][f];
        if (p && p.type === 'k' && p.color === g.turn()) checkSq = FILES[f] + (8 - r);
      }
    }
    var lm = this.marks.lastMove || [];
    for (var row = 0; row < 8; row++) {
      for (var col = 0; col < 8; col++) {
        var sq = this.squareAt(row, col);
        var light = (FILES.indexOf(sq[0]) + parseInt(sq[1], 10)) % 2 === 1;
        var cls = ['sq', light ? 'light' : 'dark'];
        if (lm.indexOf(sq) >= 0) cls.push('last');
        if (sq === this.selected) cls.push('sel');
        if (sq === checkSq) cls.push('check');
        if (sq === this.marks.hint) cls.push('hint');
        if (sq === this.marks.good) cls.push('good');
        if (sq === this.marks.bad) cls.push('bad');
        var piece = g.get(sq);
        if (legal.indexOf(sq) >= 0) cls.push(piece ? 'target-cap' : 'target');
        html += '<div class="' + cls.join(' ') + '" data-sq="' + sq + '">';
        if (col === 0) html += '<span class="coord rank">' + sq[1] + '</span>';
        if (row === 7) html += '<span class="coord file">' + sq[0] + '</span>';
        if (piece) html += pieceSvg(piece);
        html += '</div>';
      }
    }
    this.el.innerHTML = html;
  };

  Board.prototype.canMove = function (sq) {
    if (!this.interactive) return false;
    var p = this.game.get(sq);
    if (!p || p.color !== this.game.turn()) return false;
    if (this.opts.movableColor && p.color !== this.opts.movableColor()) return false;
    return true;
  };

  Board.prototype.tryMove = function (from, to) {
    var ok = this.game.moves({ square: from, verbose: true }).some(function (m) { return m.to === to; });
    this.selected = null;
    if (!ok) { this.render(); return false; }
    var accepted = this.opts.onMove ? this.opts.onMove(from, to) : true;
    if (accepted === false) this.render();
    return accepted;
  };

  Board.prototype._sqFromPoint = function (x, y) {
    var r = this.el.getBoundingClientRect();
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return null;
    var col = Math.floor((x - r.left) / (r.width / 8));
    var row = Math.floor((y - r.top) / (r.height / 8));
    return this.squareAt(row, col);
  };

  Board.prototype._bindPointer = function () {
    var self = this;
    var drag = null;

    this.el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var sq = self._sqFromPoint(e.clientX, e.clientY);
      if (!sq) return;
      // клик по полю назначения
      if (self.selected && sq !== self.selected && !self.canMove(sq)) {
        self.tryMove(self.selected, sq);
        return;
      }
      if (!self.canMove(sq)) {
        if (self.selected) { self.selected = null; self.render(); }
        return;
      }
      e.preventDefault();
      var wasSelected = self.selected === sq;
      self.selected = sq;
      self.render();
      var cell = self.el.querySelector('[data-sq="' + sq + '"] .piece');
      if (!cell) return;
      var size = self.el.getBoundingClientRect().width / 8;
      var ghost = cell.cloneNode(true);
      ghost.classList.add('ghost');
      ghost.style.width = ghost.style.height = size + 'px';
      document.body.appendChild(ghost);
      cell.style.opacity = '0.25';
      drag = { from: sq, ghost: ghost, size: size, moved: false, wasSelected: wasSelected };
      moveGhost(e);
      try { self.el.setPointerCapture(e.pointerId); } catch (err) {}
    });

    function moveGhost(e) {
      drag.ghost.style.left = (e.clientX - drag.size / 2) + 'px';
      drag.ghost.style.top = (e.clientY - drag.size / 2) + 'px';
    }

    this.el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      drag.moved = true;
      moveGhost(e);
    });

    function end(e) {
      if (!drag) return;
      var d = drag;
      drag = null;
      d.ghost.remove();
      var to = self._sqFromPoint(e.clientX, e.clientY);
      if (to && to !== d.from) {
        self.tryMove(d.from, to);
      } else if (d.wasSelected && !d.moved) {
        self.selected = null;
        self.render();
      } else {
        self.render();
      }
    }
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  };

  window.Board = Board;
})();
