// Shared helpers for scene pages. Each scene defines window.build = D => paused gsap timeline.
window.params = (() => {
  try {
    return JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
  } catch {
    return {};
  }
})();

// A slow, continuous drift for background glows so no frame is ever static.
window.drift = (tl, D) => {
  document.querySelectorAll('.glow').forEach((g, i) => {
    tl.fromTo(g, { x: -40 + i * 30, y: 20 - i * 25, scale: 1 }, { x: 60 - i * 40, y: -30 + i * 20, scale: 1.12, duration: D, ease: 'sine.inOut' }, 0);
  });
};

// Fade everything out over the last `t` seconds (scenes end clean for crossfades).
window.outro = (tl, D, t = 0.6, sel = '.content') => {
  tl.to(sel, { opacity: 0, y: -20, duration: t, ease: 'power2.in' }, Math.max(0, D - t));
};
