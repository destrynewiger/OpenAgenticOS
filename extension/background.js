// Service worker: opens the side panel on toolbar-icon click, relays the
// "currently dialing" phone from content scripts to the side panel, remembers
// the last one (so the panel can catch up when it opens), and opens LinkedIn
// tabs on request.
let lastDialing = null; // { phone, at }

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});
// Also set on worker startup (onInstalled doesn't fire on every load).
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'dialing' && msg.phone) {
    lastDialing = { phone: msg.phone, at: Date.now() };
    chrome.runtime.sendMessage({ type: 'dialing', phone: msg.phone }).catch(() => {});
  } else if (msg.type === 'getLast') {
    sendResponse(lastDialing);
    return true;
  } else if (msg.type === 'open' && msg.url) {
    chrome.tabs.create({ url: msg.url, active: false });
  }
});
