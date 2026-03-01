(() => {
  'use strict';

  const CONFIG = {
    endpoint: 'http://localhost:3000',
    finalizeIdleMs: 1500,
    scanIntervalMs: 1000,
    autoEnableCaptions: true,
    rowSelectors: [
      '.nMcdL.bj4p3b',
      '.nMcdL'
    ],
    speakerSelectors: [
      '.NWpY1d',
      '[class*="NWpY1d"]'
    ],
    textSelectors: [
      '.ygicle',
      '[class*="ygicle"]'
    ],
    captionsOnLabelParts: [
      '字幕をオンにする',
      'Turn on captions'
    ],
    captionsOffLabelParts: [
      '字幕をオフにする',
      'Turn off captions'
    ],
    selfSpeakerLabels: [
      'あなた',
      'you'
    ],
    selfDisplayNameOverride: '',
    selfNameCacheTtlMs: 30000,
    selfNameRetryTtlMs: 10000
  };

  const rowTrackerMap = new Map();
  let rowSequence = 0;
  let autoCaptionEnabled = false;
  let autoCaptionAttemptInFlight = false;
  let lastAutoCaptionAttemptAt = 0;
  let lastCaptionControlScanAt = 0;
  let selfDisplayNameCache = '';
  let selfDisplayNameFetchedAt = 0;
  let selfDisplayNameLookupFailedAt = 0;

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function splitCaptionLines(value) {
    return (value || '')
      .split(/\r?\n/)
      .map((line) => normalizeText(line))
      .filter(Boolean);
  }

  function isSameLines(a, b) {
    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }

    return true;
  }

  function getFirstMatch(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) {
        return node;
      }
    }

    return null;
  }

  function extractCaptionData(row) {
    const speakerNode = getFirstMatch(row, CONFIG.speakerSelectors);
    const textNode = getFirstMatch(row, CONFIG.textSelectors);

    const speaker = normalizeSpeakerName(
      normalizeText(speakerNode ? speakerNode.textContent : '')
    );
    const lines = splitCaptionLines(textNode ? textNode.textContent : '');

    return { speaker, lines };
  }

  function stripTrailingSelfTag(name) {
    return normalizeText(name)
      .replace(/\s*[（(]\s*(あなた|you)\s*[）)]\s*$/i, '')
      .trim();
  }

  function isLikelyEmail(value) {
    const text = normalizeText(value);
    if (!text) {
      return false;
    }
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  }

  function isLikelyDisplayName(value) {
    const text = stripTrailingSelfTag(value);
    if (!text) {
      return false;
    }
    if (text.length < 2 || text.length > 80) {
      return false;
    }
    if (isLikelyEmail(text)) {
      return false;
    }
    if (/^(あなた|you)$/i.test(text)) {
      return false;
    }
    return true;
  }

  function lookupSelfNameFromInitDom() {
    // init.html account card:
    // <div title="Display Name">email@example.com</div><a data-account-switcher-url>...</a>
    const accountSwitcherLinks = document.querySelectorAll('a[data-account-switcher-url]');
    for (const link of accountSwitcherLinks) {
      if (!(link instanceof HTMLAnchorElement)) {
        continue;
      }

      const scope = link.parentElement;
      if (!scope) {
        continue;
      }

      const titledNodes = scope.querySelectorAll('[title]');
      for (const node of titledNodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        const displayName = normalizeText(node.getAttribute('title'));
        const bodyText = normalizeText(node.textContent);
        if (!isLikelyDisplayName(displayName) || !isLikelyEmail(bodyText)) {
          continue;
        }

        return stripTrailingSelfTag(displayName);
      }
    }

    // Generic fallback: any node with title=name and body=email.
    const titledNodes = document.querySelectorAll('[title]');
    for (const node of titledNodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      const displayName = normalizeText(node.getAttribute('title'));
      const bodyText = normalizeText(node.textContent);
      if (!isLikelyDisplayName(displayName) || !isLikelyEmail(bodyText)) {
        continue;
      }

      return stripTrailingSelfTag(displayName);
    }

    // init.html preview area often has own display name in this node.
    const previewNameNodes = document.querySelectorAll('.MJ4T8e');
    for (const node of previewNameNodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const name = stripTrailingSelfTag(node.textContent);
      if (isLikelyDisplayName(name)) {
        return name;
      }
    }

    return '';
  }

  function findDs9ScriptText() {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const script of scripts) {
      if (!(script instanceof HTMLScriptElement)) {
        continue;
      }

      const text = script.textContent || '';
      if (
        text.includes('AF_initDataCallback') &&
        /key\s*:\s*['"]ds:\d+['"]/.test(text) &&
        text.includes('googleusercontent.com') &&
        text.includes('AccountChooser')
      ) {
        return text;
      }
    }
    return null;
  }

  function findBalancedBracketEnd(text, startIndex, openChar, closeChar) {
    let depth = 0;
    let quote = '';
    let escape = false;

    for (let i = startIndex; i < text.length; i += 1) {
      const ch = text[i];

      if (quote) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === quote) {
          quote = '';
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }

      if (ch === openChar) {
        depth += 1;
        continue;
      }

      if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }

    return -1;
  }

  function extractArrayTopLevelItems(arrayLiteral, limit) {
    const items = [];
    let tokenStart = 1;
    let depth = 0;
    let quote = '';
    let escape = false;

    for (let i = 1; i < arrayLiteral.length - 1; i += 1) {
      const ch = arrayLiteral[i];

      if (quote) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === quote) {
          quote = '';
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }

      if (ch === '[' || ch === '{' || ch === '(') {
        depth += 1;
        continue;
      }

      if (ch === ']' || ch === '}' || ch === ')') {
        if (depth > 0) {
          depth -= 1;
        }
        continue;
      }

      if (ch === ',' && depth === 0) {
        items.push(arrayLiteral.slice(tokenStart, i).trim());
        if (items.length >= limit) {
          return items;
        }
        tokenStart = i + 1;
      }
    }

    if (tokenStart < arrayLiteral.length - 1) {
      items.push(arrayLiteral.slice(tokenStart, arrayLiteral.length - 1).trim());
    }

    return items;
  }

  function decodeLiteralToString(literal) {
    const trimmed = (literal || '').trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') {
      return '';
    }

    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      try {
        if (trimmed.startsWith('"')) {
          return String(JSON.parse(trimmed));
        }

        const normalizedSingleQuoted = `"${trimmed
          .slice(1, -1)
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\\'/g, "'")}"`;
        return String(JSON.parse(normalizedSingleQuoted));
      } catch (_error) {
        return trimmed.slice(1, -1);
      }
    }

    return trimmed;
  }

  function lookupSelfNameFromDs9Index6() {
    const text = findDs9ScriptText();
    if (!text) {
      return '';
    }
    const callStart = text.indexOf('AF_initDataCallback(');
    if (callStart < 0) {
      return '';
    }

    const firstParen = text.indexOf('(', callStart);
    const lastParen = text.lastIndexOf(')');
    if (firstParen < 0 || lastParen < 0 || lastParen <= firstParen) {
      return '';
    }

    // Convert AF_initDataCallback({ key: 'ds:*', data: [...] }) argument object into JSON.
    const argObjectLiteral = text.slice(firstParen + 1, lastParen).trim();
    const jsonLike = argObjectLiteral
      .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
      .replace(/'/g, '"');

    try {
      const parsed = JSON.parse(jsonLike);
      const data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
      const displayName = data[6];
      const name = stripTrailingSelfTag(String(displayName || ''));
      return name || '';
    } catch (_error) {
      const dataKeyStart = text.indexOf('data', callStart);
      if (dataKeyStart < 0) {
        return '';
      }

      const arrayStart = text.indexOf('[', dataKeyStart);
      if (arrayStart < 0) {
        return '';
      }

      const arrayEnd = findBalancedBracketEnd(text, arrayStart, '[', ']');
      if (arrayEnd < 0) {
        return '';
      }

      const dataArrayLiteral = text.slice(arrayStart, arrayEnd + 1);
      const items = extractArrayTopLevelItems(dataArrayLiteral, 7);
      if (items.length < 7) {
        return '';
      }

      const displayName = decodeLiteralToString(items[6]);
      const name = stripTrailingSelfTag(displayName);
      return name || '';
    }
  }

  function resolveSelfDisplayName() {
    const now = Date.now();
    if (selfDisplayNameCache && now - selfDisplayNameFetchedAt < CONFIG.selfNameCacheTtlMs) {
      return selfDisplayNameCache;
    }
    if (!selfDisplayNameCache && selfDisplayNameLookupFailedAt && now - selfDisplayNameLookupFailedAt < CONFIG.selfNameRetryTtlMs) {
      return '';
    }

    const resolvedFromDom = lookupSelfNameFromInitDom();
    if (resolvedFromDom) {
      selfDisplayNameCache = resolvedFromDom;
      selfDisplayNameFetchedAt = now;
      selfDisplayNameLookupFailedAt = 0;
      return resolvedFromDom;
    }

    const resolved = lookupSelfNameFromDs9Index6();

    if (resolved) {
      selfDisplayNameCache = resolved;
      selfDisplayNameFetchedAt = now;
      selfDisplayNameLookupFailedAt = 0;
      return resolved;
    }

    // Keep last known self name even if current page no longer contains init DOM.
    if (selfDisplayNameCache) {
      selfDisplayNameLookupFailedAt = now;
      return selfDisplayNameCache;
    }

    selfDisplayNameLookupFailedAt = now;
    return '';
  }

  function isSelfSpeakerLabel(speaker) {
    if (!speaker) {
      return false;
    }

    const normalized = speaker.toLowerCase();
    return CONFIG.selfSpeakerLabels.some((label) => normalized === label.toLowerCase());
  }

  function normalizeSpeakerName(speaker) {
    if (!isSelfSpeakerLabel(speaker)) {
      return speaker;
    }

    if (CONFIG.selfDisplayNameOverride) {
      return normalizeText(CONFIG.selfDisplayNameOverride);
    }

    const selfName = resolveSelfDisplayName();
    return selfName || speaker;
  }

  function isVisible(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasCaptionLabel(button, labelParts) {
    if (!(button instanceof HTMLButtonElement)) {
      return false;
    }

    const label = normalizeText(button.getAttribute('aria-label'));
    if (!label) {
      return false;
    }

    return labelParts.some((part) => label.includes(part));
  }

  function findCaptionButton(labelParts) {
    const buttons = document.querySelectorAll('button[aria-label]');
    for (const button of buttons) {
      if (hasCaptionLabel(button, labelParts) && isVisible(button)) {
        return button;
      }
    }

    return null;
  }

  function findTurnOnCaptionsButton() {
    return findCaptionButton(CONFIG.captionsOnLabelParts);
  }

  function findTurnOffCaptionsButton() {
    return findCaptionButton(CONFIG.captionsOffLabelParts);
  }

  function refreshCaptionState() {
    const now = Date.now();
    if (now - lastCaptionControlScanAt < 700) {
      return;
    }
    lastCaptionControlScanAt = now;

    const onButton = findTurnOnCaptionsButton();
    if (onButton) {
      autoCaptionEnabled = false;
      return;
    }

    const offButton = findTurnOffCaptionsButton();
    if (offButton) {
      autoCaptionEnabled = true;
      return;
    }

    autoCaptionEnabled = false;
  }

  function tryAutoEnableCaptions() {
    if (!CONFIG.autoEnableCaptions || autoCaptionEnabled || autoCaptionAttemptInFlight) {
      return;
    }

    const now = Date.now();
    if (now - lastAutoCaptionAttemptAt < 700) {
      return;
    }
    lastAutoCaptionAttemptAt = now;

    const button = findTurnOnCaptionsButton();
    if (!button) {
      return;
    }

    autoCaptionAttemptInFlight = true;
    button.click();

    setTimeout(() => {
      autoCaptionAttemptInFlight = false;
      autoCaptionEnabled = !findTurnOnCaptionsButton();
      lastCaptionControlScanAt = 0;
      refreshCaptionState();
    }, 800);
  }

  async function sendPayload(payload) {
    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: 'sendCaptionPayload',
            payload
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(response);
          }
        );
      });

      if (!result || typeof result !== 'object' || !('ok' in result)) {
        console.warn('[meet-caption-sender] send failed: no response', payload);
      } else if (!result.ok) {
        console.warn('[meet-caption-sender] send failed', result, payload);
      }
    } catch (error) {
      console.warn('[meet-caption-sender] send error', error, payload);
    }
  }

  function nextCaptionId() {
    rowSequence += 1;
    return `cap_${Date.now()}_${rowSequence}`;
  }

  class CaptionRowTracker {
    constructor(row) {
      this.row = row;
      this.captionBaseId = nextCaptionId();
      this.segmentIndex = 0;
      this.lines = [];
      this.speaker = '';
      this.lastChangedAt = 0;
      this.lastEmittedText = '';
      this.timerId = null;

      this.observer = new MutationObserver(() => {
        this.onMutated();
      });

      this.observer.observe(this.row, {
        childList: true,
        subtree: true,
        characterData: true
      });

      this.onMutated();
    }

    onMutated() {
      const snapshot = extractCaptionData(this.row);
      if (snapshot.lines.length === 0) {
        return;
      }

      const changed =
        !isSameLines(snapshot.lines, this.lines) ||
        snapshot.speaker !== this.speaker;

      if (!changed) {
        return;
      }

      this.lines = snapshot.lines;
      this.speaker = snapshot.speaker;
      this.lastChangedAt = Date.now();
      this.scheduleFinalize();
    }

    scheduleFinalize() {
      this.clearTimer();
      this.timerId = setTimeout(() => {
        this.finalize(false);
      }, CONFIG.finalizeIdleMs);
    }

    clearTimer() {
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
    }

    buildPayload() {
      const text = this.buildDeltaText();
      const lines = splitCaptionLines(text);
      const captionId = `${this.captionBaseId}_${this.segmentIndex + 1}`;
      return {
        source: 'google_meet',
        eventType: 'final',
        captionId,
        speaker: this.speaker,
        lines,
        text,
        lineCount: lines.length,
        finalizedAt: new Date().toISOString(),
        meetingUrl: location.href
      };
    }

    buildDeltaText() {
      const currentText = this.lines.join('\n');
      if (!this.lastEmittedText) {
        return currentText;
      }

      let i = 0;
      const max = Math.min(this.lastEmittedText.length, currentText.length);
      while (i < max && this.lastEmittedText[i] === currentText[i]) {
        i += 1;
      }

      return currentText.slice(i).trim();
    }

    finalize(force) {
      this.clearTimer();

      const latest = extractCaptionData(this.row);
      if (latest.lines.length === 0) {
        return;
      }

      this.lines = latest.lines;
      if (latest.speaker) {
        this.speaker = latest.speaker;
      }

      if (!force) {
        const idleMs = Date.now() - this.lastChangedAt;
        if (idleMs < CONFIG.finalizeIdleMs) {
          this.scheduleFinalize();
          return;
        }
      }

      const payload = this.buildPayload();
      if (!payload.text) {
        return;
      }

      this.segmentIndex += 1;
      this.lastEmittedText = this.lines.join('\n');
      void sendPayload(payload);
    }

    dispose(forceFinalize) {
      if (forceFinalize) {
        this.finalize(true);
      }

      this.clearTimer();
      this.observer.disconnect();
    }
  }

  function isRowElement(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    return CONFIG.rowSelectors.some((selector) => node.matches(selector));
  }

  function findCandidateRows(root) {
    const found = new Set();

    if (!(root instanceof Element || root instanceof Document)) {
      return found;
    }

    if (root instanceof Element && isRowElement(root)) {
      found.add(root);
    }

    for (const selector of CONFIG.rowSelectors) {
      root.querySelectorAll(selector).forEach((node) => {
        found.add(node);
      });
    }

    return found;
  }

  function watchRow(row) {
    if (rowTrackerMap.has(row)) {
      return;
    }

    rowTrackerMap.set(row, new CaptionRowTracker(row));
  }

  function untrackDetachedRows() {
    for (const [row, tracker] of rowTrackerMap) {
      if (!document.contains(row)) {
        tracker.dispose(true);
        rowTrackerMap.delete(row);
      }
    }
  }

  function scanRows() {
    // Prime self name cache while prejoin/init DOM is present.
    resolveSelfDisplayName();
    refreshCaptionState();
    tryAutoEnableCaptions();

    const rows = findCandidateRows(document);
    rows.forEach((row) => {
      watchRow(row);
    });

    untrackDetachedRows();
  }

  scanRows();
  setInterval(() => {
    scanRows();
  }, CONFIG.scanIntervalMs);
  console.info('[meet-caption-sender] initialized');
})();
