// Koi's springs, tuned like Lumen's (ui/spring.js: jelly = stiffness 300, damping 22), asleep when nothing moves:
// the rAF loop stops the moment every spring has settled. Springs only drive transform and opacity.
(function () {
  const live = new Set(); let raf = 0, last = 0;
  function loop(now) {
    raf = 0; const dt = Math.min(.033, Math.max(.004, (now - last) / 1000)); last = now;
    for (const s of live) {
      s.v += ((s.t - s.x) * s.k - s.v * s.c) * dt; s.x += s.v * dt;
      if (Math.abs(s.v) < .03 && Math.abs(s.t - s.x) < .004) { s.x = s.t; s.v = 0; live.delete(s); }
      s.cb && s.cb(s);
    }
    if (live.size) raf = requestAnimationFrame(loop);
  }
  const wake = s => { live.add(s); if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  class Sp {
    constructor(x, k = 300, c = 22, cb) { this.x = x; this.v = 0; this.t = x; this.k = k; this.c = c; this.cb = cb; }
    set(t) { this.t = t; wake(this); return this; }
    kick(v) { this.v += v; wake(this); return this; }
    jump(x) { this.x = this.t = x; this.v = 0; live.delete(this); this.cb && this.cb(this); return this; }
  }
  // Lumen's Jelly: hover lifts 1-2px, presses squish to ~0.96 (transform only)
  function jelly(el, hov = 1.03, lift = -1) {
    const s = new Sp(1, 300, 22), y = new Sp(0, 300, 22), q = new Sp(0, 380, 21.4);
    const ap = () => { el.style.transform = `translateY(${y.x}px) scale(${s.x * (1 + q.x * .03)},${s.x * (1 - q.x * .03)})`; };
    s.cb = y.cb = q.cb = ap;
    el.addEventListener('pointerenter', () => { s.set(hov); y.set(lift); });
    el.addEventListener('pointerleave', () => { s.set(1); y.set(0); });
    el.addEventListener('pointerdown', () => { s.set(.96); q.kick(-3); });
    el.addEventListener('pointerup', () => { s.set(hov); q.kick(4); });
  }
  window.KoiSpring = { Sp, jelly, busy: () => live.size };
})();
// the Koi mark: five petals on a hub, in Lumen's palette (cyan, the accent, violet, pink, amber); line = watermark outline
window.KoiMark = (sz, line = false, white = false) => {
  const P = 'M60 92 C47 72 47 40 60 18 C73 40 73 72 60 92Z', A = [-64, -32, 0, 32, 64], id = 'k' + Math.random().toString(36).slice(2, 7);
  const C = [['#7fe6ee', '#13c1cd'], ['#8fb0ff', '#5b8cff'], ['#c89bf2', '#a66be3'], ['#ff9cc0', '#f4679b'], ['#ffd2a8', '#fdb173']];
  if (line) return `<svg width="${sz}" height="${sz}" viewBox="0 0 120 120">${A.map(a => `<path d="${P}" transform="rotate(${a} 60 92)"/>`).join('')}<circle cx="60" cy="92" r="10"/></svg>`;
  if (white) return `<svg width="${sz}" height="${sz}" viewBox="0 0 120 120" fill="#fff">${A.map((a, i) => `<path d="${P}" transform="rotate(${a} 60 92)" opacity="${[.75, .9, 1, .9, .75][i]}"/>`).join('')}<circle cx="60" cy="92" r="11"/></svg>`;
  return `<svg width="${sz}" height="${sz}" viewBox="0 0 120 120" fill="none"><defs>${C.map((c, i) => `<linearGradient id="${id}${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient>`).join('')}</defs>${A.map((a, i) => `<path d="${P}" transform="rotate(${a} 60 92)" fill="url(#${id}${i})"/>`).join('')}<circle cx="60" cy="92" r="11" fill="#fff"/><circle cx="60" cy="92" r="5.5" fill="#5b8cff"/></svg>`;
};
// Lumen's hero lights (pages/app.js heroBack): four light pools, seeded drifting dots with a faint constellation,
// grain, a rim glint and a giant three-layer watermark glyph. The dots pause when the hero is off screen or the
// window is hidden (IntersectionObserver + visibilitychange), exactly as in Lumen.
(function () {
  function dots(seed) {
    let h = 2166136261; for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
    const layer = sets => { const img = [], size = [], pos = [];
      for (const [n, tile, r, col] of sets) { const th = Math.round(tile * (.8 + rnd() * .4)), px = Math.round(rnd() * tile), py = Math.round(rnd() * th);
        for (let i = 0; i < n; i++) { img.push(`radial-gradient(circle at ${(rnd() * 100).toFixed(1)}% ${(rnd() * 100).toFixed(1)}%, ${col} ${r}px, transparent ${r + 1.2}px)`); size.push(`${tile}px ${th}px`); pos.push(`${px}px ${py}px`); } }
      return `background-image:${img.join(',')};background-size:${size.join(',')};background-position:${pos.join(',')}`; };
    const svg = x => `url('data:image/svg+xml,${encodeURIComponent(x)}')`;
    const star = (x, y, r) => `M${x} ${(y - r).toFixed(1)}Q${x} ${y} ${(x + r).toFixed(1)} ${y}Q${x} ${y} ${x} ${(y + r).toFixed(1)}Q${x} ${y} ${(x - r).toFixed(1)} ${y}Q${x} ${y} ${x} ${(y - r).toFixed(1)}Z`;
    let sp = '', specks = '';
    for (let i = 0; i < 3; i++) sp += star(Math.round(20 + rnd() * 340), Math.round(20 + rnd() * 260), 3.5 + rnd() * 4);
    for (let i = 0; i < 4; i++) { const x = Math.round(10 + rnd() * 360), y = Math.round(10 + rnd() * 280); specks += `<circle cx="${x}" cy="${y}" r="5" fill="white" fill-opacity=".12"/><circle cx="${x}" cy="${y}" r="1.7" fill="white"/>`; }
    const bright = `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="300">${specks}<path d="${sp}" fill="white"/></svg>`;
    const pts = []; for (let i = 0; i < 6; i++) pts.push([Math.round(480 + rnd() * 470), Math.round(40 + rnd() * 240)]); pts.sort((a, b) => a[0] - b[0]);
    const cons = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 320" preserveAspectRatio="xMidYMid slice"><path d="M${pts.map(q => q.join(' ')).join('L')}" fill="none" stroke="white" stroke-opacity=".24" stroke-width=".9" stroke-dasharray="2 4"/>${pts.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 ? 1.5 : 2.4}" fill="white" fill-opacity="${i % 3 ? .5 : .85}"/>`).join('')}</svg>`;
    return `<span class="dots"><b class="cons" style="background-image:${svg(cons)}"></b><i class="hd1" style="${layer([[9, 150 + Math.round(rnd() * 40), 1, 'var(--hd1)'], [6, 210 + Math.round(rnd() * 60), 1.4, 'var(--hd2)']])}"></i><i class="hd3" style="background-image:${svg(bright)};background-size:380px 300px;background-position:${Math.round(rnd() * 380)}px ${Math.round(rnd() * 300)}px"></i></span>`;
  }
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle('dots-off', !e.isIntersecting))) : null;
  // like Lumen: the dots also stop when Koi is not the active app (the window lost focus)
  const vis = () => document.documentElement.classList.toggle('lm-hidden', document.hidden || !document.hasFocus());
  document.addEventListener('visibilitychange', vis); addEventListener('blur', vis); addEventListener('focus', vis); vis();
  // el: the .hero element; glyph: the svg markup for the watermark; seed: per-section pattern; withDots: the drifting layers
  window.KoiHero = (el, glyph, seed = 'koi', withDots = true) => {
    const b = document.createElement('span'); b.className = 'hb'; b.setAttribute('aria-hidden', 'true');
    b.innerHTML = `<i class="orb a"></i><i class="orb b"></i><i class="orb c"></i><i class="orb d"></i>${withDots ? dots(seed) : ''}<i class="grain"></i><span class="art glow">${glyph}</span><span class="art depth">${glyph}</span><span class="art">${glyph}</span><i class="glint"></i>`;
    el.prepend(b); if (withDots && io) io.observe(el);
    el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
  };
  window.KoiGlyph = { mark: () => KoiMark('100%', true) };
})();
