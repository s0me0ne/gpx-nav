(() => {
  const C = NavCore;
  const $ = (id) => document.getElementById(id);

  // ---------- Mapa ----------
  const map = L.map('map', { zoomControl: false }).setView([38.72, -9.14], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);

  let route = null, routeName = '';
  let routeLine = null, doneLine = null, startM = null, endM = null, backLine = null;
  let userM = null, accC = null;
  let follow = true;

  // ---------- Estado de navegação ----------
  let watchId = null, simTimer = null, running = false;
  let hint = null, lastAlong = 0;
  let offCount = 0, offActive = false, lastOffSpeak = 0;
  let announced = new Set();
  let lastFix = null, speedAvg = 0, simSpeed = 14; // m/s na simulação (~50 km/h)
  let voiceOn = true, wakeLock = null;

  // ---------- Voz ----------
  function speak(text) {
    if (!voiceOn || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-PT';
    const v = speechSynthesis.getVoices().find(x => x.lang === 'pt-PT') ||
              speechSynthesis.getVoices().find(x => x.lang.startsWith('pt'));
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
  function buzz(p) { if (navigator.vibrate) navigator.vibrate(p); }

  $('voice').onclick = () => {
    voiceOn = !voiceOn;
    $('voice').classList.toggle('on', voiceOn);
    $('voice').textContent = voiceOn ? '🔊 Voz' : '🔇 Voz';
  };

  // ---------- GPX ----------
  function parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Ficheiro GPX inválido');
    let nodes = [...doc.getElementsByTagName('trkpt')];
    if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
    if (!nodes.length) nodes = [...doc.getElementsByTagName('wpt')];
    const pts = nodes.map(n => ({ lat: +n.getAttribute('lat'), lon: +n.getAttribute('lon') }))
                     .filter(p => isFinite(p.lat) && isFinite(p.lon));
    if (pts.length < 2) throw new Error('O GPX não tem pontos suficientes');
    const nm = doc.querySelector('trk > name, rte > name, metadata > name');
    return { pts, name: nm ? nm.textContent.trim() : '' };
  }

  function loadRoute(text, save = true) {
    const g = parseGPX(text);
    stop();
    route = C.buildRoute(g.pts);
    routeName = g.name;
    if (save) { try { localStorage.setItem('gpx', text); } catch (e) {} }

    [routeLine, doneLine, startM, endM, backLine].forEach(l => l && map.removeLayer(l));
    const ll = route.pts.map(p => [p.lat, p.lon]);
    routeLine = L.polyline(ll, { color: '#2563eb', weight: 7, opacity: .85 }).addTo(map);
    doneLine = L.polyline([], { color: '#94a3b8', weight: 7, opacity: .9 }).addTo(map);
    startM = L.circleMarker(ll[0], { radius: 8, color: '#fff', fillColor: '#16a34a', fillOpacity: 1, weight: 3 }).addTo(map);
    endM = L.circleMarker(ll[ll.length - 1], { radius: 8, color: '#fff', fillColor: '#dc2626', fillOpacity: 1, weight: 3 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [60, 60] });

    hint = null; lastAlong = 0; announced = new Set(); offCount = 0; offActive = false;
    $('go').disabled = false; $('sim').disabled = false; $('gmaps').disabled = false;
    $('arrow').textContent = '⬆';
    $('instr').textContent = routeName || 'Percurso carregado';
    $('sub').textContent = C.fmtDist(route.total) + ' · ' + (route.turns.length - 1) + ' curvas';
    $('sRem').textContent = C.fmtDist(route.total);
    $('bar').style.width = '0%';
  }

  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { loadRoute(await f.text()); }
    catch (err) { alert(err.message); }
    e.target.value = '';
  });

  // ---------- Posição ----------
  function setUser(pos, acc, heading) {
    const html = '<div class="user"></div>';
    if (!userM) {
      userM = L.marker([pos.lat, pos.lon], {
        icon: L.divIcon({ className: '', html, iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 1000
      }).addTo(map);
      accC = L.circle([pos.lat, pos.lon], { radius: acc || 10, color: '#2563eb', weight: 1, fillOpacity: .1 }).addTo(map);
    } else {
      userM.setLatLng([pos.lat, pos.lon]);
      accC.setLatLng([pos.lat, pos.lon]).setRadius(acc || 10);
    }
    if (follow) map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 17), { animate: true });
  }

  function onFix(lat, lon, acc, speed, heading, ts) {
    const pos = { lat, lon };
    // velocidade (do GPS ou calculada)
    let v = speed;
    if ((v == null || isNaN(v)) && lastFix) {
      const dt = (ts - lastFix.ts) / 1000;
      if (dt > 0) v = C.dist(lastFix, pos) / dt;
    }
    lastFix = { lat, lon, ts };
    if (v != null && !isNaN(v)) speedAvg = speedAvg ? speedAvg * 0.8 + v * 0.2 : v;

    setUser(pos, acc, heading);
    if (!route) return;

    const pr = C.project(route, pos, hint);
    if (!pr) return;
    hint = pr.i;
    // não deixa o progresso recuar por ruído de GPS (mas permite se estiver mesmo longe)
    const along = pr.off < 60 ? Math.max(pr.along, lastAlong - 15) : lastAlong;
    if (pr.off < 60) lastAlong = Math.max(lastAlong, pr.along);

    const rem = Math.max(0, route.total - lastAlong);
    $('sRem').textContent = C.fmtDist(rem);
    $('sSpd').textContent = v != null && !isNaN(v) ? Math.round(speedAvg * 3.6) : '–';
    $('sOff').textContent = Math.round(pr.off) + ' m';
    $('bar').style.width = Math.min(100, lastAlong / route.total * 100) + '%';
    if (speedAvg > 0.7) {
      const eta = new Date(Date.now() + rem / speedAvg * 1000);
      $('sEta').textContent = eta.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
    }
    const cut = Math.max(1, Math.floor(pr.i + 1));
    doneLine.setLatLngs(route.pts.slice(0, cut).map(p => [p.lat, p.lon]).concat([[pr.point.lat, pr.point.lon]]));

    // ---- Desvio do percurso ----
    const limit = Math.max(30, (acc || 0) * 1.5);
    if (pr.off > limit) offCount++; else { offCount = 0; }
    if (offCount >= 3) {
      const now = Date.now();
      if (!offActive || now - lastOffSpeak > 20000) {
        speak('Saiu do percurso. Está a ' + Math.round(pr.off / 10) * 10 + ' metros do traço.');
        buzz([300, 100, 300]);
        lastOffSpeak = now;
      }
      offActive = true;
      $('top').classList.add('alert');
      $('arrow').textContent = '⚠';
      $('instr').textContent = 'Fora do percurso';
      $('sub').textContent = 'Siga a linha tracejada para voltar';
      if (backLine) backLine.setLatLngs([[lat, lon], [pr.point.lat, pr.point.lon]]);
      else backLine = L.polyline([[lat, lon], [pr.point.lat, pr.point.lon]], { color: '#dc2626', weight: 4, dashArray: '8 8' }).addTo(map);
      return;
    }
    if (offActive && offCount === 0) {
      offActive = false;
      speak('De volta ao percurso.');
      $('top').classList.remove('alert');
      if (backLine) { map.removeLayer(backLine); backLine = null; }
    }
    if (offActive) return;

    // ---- Próxima instrução ----
    const t = C.nextTurn(route, lastAlong);
    if (t) {
      const dt = t.d - lastAlong;
      $('arrow').textContent = C.ARROW[t.type];
      $('instr').textContent = (t.type === 'end' ? 'Destino' : C.TEXT[t.type][0].toUpperCase() + C.TEXT[t.type].slice(1)) + ' em ' + C.fmtDist(dt);
      $('sub').textContent = routeName;
      for (const th of [300, 100, 30]) {
        const key = t.i + ':' + th;
        if (dt <= th && dt > th - 60 && !announced.has(key)) {
          // marca como anunciados os limiares maiores para não repetir
          for (const x of [300, 100, 30]) if (x >= th) announced.add(t.i + ':' + x);
          if (t.type === 'end') speak(th === 30 ? 'Chegou ao destino.' : 'Destino em ' + th + ' metros.');
          else speak(th === 30 ? 'Agora, ' + C.TEXT[t.type] + '.' : 'Em ' + th + ' metros, ' + C.TEXT[t.type] + '.');
          buzz(120);
          break;
        }
      }
      if (t.type === 'end' && dt < 20) finish();
    } else finish();
  }

  function finish() {
    if (!running) return;
    speak('Chegou ao destino. Percurso concluído.');
    stop();
    $('arrow').textContent = '⚑';
    $('instr').textContent = 'Percurso concluído';
    $('sub').textContent = routeName;
  }

  // ---------- GPS real ----------
  async function lockScreen() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') lockScreen(); });

  function start() {
    if (!route) return;
    if (!('geolocation' in navigator)) { alert('Este dispositivo não suporta geolocalização.'); return; }
    if (!window.isSecureContext) { alert('O GPS só funciona em HTTPS (ou localhost).'); return; }
    stop(); running = true; follow = true; $('recenter').style.display = 'none';
    announced = new Set(); lastAlong = 0; hint = null; speedAvg = 0;
    $('go').textContent = 'Parar'; $('go').classList.add('on');
    $('sub').textContent = 'A obter sinal GPS…';
    lockScreen();
    speak('Navegação iniciada.');
    watchId = navigator.geolocation.watchPosition(
      (p) => onFix(p.coords.latitude, p.coords.longitude, p.coords.accuracy, p.coords.speed, p.coords.heading, p.timestamp),
      (err) => {
        const m = { 1: 'Permissão de localização negada. Ative-a nas definições do browser.', 2: 'Posição indisponível.', 3: 'Tempo esgotado a obter o GPS.' };
        $('sub').textContent = m[err.code] || err.message;
        if (err.code === 1) stop();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  function stop() {
    running = false;
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('go').textContent = 'Iniciar'; $('go').classList.remove('on');
    $('sim').textContent = 'Simular'; $('sim').classList.remove('on');
    speechSynthesis && speechSynthesis.cancel();
  }

  $('go').onclick = () => (running ? stop() : start());

  // ---------- Simulação (testar sem sair de casa) ----------
  function simulate() {
    if (!route) return;
    stop(); running = true; follow = true;
    announced = new Set(); lastAlong = 0; hint = null; speedAvg = 0;
    $('sim').textContent = 'Parar sim.'; $('sim').classList.add('on');
    let d = 0, tick = 0;
    simTimer = setInterval(() => {
      d += simSpeed; tick++;
      if (d >= route.total) d = route.total;
      let i = 0; while (i < route.cum.length - 2 && route.cum[i + 1] < d) i++;
      const t = (d - route.cum[i]) / ((route.cum[i + 1] - route.cum[i]) || 1);
      let lat = route.pts[i].lat + t * (route.pts[i + 1].lat - route.pts[i].lat);
      let lon = route.pts[i].lon + t * (route.pts[i + 1].lon - route.pts[i].lon);
      // desvio simulado: entre os ticks 25 e 32 sai ~60 m do traço
      if (tick >= 25 && tick <= 32) lat += 0.00055;
      onFix(lat, lon, 8, simSpeed, null, Date.now());
    }, 1000);
  }
  $('sim').onclick = () => (simTimer ? stop() : simulate());

  // ---------- Google Maps ----------
  // O Google Maps recalcula a rota por estradas entre os pontos; não segue o traço GPX ao metro.
  $('gmaps').onclick = () => {
    if (!route) return;
    const here = !!(running && lastFix); // a navegar: parte da posição atual e só os pontos à frente
    const url = C.mapsUrl(route, $('mode').value, here ? lastAlong : 0, here);
    if (url) window.open(url, '_blank');
  };

  // ---------- Seguir / centrar ----------
  map.on('dragstart', () => { follow = false; $('recenter').style.display = 'block'; });
  $('recenter').onclick = () => {
    follow = true; $('recenter').style.display = 'none';
    if (userM) map.setView(userM.getLatLng(), Math.max(map.getZoom(), 17));
  };

  // ---------- Arranque ----------
  try { const s = localStorage.getItem('gpx'); if (s) loadRoute(s, false); } catch (e) {}
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
