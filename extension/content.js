// OpenAgenticOS Call Cockpit — detector. Runs on dialer surfaces (Google
// Sheets / Apollo / supported dialers) and relays the phone number currently being
// dialed to the side panel (via the background worker). No UI of its own — the
// cockpit lives in the Chrome side panel. Phone is the most stable signal of
// "who's on the line right now". When auto-detect can't read the dialer (e.g.
// canvas-rendered Sheets), the side panel's manual search / a selected phone
// number are the fallbacks.
(() => {
  const digits = (s) => String(s || '').replace(/\D/g, '');
  let last = '';

  function phoneFromText(text) {
    const m = String(text || '').match(/\+?\d[\d\s().-]{8,}\d/);
    if (!m) return '';
    const d = digits(m[0]);
    return d.length >= 10 && d.length <= 15 ? d : '';
  }
  function relay(phone) {
    if (!phone || phone === last) return;
    last = phone;
    try { chrome.runtime.sendMessage({ type: 'dialing', phone }); } catch {}
  }

  const CANDIDATE_SEL = 'a[href^="tel:"], [class*="trellus" i], [id*="trellus" i], [class*="dialer" i], [id*="dialer" i]';
  function detect() {
    const tels = [...document.querySelectorAll('a[href^="tel:"]')]
      .map((a) => digits(a.getAttribute('href'))).filter((d) => d.length >= 10);
    if (tels.length) return tels[tels.length - 1];
    for (const el of document.querySelectorAll(CANDIDATE_SEL)) {
      const p = phoneFromText(el.textContent);
      if (p) return p;
    }
    return '';
  }

  // Selected phone number → load it (works in canvas-rendered Sheets).
  document.addEventListener('mouseup', () => {
    const p = phoneFromText(String(window.getSelection?.() || ''));
    if (p) relay(p);
  });

  setInterval(() => relay(detect()), 2000);
  relay(detect());
})();
