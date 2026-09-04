/**
 * TimiQR — a tiny, dependency-free QR code encoder, adapted for the clinic
 * overflow-tools referral link and rendered as inline SVG (no image request,
 * no third party, nothing leaving the browser).
 *
 * Adapted from "QR Code Generator for JavaScript" by Kazuhiko Arase
 * (http://www.d-project.com/), MIT licensed:
 * http://www.opensource.org/licenses/mit-license.php
 * "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
 *
 * This is a trim of the original: byte-mode text only (every referral link
 * this renders is ASCII), and the version (size) table only goes up to 20 —
 * comfortably enough for any URL Tími generates (well under 200 characters)
 * without vendoring the full 1-to-40 table this console will never reach.
 * Nothing else about the algorithm is simplified: version selection, Reed–
 * Solomon error correction, and mask-pattern scoring all run exactly as
 * upstream, and this file's output has been diffed module-for-module against
 * the upstream library across a range of versions and error-correction
 * levels — see the code review notes if this ever needs re-validating after
 * an edit.
 *
 * No CDN, no build step: this file is loaded directly with a <script> tag
 * and exposes one global, `TimiQR`.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------- GF(256) math --- */
  // The multiplication table for QR's Galois field is generated rather than
  // hard-coded: EXP[i] for i < 8 is just 2^i, and the recurrence below falls
  // straight out of the field's generator polynomial (0x11D), so there is no
  // 256-entry table to transcribe (and possibly mistranscribe) by hand.
  var EXP = new Array(256);
  var LOG = new Array(256);
  for (var qi = 0; qi < 8; qi += 1) EXP[qi] = 1 << qi;
  for (var qj = 8; qj < 256; qj += 1) EXP[qj] = EXP[qj - 4] ^ EXP[qj - 5] ^ EXP[qj - 6] ^ EXP[qj - 8];
  for (var qk = 0; qk < 255; qk += 1) LOG[EXP[qk]] = qk;
  function glog(n) { return LOG[n]; }
  function gexp(n) { while (n < 0) n += 255; while (n >= 256) n -= 255; return EXP[n]; }

  /* --------------------------------------------------- GF(256) polynomial --- */
  function Poly(coefficients, shift) {
    var offset = 0;
    while (offset < coefficients.length && coefficients[offset] === 0) offset += 1;
    var values = new Array(coefficients.length - offset + shift).fill(0);
    for (var i = 0; i < coefficients.length - offset; i += 1) values[i] = coefficients[i + offset];
    return {
      at: function (index) { return values[index]; },
      length: values.length,
      multiply: function (other) {
        var out = new Array(this.length + other.length - 1).fill(0);
        for (var a = 0; a < this.length; a += 1) {
          for (var b = 0; b < other.length; b += 1) {
            out[a + b] ^= gexp(glog(this.at(a)) + glog(other.at(b)));
          }
        }
        return Poly(out, 0);
      },
      mod: function (other) {
        var current = this;
        while (current.length - other.length >= 0) {
          var ratio = glog(current.at(0)) - glog(other.at(0));
          var next = [];
          for (var i = 0; i < current.length; i += 1) next[i] = current.at(i);
          for (var i = 0; i < other.length; i += 1) next[i] ^= gexp(glog(other.at(i)) + ratio);
          current = Poly(next, 0);
        }
        return current;
      }
    };
  }
  function errorCorrectPolynomial(length) {
    var poly = Poly([1], 0);
    for (var i = 0; i < length; i += 1) poly = poly.multiply(Poly([1, gexp(i)], 0));
    return poly;
  }

  /* ------------------------------------------------------------ bit buffer --- */
  function BitBuffer() {
    var buffer = [];
    var length = 0;
    return {
      bytes: function () { return buffer; },
      bitLength: function () { return length; },
      putBit: function (bit) {
        var index = Math.floor(length / 8);
        if (buffer.length <= index) buffer.push(0);
        if (bit) buffer[index] |= (0x80 >>> (length % 8));
        length += 1;
      },
      put: function (num, bitCount) {
        for (var i = 0; i < bitCount; i += 1) this.putBit(((num >>> (bitCount - i - 1)) & 1) === 1);
      }
    };
  }

  /* ------------------------------------------------------- fixed QR tables --- */
  // Alignment-pattern centers, indexed by version - 1. Versions 21-40 are
  // never reached — see the file header — so only 1-20 are kept here.
  var PATTERN_POSITIONS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
    [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
    [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]
  ];
  // Reed-Solomon block layout per version, in [count, totalCodewords,
  // dataCodewords] triples (two triples where a version splits into two
  // groups of blocks) — one row per error-correction level, L/M/Q/H, per
  // version. Versions 1-20 only, for the same reason as the table above.
  var RS_BLOCK_TABLE = [
    [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
    [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
    [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
    [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
    [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
    [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
    [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
    [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
    [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
    [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16],
    [4, 101, 81], [1, 80, 50, 4, 81, 51], [4, 50, 22, 4, 51, 23], [3, 36, 12, 8, 37, 13],
    [2, 116, 92, 2, 117, 93], [6, 58, 36, 2, 59, 37], [4, 46, 20, 6, 47, 21], [7, 42, 14, 4, 43, 15],
    [4, 133, 107], [8, 59, 37, 1, 60, 38], [8, 44, 20, 4, 45, 21], [12, 33, 11, 4, 34, 12],
    [3, 145, 115, 1, 146, 116], [4, 64, 40, 5, 65, 41], [11, 36, 16, 5, 37, 17], [11, 36, 12, 5, 37, 13],
    [5, 109, 87, 1, 110, 88], [5, 65, 41, 5, 66, 42], [5, 54, 24, 7, 55, 25], [11, 36, 12, 7, 37, 13],
    [5, 122, 98, 1, 123, 99], [7, 73, 45, 3, 74, 46], [15, 43, 19, 2, 44, 20], [3, 45, 15, 13, 46, 16],
    [1, 135, 107, 5, 136, 108], [10, 74, 46, 1, 75, 47], [1, 50, 22, 15, 51, 23], [2, 42, 14, 17, 43, 15],
    [5, 150, 120, 1, 151, 121], [9, 69, 43, 4, 70, 44], [17, 50, 22, 1, 51, 23], [2, 42, 14, 19, 43, 15],
    [3, 141, 113, 4, 142, 114], [3, 70, 44, 11, 71, 45], [17, 47, 21, 4, 48, 22], [9, 39, 13, 16, 40, 14],
    [3, 135, 107, 5, 136, 108], [3, 67, 41, 13, 68, 42], [15, 54, 24, 5, 55, 25], [15, 43, 15, 10, 44, 16]
  ];
  // Offset into each version's 4-row group of the table above.
  var RS_TABLE_OFFSET = { L: 0, M: 1, Q: 2, H: 3 };
  // The QR spec's own 2-bit error-correction-level indicator, used only in
  // the format-info bits written into the symbol — distinct from (and not to
  // be confused with) RS_TABLE_OFFSET above.
  var FORMAT_LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  var MASK_FUNCTIONS = [
    function (i, j) { return (i + j) % 2 === 0; },
    function (i, j) { return i % 2 === 0; },
    function (i, j) { return j % 3 === 0; },
    function (i, j) { return (i + j) % 3 === 0; },
    function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
    function (i, j) { return ((i * j) % 2) + ((i * j) % 3) === 0; },
    function (i, j) { return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0; },
    function (i, j) { return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0; }
  ];
  var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
  var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
  var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
  function bchDigitCount(value) { var digits = 0; while (value !== 0) { digits += 1; value >>>= 1; } return digits; }
  function bchTypeInfo(data) {
    var d = data << 10;
    while (bchDigitCount(d) - bchDigitCount(G15) >= 0) d ^= (G15 << (bchDigitCount(d) - bchDigitCount(G15)));
    return ((data << 10) | d) ^ G15_MASK;
  }
  function bchTypeNumber(data) {
    var d = data << 12;
    while (bchDigitCount(d) - bchDigitCount(G18) >= 0) d ^= (G18 << (bchDigitCount(d) - bchDigitCount(G18)));
    return (data << 12) | d;
  }

  function getRSBlocks(typeNumber, level) {
    var row = RS_BLOCK_TABLE[(typeNumber - 1) * 4 + RS_TABLE_OFFSET[level]];
    var blocks = [];
    for (var i = 0; i < row.length / 3; i += 1) {
      var count = row[i * 3];
      var total = row[i * 3 + 1];
      var data = row[i * 3 + 2];
      for (var j = 0; j < count; j += 1) blocks.push({ total: total, data: data });
    }
    return blocks;
  }

  function utf8Bytes(text) {
    var encoded = encodeURIComponent(text);
    var bytes = [];
    for (var i = 0; i < encoded.length; i += 1) {
      if (encoded[i] === "%") { bytes.push(parseInt(encoded.substr(i + 1, 2), 16)); i += 2; }
      else bytes.push(encoded.charCodeAt(i));
    }
    return bytes;
  }

  /**
   * Encodes `text` (byte mode only) at the given error-correction level
   * ("L" | "M" | "Q" | "H", default "M") and returns `{ moduleCount, isDark }`
   * — the module grid, ready to render. Picks the smallest version (1-20)
   * that fits; throws if the text is too long even at version 20, which
   * nothing this console generates should ever reach (see the file header).
   */
  function encode(text, level) {
    level = level && FORMAT_LEVEL_BITS[level] !== undefined ? level : "M";
    var bytes = utf8Bytes(String(text));

    var typeNumber = null;
    var rsBlocks = null;
    var buffer = null;
    for (var candidate = 1; candidate <= 20; candidate += 1) {
      rsBlocks = getRSBlocks(candidate, level);
      buffer = BitBuffer();
      buffer.put(4, 4); // mode indicator: byte mode
      buffer.put(bytes.length, candidate < 10 ? 8 : 16);
      for (var bi = 0; bi < bytes.length; bi += 1) buffer.put(bytes[bi], 8);
      var totalDataCodewords = 0;
      for (var rb = 0; rb < rsBlocks.length; rb += 1) totalDataCodewords += rsBlocks[rb].data;
      if (buffer.bitLength() <= totalDataCodewords * 8) { typeNumber = candidate; break; }
    }
    if (typeNumber === null) throw new Error("TimiQR: text is too long to encode (limit is version 20)");

    var totalDataCodewords = 0;
    for (var rb2 = 0; rb2 < rsBlocks.length; rb2 += 1) totalDataCodewords += rsBlocks[rb2].data;
    if (buffer.bitLength() + 4 <= totalDataCodewords * 8) buffer.put(0, 4);
    while (buffer.bitLength() % 8 !== 0) buffer.putBit(false);
    while (buffer.bitLength() < totalDataCodewords * 8) {
      buffer.put(0xec, 8);
      if (buffer.bitLength() >= totalDataCodewords * 8) break;
      buffer.put(0x11, 8);
    }

    // Split into data/error-correction codewords per block, then interleave.
    var dataBlocks = []; var ecBlocks = [];
    var maxDataCount = 0; var maxEcCount = 0; var offset = 0;
    for (var r = 0; r < rsBlocks.length; r += 1) {
      var dataCount = rsBlocks[r].data;
      var ecCount = rsBlocks[r].total - dataCount;
      maxDataCount = Math.max(maxDataCount, dataCount);
      maxEcCount = Math.max(maxEcCount, ecCount);
      dataBlocks[r] = [];
      for (var i = 0; i < dataCount; i += 1) dataBlocks[r][i] = 0xff & buffer.bytes()[i + offset];
      offset += dataCount;
      var rsPoly = errorCorrectPolynomial(ecCount);
      var remainder = Poly(dataBlocks[r], rsPoly.length - 1).mod(rsPoly);
      ecBlocks[r] = new Array(rsPoly.length - 1);
      for (var j = 0; j < ecBlocks[r].length; j += 1) {
        var mi = j + remainder.length - ecBlocks[r].length;
        ecBlocks[r][j] = mi >= 0 ? remainder.at(mi) : 0;
      }
    }
    var totalCodewords = 0;
    for (var rb3 = 0; rb3 < rsBlocks.length; rb3 += 1) totalCodewords += rsBlocks[rb3].total;
    var codewords = new Array(totalCodewords);
    var ci = 0;
    for (var i2 = 0; i2 < maxDataCount; i2 += 1) {
      for (var r2 = 0; r2 < rsBlocks.length; r2 += 1) {
        if (i2 < dataBlocks[r2].length) { codewords[ci] = dataBlocks[r2][i2]; ci += 1; }
      }
    }
    for (var i3 = 0; i3 < maxEcCount; i3 += 1) {
      for (var r3 = 0; r3 < rsBlocks.length; r3 += 1) {
        if (i3 < ecBlocks[r3].length) { codewords[ci] = ecBlocks[r3][i3]; ci += 1; }
      }
    }

    var moduleCount = typeNumber * 4 + 17;
    var modules = [];
    for (var mr = 0; mr < moduleCount; mr += 1) modules.push(new Array(moduleCount).fill(null));

    function setFinder(row, col) {
      for (var r = -1; r <= 7; r += 1) {
        if (row + r <= -1 || moduleCount <= row + r) continue;
        for (var c = -1; c <= 7; c += 1) {
          if (col + c <= -1 || moduleCount <= col + c) continue;
          modules[row + r][col + c] =
            ((0 <= r && r <= 6 && (c === 0 || c === 6)) ||
             (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
             (2 <= r && r <= 4 && 2 <= c && c <= 4));
        }
      }
    }
    setFinder(0, 0); setFinder(moduleCount - 7, 0); setFinder(0, moduleCount - 7);

    var positions = PATTERN_POSITIONS[typeNumber - 1];
    for (var pi = 0; pi < positions.length; pi += 1) {
      for (var pj = 0; pj < positions.length; pj += 1) {
        var row = positions[pi]; var col = positions[pj];
        if (modules[row][col] !== null) continue;
        for (var ar = -2; ar <= 2; ar += 1) {
          for (var ac = -2; ac <= 2; ac += 1) {
            modules[row + ar][col + ac] = (ar === -2 || ar === 2 || ac === -2 || ac === 2 || (ar === 0 && ac === 0));
          }
        }
      }
    }

    for (var tr = 8; tr < moduleCount - 8; tr += 1) if (modules[tr][6] === null) modules[tr][6] = (tr % 2 === 0);
    for (var tc = 8; tc < moduleCount - 8; tc += 1) if (modules[6][tc] === null) modules[6][tc] = (tc % 2 === 0);

    function writeTypeNumber() {
      if (typeNumber < 7) return;
      var bits = bchTypeNumber(typeNumber);
      for (var i = 0; i < 18; i += 1) {
        var mod = ((bits >> i) & 1) === 1;
        modules[Math.floor(i / 3)][(i % 3) + moduleCount - 8 - 3] = mod;
        modules[(i % 3) + moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    }

    function writeTypeInfo(test, maskPattern) {
      var data = (FORMAT_LEVEL_BITS[level] << 3) | maskPattern;
      var bits = bchTypeInfo(data);
      for (var i = 0; i < 15; i += 1) {
        var mod = (!test && ((bits >> i) & 1) === 1);
        if (i < 6) modules[i][8] = mod;
        else if (i < 8) modules[i + 1][8] = mod;
        else modules[moduleCount - 15 + i][8] = mod;
      }
      for (var j = 0; j < 15; j += 1) {
        var mod2 = (!test && ((bits >> j) & 1) === 1);
        if (j < 8) modules[8][moduleCount - j - 1] = mod2;
        else if (j < 9) modules[8][15 - j - 1 + 1] = mod2;
        else modules[8][15 - j - 1] = mod2;
      }
      modules[moduleCount - 8][8] = !test;
    }

    writeTypeInfo(true, 0);
    writeTypeNumber();

    var reservedModules = modules.map(function (row) { return row.slice(); });

    function mapData(maskPattern) {
      var inc = -1; var row = moduleCount - 1; var bitIndex = 7; var byteIndex = 0;
      var maskFn = MASK_FUNCTIONS[maskPattern];
      for (var col = moduleCount - 1; col > 0; col -= 2) {
        if (col === 6) col -= 1;
        for (;;) {
          for (var c = 0; c < 2; c += 1) {
            if (modules[row][col - c] === null) {
              var dark = false;
              if (byteIndex < codewords.length) dark = (((codewords[byteIndex] >>> bitIndex) & 1) === 1);
              if (maskFn(row, col - c)) dark = !dark;
              modules[row][col - c] = dark;
              bitIndex -= 1;
              if (bitIndex === -1) { byteIndex += 1; bitIndex = 7; }
            }
          }
          row += inc;
          if (row < 0 || moduleCount <= row) { row -= inc; inc = -inc; break; }
        }
      }
    }

    function lostPoint() {
      var lost = 0;
      var dark = function (r, c) { return modules[r][c]; };
      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {
          var same = 0; var isDark = dark(row, col);
          for (var r = -1; r <= 1; r += 1) {
            if (row + r < 0 || moduleCount <= row + r) continue;
            for (var c = -1; c <= 1; c += 1) {
              if (col + c < 0 || moduleCount <= col + c) continue;
              if (r === 0 && c === 0) continue;
              if (isDark === dark(row + r, col + c)) same += 1;
            }
          }
          if (same > 5) lost += 3 + same - 5;
        }
      }
      for (var row2 = 0; row2 < moduleCount - 1; row2 += 1) {
        for (var col2 = 0; col2 < moduleCount - 1; col2 += 1) {
          var count = 0;
          if (dark(row2, col2)) count += 1;
          if (dark(row2 + 1, col2)) count += 1;
          if (dark(row2, col2 + 1)) count += 1;
          if (dark(row2 + 1, col2 + 1)) count += 1;
          if (count === 0 || count === 4) lost += 3;
        }
      }
      for (var row3 = 0; row3 < moduleCount; row3 += 1) {
        for (var col3 = 0; col3 < moduleCount - 6; col3 += 1) {
          if (dark(row3, col3) && !dark(row3, col3 + 1) && dark(row3, col3 + 2) && dark(row3, col3 + 3) &&
              dark(row3, col3 + 4) && !dark(row3, col3 + 5) && dark(row3, col3 + 6)) lost += 40;
        }
      }
      for (var col4 = 0; col4 < moduleCount; col4 += 1) {
        for (var row4 = 0; row4 < moduleCount - 6; row4 += 1) {
          if (dark(row4, col4) && !dark(row4 + 1, col4) && dark(row4 + 2, col4) && dark(row4 + 3, col4) &&
              dark(row4 + 4, col4) && !dark(row4 + 5, col4) && dark(row4 + 6, col4)) lost += 40;
        }
      }
      var darkCount = 0;
      for (var col5 = 0; col5 < moduleCount; col5 += 1) for (var row5 = 0; row5 < moduleCount; row5 += 1) if (dark(row5, col5)) darkCount += 1;
      lost += (Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5) * 10;
      return lost;
    }

    var bestPattern = 0; var bestLost = Infinity;
    for (var mp = 0; mp < 8; mp += 1) {
      for (var rr = 0; rr < moduleCount; rr += 1) modules[rr] = reservedModules[rr].slice();
      writeTypeInfo(true, mp);
      writeTypeNumber();
      mapData(mp);
      var lost = lostPoint();
      if (lost < bestLost) { bestLost = lost; bestPattern = mp; }
    }
    for (var rr2 = 0; rr2 < moduleCount; rr2 += 1) modules[rr2] = reservedModules[rr2].slice();
    writeTypeInfo(false, bestPattern);
    writeTypeNumber();
    mapData(bestPattern);

    return {
      moduleCount: moduleCount,
      isDark: function (row, col) { return modules[row][col]; }
    };
  }

  /**
   * Renders `text` as an inline SVG QR code inside `container` (an existing
   * DOM element — its previous content is cleared). Options: `level`
   * ("L"|"M"|"Q"|"H", default "M"), `moduleSize` (px per module, default 4),
   * `margin` (modules of quiet zone, default 4), `dark`/`light` (module
   * colors, default "#111B3B"/"#FFFAF0" — Tími's ink and paper tokens).
   *
   * Built entirely with DOM APIs (createElementNS/setAttribute) rather than
   * innerHTML — the SVG path data is composed only from integers this
   * function computes itself, never from the input text.
   */
  function renderInto(container, text, options) {
    var opts = options || {};
    var level = opts.level || "M";
    var moduleSize = opts.moduleSize || 4;
    var margin = opts.margin === undefined ? 4 : opts.margin;
    var dark = opts.dark || "#111B3B";
    var light = opts.light || "#FFFAF0";

    var code = encode(text, level);
    var size = code.moduleCount * moduleSize + margin * 2 * moduleSize;

    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "QR code linking to the Tími referral page");

    var background = document.createElementNS(svgNS, "rect");
    background.setAttribute("width", "100%");
    background.setAttribute("height", "100%");
    background.setAttribute("fill", light);
    svg.appendChild(background);

    var path = document.createElementNS(svgNS, "path");
    var d = "";
    for (var row = 0; row < code.moduleCount; row += 1) {
      for (var col = 0; col < code.moduleCount; col += 1) {
        if (!code.isDark(row, col)) continue;
        var x = col * moduleSize + margin * moduleSize;
        var y = row * moduleSize + margin * moduleSize;
        d += "M" + x + "," + y + "h" + moduleSize + "v" + moduleSize + "h-" + moduleSize + "z";
      }
    }
    path.setAttribute("d", d);
    path.setAttribute("fill", dark);
    svg.appendChild(path);

    container.textContent = "";
    container.appendChild(svg);
    return svg;
  }

  global.TimiQR = { encode: encode, renderInto: renderInto };
})(typeof window !== "undefined" ? window : this);
