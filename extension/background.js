'use strict';

const ENDPOINT = 'http://localhost:3000';

async function postCaption(payload) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let responseText = '';
    try {
      responseText = await response.text();
    } catch (_error) {
      responseText = '';
    }

    return {
      ok: false,
      status: response.status,
      error: responseText ? `HTTP ${response.status}: ${responseText}` : `HTTP ${response.status}`
    };
  }

  return {
    ok: true,
    status: response.status
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'sendCaptionPayload') {
    return;
  }

  postCaption(message.payload)
    .then((result) => {
      sendResponse(result);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});
