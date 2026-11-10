// Núcleo de navegação: sem dependências do browser (testável em Node).
(function (root) {
  const R = 6371000, D = Math.PI / 180;

  function dist(a, b) {
    const dLat = (b.lat - a.lat) * D, dLon = (b.lon - a.lon) * D;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function bearing(a, b) {
    const y = Math.sin((b.lon - a.lon) * D) * Math.cos(b.lat * D);
    const x = Math.cos(a.lat * D) * Math.sin(b.lat * D) -
      Math.sin(a.lat * D) * Math.cos(b.lat * D) * Math.cos((b.lon - a.lon) * D);
    return (Math.atan2(y, x) / D + 360) % 360;
  }

  function angDiff(a, b) {
    let d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  function buildRoute(points) {
    const pts = [];
    for (const p of points) {
      if (!pts.length || dist(pts[pts.length - 1], p) >= 2) pts.push({ lat: p.lat, lon: p.lon });
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1] || 0;
    const turns = detectTurns(pts, cum);
    if (pts.length > 1) turns.push({ d: total, type: 'end', delta: 0, i: pts.length - 1 });
    return { pts, cum, total, turns };
  }

  // Deteta curvas pela variação de rumo numa janela de ~25 m antes/depois de cada vértice.
  function detectTurns(pts, cum) {
    const L = 25, MIN = 35, GAP = 40;
    const turns = [];
    const deltaAt = (i) => {
      let b = i; while (b > 0 && cum[i] - cum[b] < L) b--;
      let f = i; while (f < pts.length - 1 && cum[f] - cum[i] < L) f++;
      if (b === i || f === i) return 0;
      return angDiff(bearing(pts[b], pts[i]), bearing(pts[i], pts[f]));
    };
    let lastD = -1e9;
    for (let i = 1; i < pts.length - 1; i++) {
      if (cum[i] - lastD < GAP) continue;
      const d = deltaAt(i);
      if (Math.abs(d) < MIN) continue;
      // pico dentro dos próximos 30 m
      let bestI = i, bestD = d;
      for (let j = i + 1; j < pts.length - 1 && cum[j] - cum[i] < 30; j++) {
        const dj = deltaAt(j);
        if (Math.abs(dj) > Math.abs(bestD)) { bestD = dj; bestI = j; }
      }
      turns.push({ d: cum[bestI], i: bestI, delta: bestD, type: turnType(bestD) });
      lastD = cum[bestI];
    }
    return turns;
  }

  function turnType(delta) {
    const side = delta > 0 ? 'right' : 'left';
    const a = Math.abs(delta);
    if (a < 60) return 'slight-' + side;
    if (a < 130) return side;
    return 'sharp-' + side;
  }

  const TEXT = {
    'slight-left': 'vire ligeiramente à esquerda',
    'slight-right': 'vire ligeiramente à direita',
    'left': 'vire à esquerda',
    'right': 'vire à direita',
    'sharp-left': 'curva fechada à esquerda',
    'sharp-right': 'curva fechada à direita',
    'end': 'chegou ao destino',
  };
  const ARROW = {
    'slight-left': '↖', 'slight-right': '↗', 'left': '←', 'right': '→',
    'sharp-left': '↙', 'sharp-right': '↘', 'end': '⚑',
  };

  function segProj(route, i, pos) {
    const a = route.pts[i], b = route.pts[i + 1];
    const m = R * D, k = Math.cos(pos.lat * D) * m;
    const ax = (a.lon - pos.lon) * k, ay = (a.lat - pos.lat) * m;
    const bx = (b.lon - pos.lon) * k, by = (b.lat - pos.lat) * m;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? (-ax * dx - ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    return {
      i, t, off: Math.hypot(px, py),
      along: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]),
      point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) },
    };
  }

  // Projeta a posição no percurso. 'hint' = índice do último segmento conhecido
  // (evita saltar para outro troço quando o percurso se cruza ou sobrepõe).
  function project(route, pos, hint) {
    const n = route.pts.length;
    if (n < 2) return null;
    const scan = (a, b) => {
      let best = null;
      for (let i = a; i < Math.min(b, n - 1); i++) {
        const r = segProj(route, i, pos);
        if (!best || r.off < best.off) best = r;
      }
      return best;
    };
    let best = null;
    if (hint != null) best = scan(Math.max(0, hint - 5), hint + 300);
    if (!best || best.off > 60) {
      const full = scan(0, n - 1);
      if (!best || full.off < best.off) best = full;
    }
    return best;
  }

  function nextTurn(route, along) {
    for (const t of route.turns) if (t.d > along + 5) return t;
    return null;
  }

  function fmtDist(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',') + ' km';
  }

  const api = { dist, bearing, angDiff, buildRoute, project, nextTurn, fmtDist, TEXT, ARROW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NavCore = api;
})(typeof self !== 'undefined' ? self : this);
