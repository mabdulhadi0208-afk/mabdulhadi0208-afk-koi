// Koi's jelly springs for the panels: toned down, lively, and asleep when nothing moves (the rAF loop stops the
// moment every spring has settled, and starts again on the next change). Springs only drive transform and opacity.
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
    constructor(x, k = 240, c = 15, cb) { this.x = x; this.v = 0; this.t = x; this.k = k; this.c = c; this.cb = cb; }
    set(t) { this.t = t; wake(this); return this; }
    kick(v) { this.v += v; wake(this); return this; }
    jump(x) { this.x = this.t = x; this.v = 0; live.delete(this); this.cb && this.cb(this); return this; }
  }
  // hover lift and press squish on any element (transform only)
  function jelly(el, hov = 1.04, tx = 0) {
    const s = new Sp(1, 300, 13), x = new Sp(0, 300, 13), q = new Sp(0, 300, 12);
    const ap = () => { el.style.transform = `translateX(${x.x}px) scale(${s.x * (1 + q.x * .035)},${s.x * (1 - q.x * .035)})`; };
    s.cb = x.cb = q.cb = ap;
    el.addEventListener('pointerenter', () => { s.set(hov); x.set(tx); q.kick(2); });
    el.addEventListener('pointerleave', () => { s.set(1); x.set(0); });
    el.addEventListener('pointerdown', () => { s.set(.95); q.kick(-4); });
    el.addEventListener('pointerup', () => { s.set(hov); q.kick(5); });
  }
  window.KoiSpring = { Sp, jelly, busy: () => live.size };
})();
// the Koi mark: five petals (amber, pink, deep pink, violet, cyan) on a hub; line=true draws the watermark outline
window.KoiMark = (sz, line = false, white = false) => {
  const P = 'M60 92 C47 72 47 40 60 18 C73 40 73 72 60 92Z', A = [-64, -32, 0, 32, 64], id = 'k' + Math.random().toString(36).slice(2, 7);
  const C = [['#ffd36b', '#ff8a1f'], ['#ff7ab8', '#ff2e88'], ['#ff5aa2', '#c40f66'], ['#b48cff', '#7a3cff'], ['#7fe3ff', '#1690ff']];
  if (line) return `<svg width="${sz}" height="${sz}" viewBox="0 0 120 120">${A.map(a => `<path d="${P}" transform="rotate(${a} 60 92)"/>`).join('')}<circle cx="60" cy="92" r="10"/></svg>`;
  if (white) return `<svg width="${sz}" height="${sz}" viewBox="0 0 120 120" fill="#fff">${A.map((a, i) => `<path d="${P}" transform="rotate(${a} 60 92)" opacity="${[.75, .9, 1, .9, .75][i]}"/>`).join('')}<circle cx="60" cy="92" r="11"/></svg>`;
  return `<svg width="${sz}" height="${sz}" viewBox="0 0 120 120"><defs>${C.map((c, i) => `<linearGradient id="${id}${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient>`).join('')}</defs>${A.map((a, i) => `<path d="${P}" transform="rotate(${a} 60 92)" fill="url(#${id}${i})"/>`).join('')}<circle cx="60" cy="92" r="11" fill="#fff"/><circle cx="60" cy="92" r="5.5" fill="#ff2e88"/></svg>`;
};
// the hero banner decoration layers (wash, light pool, beam, horizon, rim, sheen and a giant watermark)
window.KoiHero = el => { const d = document.createElement('div'); d.className = 'dc'; d.innerHTML = `<i class="w"></i><i class="p"></i><i class="b"></i><i class="m">${KoiMark('100%', true)}</i><i class="h"></i><i class="r"></i><i class="s"></i>`; el.prepend(d); };
