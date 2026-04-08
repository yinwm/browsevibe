import {
  WRITE_BROWSER_ACTIONS,
  normalizeBrowserAction,
} from "./browser-protocol.js";

const ACTIVE_TAB_CONTEXT_EVENT = "sidebar:active-tab-context-updated";
const TAB_CONTEXT_BROADCAST_DELAY_MS = 150;
const POST_ACTION_SNAPSHOT_DELAY_MS = 450;

let tabContextBroadcastTimer = null;
let lastBroadcastContextKey = "";
const grantedPageAuthorizations = new Map();

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
      console.warn("Failed to enable side panel action behavior", error);
    });
  }
});

chrome.tabs.onActivated.addListener(() => {
  scheduleActiveTabContextBroadcast();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (
    changeInfo.status === "loading" ||
    changeInfo.status === "complete" ||
    typeof changeInfo.title === "string" ||
    typeof changeInfo.url === "string"
  ) {
    scheduleActiveTabContextBroadcast();
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  scheduleActiveTabContextBroadcast();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "sidebar:get-active-tab-context") {
    getActiveTabContext()
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === "browserBridge:executeAction") {
    executeBrowserBridgeAction(message.action)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === "browserBridge:grant-page-authorization") {
    grantPageAuthorization(message.pageKey)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  return false;
});

function scheduleActiveTabContextBroadcast() {
  if (tabContextBroadcastTimer) {
    clearTimeout(tabContextBroadcastTimer);
  }

  tabContextBroadcastTimer = setTimeout(() => {
    tabContextBroadcastTimer = null;
    void broadcastActiveTabContext();
  }, TAB_CONTEXT_BROADCAST_DELAY_MS);
}

async function broadcastActiveTabContext() {
  try {
    const context = await getActiveTabContext();
    const contextKey = JSON.stringify({
      tabId: context.tabId,
      title: context.title,
      url: context.url,
      selectionText: context.selectionText,
      headings: context.headings,
    });

    if (contextKey === lastBroadcastContextKey) {
      return;
    }
    lastBroadcastContextKey = contextKey;

    await chrome.runtime.sendMessage({
      type: ACTIVE_TAB_CONTEXT_EVENT,
      context,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Receiving end does not exist")) {
      return;
    }
    console.warn("Failed to broadcast active tab context", error);
  }
}

async function executeBrowserBridgeAction(action) {
  const normalizedAction = normalizeBrowserAction(action, {
    allowStringTarget: false,
    allowSelectorTarget: false,
    allowInternalActions: true,
    allowLegacyTopLevelTargetFields: true,
  });
  if (!normalizedAction) {
    return {
      ok: false,
      error: "Invalid browser action payload.",
    };
  }

  const tab = await getVerifiedActiveTab();
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    return {
      ok: false,
      error: "Browser automation only works on HTTP(S) pages.",
    };
  }

  const authorization = buildPageAuthorization(tab);
  if (
    WRITE_BROWSER_ACTIONS.has(normalizedAction.action) &&
    !grantedPageAuthorizations.has(authorization.pageKey)
  ) {
    return {
      ok: false,
      requiresApproval: true,
      error: "This page requires a one-time browser action approval.",
      approval: authorization,
    };
  }

  const response = await dispatchActionToTab(tab.id, normalizedAction);
  if (WRITE_BROWSER_ACTIONS.has(normalizedAction.action)) {
    const snapshot = await collectPostActionSnapshot(tab.id);
    return attachSnapshotToResponse(response, snapshot, authorization);
  }

  return attachAuthorizationToResponse(response, authorization);
}

async function grantPageAuthorization(requestedPageKey) {
  const tab = await getVerifiedActiveTab();
  const authorization = buildPageAuthorization(tab);
  if (requestedPageKey && requestedPageKey !== authorization.pageKey) {
    return {
      ok: false,
      error: "The active page changed before authorization was granted.",
      approval: authorization,
    };
  }

  grantedPageAuthorizations.set(authorization.pageKey, {
    grantedAt: Date.now(),
    tabId: tab.id,
  });

  return {
    ok: true,
    approval: authorization,
  };
}

async function collectPostActionSnapshot(tabId) {
  const attemptDelays = [
    POST_ACTION_SNAPSHOT_DELAY_MS,
    POST_ACTION_SNAPSHOT_DELAY_MS * 2,
    POST_ACTION_SNAPSHOT_DELAY_MS * 3,
  ];

  for (const waitMs of attemptDelays) {
    await delay(waitMs);
    const snapshotResponse = await dispatchActionToTab(tabId, {
      action: "browser.snapshot",
    });

    if (snapshotResponse?.ok) {
      return snapshotResponse.result?.snapshot || null;
    }
  }

  return null;
}

async function dispatchActionToTab(tabId, action) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "browserBridge:executeAction",
      action,
    });

    return response || {
      ok: false,
      error: "The active page did not return a browser action response.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Receiving end does not exist")) {
      return {
        ok: false,
        error:
          "The active page is not ready for browser automation yet. Reload the page and try again.",
      };
    }

    return {
      ok: false,
      error: message,
    };
  }
}

async function getActiveTabContext() {
  const tab = await getVerifiedActiveTab();
  const context = {
    tabId: tab.id,
    title: tab.title ?? "",
    url: tab.url ?? "",
    pageTitle: tab.title ?? "",
    canonicalUrl: tab.url ?? "",
    selectionText: "",
    headings: [],
    description: "",
    lang: "",
  };

  if (!tab.url || !/^https?:/i.test(tab.url)) {
    return context;
  }

  try {
    const pageContext = await chrome.tabs.sendMessage(tab.id, {
      type: "sidebar:get-page-context",
    });
    if (!pageContext) {
      return context;
    }

    return {
      ...context,
      ...pageContext,
      title: pageContext.pageTitle || context.title,
      url: pageContext.canonicalUrl || context.url,
    };
  } catch (error) {
    console.warn("Failed to collect page context", error);
    return context;
  }
}

async function getVerifiedActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found");
  }
  return tab;
}

function buildPageAuthorization(tab) {
  const canonicalUrl = normalizePageUrl(tab.url || "");
  return {
    pageKey: `tab:${tab.id}|url:${canonicalUrl || "unknown-url"}`,
    tabId: tab.id,
    title: tab.title || "",
    url: canonicalUrl || tab.url || "",
  };
}

function attachSnapshotToResponse(response, snapshot, authorization) {
  const result = {
    ...(response?.result || {}),
    snapshot: snapshot || response?.result?.snapshot || null,
  };

  return {
    ok: Boolean(response?.ok),
    requiresApproval: response?.requiresApproval || false,
    error: response?.error || "",
    result,
    approval: authorization,
  };
}

function attachAuthorizationToResponse(response, authorization) {
  return {
    ...response,
    approval: authorization,
  };
}

function normalizePageUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return trimmed;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
