chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      serverUrl: 'http://127.0.0.1:58031',
      token: 'trail_95d866ec7ac5629017d08aa0e3ff312aee6a6f145a2c5cff4414f0efddf5e288',
    })
  }
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getConfig') {
    chrome.storage.local.get(['serverUrl', 'token'], (result) => {
      sendResponse(result)
    })
    return true
  }

  if (message.action === 'setConfig') {
    chrome.storage.local.set(message.config, () => {
      sendResponse({ ok: true })
    })
    return true
  }
})
