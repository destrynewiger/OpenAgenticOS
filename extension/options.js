const DEFAULTS = { apiBase: 'http://localhost:4100', autoOpenLinkedIn: false };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (v) => {
  $('apiBase').value = v.apiBase || DEFAULTS.apiBase;
  $('autoOpenLinkedIn').checked = !!v.autoOpenLinkedIn;
});

$('save').addEventListener('click', () => {
  const apiBase = $('apiBase').value.trim().replace(/\/+$/, '') || DEFAULTS.apiBase;
  chrome.storage.sync.set({ apiBase, autoOpenLinkedIn: $('autoOpenLinkedIn').checked }, () => {
    $('saved').textContent = 'Saved';
    setTimeout(() => { $('saved').textContent = ''; }, 1500);
  });
});
