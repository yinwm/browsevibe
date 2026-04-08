const MAX_SELECTION_LENGTH = 4000;
const MAX_HEADING_COUNT = 5;
const MAX_SNAPSHOT_ELEMENTS = 30;
const MAX_SNAPSHOT_TEXT_LENGTH = 400;
const DEFAULT_FIND_RESULTS_LIMIT = 8;
const MAX_FIND_RESULTS_LIMIT = 12;
const DEFAULT_WAIT_TIMEOUT_MS = 4000;
const MAX_WAIT_TIMEOUT_MS = 15000;
const WAIT_POLL_INTERVAL_MS = 150;
const MAX_ACTION_HISTORY = 10;
const MAX_FIND_RELATED_ITEMS = 4;
const MAX_DIFF_ITEMS = 4;
const ACTION_SETTLE_INTERVAL_MS = 120;
const ACTION_SETTLE_STABLE_ITERATIONS = 2;
const ACTION_SETTLE_MAX_ITERATIONS = 8;
const SNAPSHOT_CANDIDATE_SELECTOR = [
  'a[href]',
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(", ");
const HEURISTIC_SNAPSHOT_CANDIDATE_SELECTOR = ["div", "span", "li"].join(", ");
const ALL_SNAPSHOT_CANDIDATE_SELECTOR = [
  SNAPSHOT_CANDIDATE_SELECTOR,
  HEURISTIC_SNAPSHOT_CANDIDATE_SELECTOR,
].join(", ");

let browserProtocolPromise = null;
let latestSnapshotElements = new Map();
let latestObservation = null;
let observationSequence = 0;
let actionSequence = 0;
let recentActionRecords = [];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "sidebar:get-page-context") {
    sendResponse(collectPageContext());
    return false;
  }

  if (message?.type === "browserBridge:executeAction") {
    handleBrowserBridgeAction(message.action)
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

async function handleBrowserBridgeAction(action) {
  const { normalizeBrowserAction } = await getBrowserProtocol();
  const normalizedAction = normalizeBrowserAction(action, {
    allowStringTarget: false,
    allowSelectorTarget: false,
    allowInternalActions: true,
    allowLegacyTopLevelTargetFields: false,
    limitMax: MAX_FIND_RESULTS_LIMIT,
    timeoutMaxMs: MAX_WAIT_TIMEOUT_MS,
  });
  if (!normalizedAction) {
    return { ok: false, error: "Invalid browser action payload." };
  }

  switch (normalizedAction.action) {
    case "browser.snapshot":
      return executeSnapshotAction();
    case "browser.extract":
      return executeExtractAction(normalizedAction);
    case "browser.find":
      return executeFindAction(normalizedAction);
    case "browser.click":
      return executeClickAction(normalizedAction);
    case "browser.type":
      return executeTypeAction(normalizedAction);
    case "browser.press":
      return executePressAction(normalizedAction);
    case "browser.wait":
      return executeWaitAction(normalizedAction);
    case "browser.scroll":
      return executeScrollAction(normalizedAction);
    default:
      return {
        ok: false,
        error: `Unsupported browser action: ${normalizedAction.action}`,
      };
  }
}

function collectPageContext() {
  const selection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  const headings = Array.from(document.querySelectorAll("h1, h2"))
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean)
    .slice(0, MAX_HEADING_COUNT);

  const description = document
    .querySelector('meta[name="description"]')
    ?.getAttribute("content")
    ?.trim();

  return {
    pageTitle: document.title || "",
    canonicalUrl: location.href,
    selectionText: selection.slice(0, MAX_SELECTION_LENGTH),
    headings,
    description: description || "",
    lang: document.documentElement?.lang || "",
  };
}

function getBrowserProtocol() {
  if (!browserProtocolPromise) {
    browserProtocolPromise = import(chrome.runtime.getURL("browser-protocol.js"));
  }

  return browserProtocolPromise;
}

function executeSnapshotAction() {
  const snapshot = collectBrowserSnapshot();
  return {
    ok: true,
    result: {
      snapshot,
      page: summarizeObservation(snapshot),
    },
  };
}

function collectBrowserSnapshot() {
  const registry = collectBrowserSnapshotRegistry();
  return rememberObservation(
    buildBrowserSnapshotFromDescriptors(registry.descriptors),
    registry.elementMap,
  );
}

function collectBrowserSnapshotRegistry(limit = Number.POSITIVE_INFINITY) {
  const descriptors = [];
  const elementMap = new Map();

  collectSnapshotCandidateElements(limit).forEach((element, index) => {
    const elementId = `el-${index + 1}`;
    const descriptor = describeSnapshotElement(element, elementId);
    if (!descriptor) {
      return;
    }

    elementMap.set(elementId, element);
    descriptors.push(descriptor);
  });

  return {
    descriptors,
    elementMap,
  };
}

function buildBrowserSnapshotFromDescriptors(descriptors) {
  return {
    observationId: nextObservationId(),
    pageTitle: document.title || "",
    canonicalUrl: location.href,
    observedAt: Date.now(),
    textExcerpt: getDocumentTextExcerpt(),
    elementCount: descriptors.length,
    elements: descriptors,
  };
}

function nextObservationId() {
  observationSequence += 1;
  return `obs-${Date.now()}-${observationSequence}`;
}

function nextActionId() {
  actionSequence += 1;
  return `act-${Date.now()}-${actionSequence}`;
}

function rememberObservation(snapshot, elementMap) {
  latestObservation = snapshot;
  latestSnapshotElements = elementMap instanceof Map ? elementMap : new Map();
  return snapshot;
}

function rememberActionRecord(record) {
  recentActionRecords = [...recentActionRecords, record].slice(-MAX_ACTION_HISTORY);
  return record;
}

function getCurrentObservation() {
  return latestObservation;
}

function executeExtractAction(action) {
  const beforeSnapshot = getCurrentObservation() || collectBrowserSnapshot();
  const resolvedTarget = action.target ? resolveActionTarget(action.target) : null;

  if (action.target && !resolvedTarget?.ok) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: resolvedTarget.error,
      }),
    );
    return {
      ok: false,
      error: resolvedTarget.error,
      result: {
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  if (!resolvedTarget) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: true,
        summary: `Captured page context from ${beforeSnapshot.pageTitle || "the active page"}.`,
      }),
    );
    return {
      ok: true,
      result: {
        extracted: {
          pageTitle: beforeSnapshot.pageTitle,
          canonicalUrl: beforeSnapshot.canonicalUrl,
          textExcerpt: beforeSnapshot.textExcerpt,
          elementCount: beforeSnapshot.elementCount || beforeSnapshot.elements.length,
        },
        summary: `Captured page context from ${beforeSnapshot.pageTitle || "the active page"}.`,
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  const extracted = extractElementContent(resolvedTarget.element);
  const actionRecord = rememberActionRecord(
    createActionRecord(action, beforeSnapshot, beforeSnapshot, {
      ok: true,
      summary: `Extracted content from ${summarizeDescriptor(resolvedTarget.descriptor)}.`,
    }),
  );
  return {
    ok: true,
    result: {
      extracted,
      target: resolvedTarget.descriptor,
      summary: `Extracted content from ${summarizeDescriptor(resolvedTarget.descriptor)}.`,
      snapshot: beforeSnapshot,
      page: summarizeObservation(beforeSnapshot),
      actionRecord: summarizeActionRecord(actionRecord),
    },
  };
}

async function executeClickAction(action) {
  const beforeSnapshot = getCurrentObservation() || collectBrowserSnapshot();
  const resolvedTarget = resolveActionTarget(action.target);
  if (!resolvedTarget.ok) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: resolvedTarget.error,
      }),
    );
    return {
      ok: false,
      error: resolvedTarget.error,
      result: {
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  const { element, descriptor } = resolvedTarget;
  if (!isElementVisible(element)) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: "Target element is not visible.",
      }),
    );
    return {
      ok: false,
      error: "Target element is not visible.",
      result: {
        target: descriptor,
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  if (isElementDisabled(element)) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: "Target element is disabled.",
      }),
    );
    return {
      ok: false,
      error: "Target element is disabled.",
      result: {
        target: descriptor,
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  scrollElementIntoView(element);
  focusElement(element);
  element.click();
  await waitForPageSettle();
  const afterSnapshot = collectBrowserSnapshot();
  const diff = buildObservationDiff(beforeSnapshot, afterSnapshot);
  const summary = `Clicked ${summarizeDescriptor(descriptor)}.`;
  const actionRecord = rememberActionRecord(
    createActionRecord(action, beforeSnapshot, afterSnapshot, {
      ok: true,
      summary,
      diff,
      target: descriptor,
    }),
  );

  return {
    ok: true,
    result: {
      target: descriptor,
      summary,
      snapshot: afterSnapshot,
      page: summarizeObservation(afterSnapshot),
      beforePage: summarizeObservation(beforeSnapshot),
      diff,
      actionRecord: summarizeActionRecord(actionRecord),
    },
  };
}

function executeFindAction(action) {
  const query = normalizeText(action.query || "");
  if (!query) {
    const currentSnapshot = getCurrentObservation() || collectBrowserSnapshot();
    const actionRecord = rememberActionRecord(
      createActionRecord(action, currentSnapshot, currentSnapshot, {
        ok: false,
        error: "browser.find requires a query string.",
      }),
    );
    return {
      ok: false,
      error: "browser.find requires a query string.",
      result: {
        snapshot: currentSnapshot,
        page: summarizeObservation(currentSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  const beforeSnapshot = getCurrentObservation() || null;
  const registry = collectBrowserSnapshotRegistry();
  const snapshot = rememberObservation(
    buildBrowserSnapshotFromDescriptors(registry.descriptors),
    registry.elementMap,
  );

  const matches = snapshot.elements
    .filter((descriptor) => descriptorMatchesFindKinds(descriptor, action.kinds))
    .filter((descriptor) => descriptorMatchesFindRegions(descriptor, action.regions))
    .filter(
      (descriptor) =>
        !descriptorMatchesAnyRegion(descriptor, action.excludeRegions),
    )
    .map((descriptor) => ({
      ...descriptor,
      score: scoreDescriptorForFind(descriptor, query),
    }))
    .filter((descriptor) => descriptor.score > 0)
    .sort(compareFindMatches)
    .slice(0, normalizeFindLimit(action.limit))
    .map((descriptor) => ({
      ...descriptor,
      elementId: descriptor.id,
      observationId: snapshot.observationId,
      score: Number(descriptor.score.toFixed(2)),
      related: buildFindRelatedDescriptors(descriptor, snapshot.elements),
    }));

  const effectiveBeforeSnapshot = beforeSnapshot || snapshot;
  const diff = buildObservationDiff(effectiveBeforeSnapshot, snapshot);
  const summary = buildFindSummary(query, matches, snapshot.observationId);
  const actionRecord = rememberActionRecord(
    createActionRecord(action, effectiveBeforeSnapshot, snapshot, {
      ok: true,
      summary,
      diff,
    }),
  );

  return {
    ok: true,
    result: {
      matches,
      observationId: snapshot.observationId,
      summary,
      snapshot,
      page: summarizeObservation(snapshot),
      beforePage: summarizeObservation(effectiveBeforeSnapshot),
      diff,
      actionRecord: summarizeActionRecord(actionRecord),
    },
  };
}

async function executeTypeAction(action) {
  const beforeSnapshot = getCurrentObservation() || collectBrowserSnapshot();
  if (typeof action.text !== "string") {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: "browser.type requires a text string.",
      }),
    );
    return {
      ok: false,
      error: "browser.type requires a text string.",
      result: {
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  const resolvedTarget = resolveActionTarget(action.target);
  if (!resolvedTarget.ok) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: resolvedTarget.error,
      }),
    );
    return {
      ok: false,
      error: resolvedTarget.error,
      result: {
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  const { element, descriptor } = resolvedTarget;
  if (!isEditableElement(element)) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: "Target element is not editable.",
      }),
    );
    return {
      ok: false,
      error: "Target element is not editable.",
      result: {
        target: descriptor,
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  if (isSensitiveElement(element)) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: "Sensitive inputs are blocked for browser.type.",
      }),
    );
    return {
      ok: false,
      error: "Sensitive inputs are blocked for browser.type.",
      result: {
        target: {
          ...descriptor,
          sensitive: true,
        },
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  if (isElementDisabled(element)) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: "Target element is disabled.",
      }),
    );
    return {
      ok: false,
      error: "Target element is disabled.",
      result: {
        target: descriptor,
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  scrollElementIntoView(element);
  focusElement(element);
  setElementTextValue(element, action.text, action.clear !== false);

  if (action.submit) {
    dispatchKeyboardEnter(element);
  }

  await waitForPageSettle();
  const afterSnapshot = collectBrowserSnapshot();
  const diff = buildObservationDiff(beforeSnapshot, afterSnapshot);
  const summary = `Typed into ${summarizeDescriptor(descriptor)}.`;
  const actionRecord = rememberActionRecord(
    createActionRecord(action, beforeSnapshot, afterSnapshot, {
      ok: true,
      summary,
      diff,
      target: descriptor,
    }),
  );

  return {
    ok: true,
    result: {
      target: descriptor,
      summary,
      snapshot: afterSnapshot,
      page: summarizeObservation(afterSnapshot),
      beforePage: summarizeObservation(beforeSnapshot),
      diff,
      actionRecord: summarizeActionRecord(actionRecord),
    },
  };
}

async function executePressAction(action) {
  const beforeSnapshot = getCurrentObservation() || collectBrowserSnapshot();
  if (typeof action.key !== "string" || !action.key.trim()) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: "browser.press requires a key string.",
      }),
    );
    return {
      ok: false,
      error: "browser.press requires a key string.",
      result: {
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  const targetResult = resolvePressTarget(action.target);
  if (!targetResult.ok) {
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, beforeSnapshot, {
        ok: false,
        error: targetResult.error,
      }),
    );
    return {
      ok: false,
      error: targetResult.error,
      result: {
        snapshot: beforeSnapshot,
        page: summarizeObservation(beforeSnapshot),
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  const { element, descriptor } = targetResult;
  if (element instanceof HTMLElement) {
    scrollElementIntoView(element);
    focusElement(element);
  }

  dispatchKeyboardKey(element, action.key);
  await waitForPageSettle();
  const afterSnapshot = collectBrowserSnapshot();
  const diff = buildObservationDiff(beforeSnapshot, afterSnapshot);
  const summary = `Pressed ${action.key} on ${summarizeDescriptor(descriptor)}.`;
  const actionRecord = rememberActionRecord(
    createActionRecord(action, beforeSnapshot, afterSnapshot, {
      ok: true,
      summary,
      diff,
      target: descriptor,
    }),
  );

  return {
    ok: true,
    result: {
      target: descriptor,
      summary,
      snapshot: afterSnapshot,
      page: summarizeObservation(afterSnapshot),
      beforePage: summarizeObservation(beforeSnapshot),
      diff,
      actionRecord: summarizeActionRecord(actionRecord),
    },
  };
}

async function executeWaitAction(action) {
  const beforeSnapshot = getCurrentObservation() || collectBrowserSnapshot();
  const startedAt = Date.now();
  const timeoutMs =
    Number.isFinite(action.timeoutMs) && action.timeoutMs > 0
      ? action.timeoutMs
      : DEFAULT_WAIT_TIMEOUT_MS;

  let afterSnapshot = beforeSnapshot;
  let matched = false;

  if (!action.until) {
    await waitForPageSettle();
    afterSnapshot = collectBrowserSnapshot();
    matched = true;
  } else {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      afterSnapshot = collectBrowserSnapshot();
      if (matchesWaitCondition(action.until, afterSnapshot)) {
        matched = true;
        break;
      }

      await delay(WAIT_POLL_INTERVAL_MS);
    }
  }

  const diff = buildObservationDiff(beforeSnapshot, afterSnapshot);
  if (!matched) {
    const error = `browser.wait timed out after ${timeoutMs}ms.`;
    const actionRecord = rememberActionRecord(
      createActionRecord(action, beforeSnapshot, afterSnapshot, {
        ok: false,
        error,
        diff,
      }),
    );
    return {
      ok: false,
      error,
      result: {
        snapshot: afterSnapshot,
        page: summarizeObservation(afterSnapshot),
        beforePage: summarizeObservation(beforeSnapshot),
        diff,
        actionRecord: summarizeActionRecord(actionRecord),
      },
    };
  }

  const waitedMs = Math.max(0, Date.now() - startedAt);
  const summary = action.until
    ? `Wait condition satisfied after ${waitedMs}ms.`
    : "Page settled.";
  const actionRecord = rememberActionRecord(
    createActionRecord(action, beforeSnapshot, afterSnapshot, {
      ok: true,
      summary,
      diff,
    }),
  );
  return {
    ok: true,
    result: {
      summary,
      snapshot: afterSnapshot,
      page: summarizeObservation(afterSnapshot),
      beforePage: summarizeObservation(beforeSnapshot),
      diff,
      actionRecord: summarizeActionRecord(actionRecord),
    },
  };
}

async function executeScrollAction(action) {
  const beforeSnapshot = getCurrentObservation() || collectBrowserSnapshot();
  let targetDescriptor = null;
  if (action.target) {
    const resolvedTarget = resolveActionTarget(action.target);
    if (!resolvedTarget.ok) {
      const actionRecord = rememberActionRecord(
        createActionRecord(action, beforeSnapshot, beforeSnapshot, {
          ok: false,
          error: resolvedTarget.error,
        }),
      );
      return {
        ok: false,
        error: resolvedTarget.error,
        result: {
          snapshot: beforeSnapshot,
          page: summarizeObservation(beforeSnapshot),
          actionRecord: summarizeActionRecord(actionRecord),
        },
      };
    }

    targetDescriptor = resolvedTarget.descriptor;
    scrollElementIntoView(resolvedTarget.element);
  } else {
    scrollViewport(action.direction, action.amount);
  }

  await waitForPageSettle();
  const afterSnapshot = collectBrowserSnapshot();
  const diff = buildObservationDiff(beforeSnapshot, afterSnapshot);
  const summary = action.target
    ? "Scrolled the target into view."
    : `Scrolled ${action.direction || "down"} by ${formatScrollAmount(action.amount)}.`;
  const actionRecord = rememberActionRecord(
    createActionRecord(action, beforeSnapshot, afterSnapshot, {
      ok: true,
      summary,
      diff,
      target: targetDescriptor,
    }),
  );

  return {
    ok: true,
    result: {
      summary,
      snapshot: afterSnapshot,
      page: summarizeObservation(afterSnapshot),
      beforePage: summarizeObservation(beforeSnapshot),
      diff,
      actionRecord: summarizeActionRecord(actionRecord),
    },
  };
}

function collectSnapshotCandidateElements(limit = Number.POSITIVE_INFINITY) {
  const candidates = [];

  Array.from(document.querySelectorAll(ALL_SNAPSHOT_CANDIDATE_SELECTOR)).forEach(
    (element) => {
      maybeAppendSnapshotCandidate(candidates, element, limit);
    },
  );

  return candidates;
}

function maybeAppendSnapshotCandidate(candidates, element, limit) {
  if (candidates.length >= limit || !isSnapshotCandidate(element)) {
    return;
  }

  if (
    candidates.some(
      (existing) =>
        existing === element ||
        existing.contains(element) ||
        element.contains(existing),
    )
  ) {
    return;
  }

  candidates.push(element);
}

function resolveActionTarget(target) {
  if (!target) {
    return {
      ok: false,
      error: "Browser action target is required.",
    };
  }

  if (!target.observationId || !target.elementId) {
    return {
      ok: false,
      error:
        "Browser action target must include both observationId and elementId from browser.find.",
    };
  }

  if (!latestObservation || latestObservation.observationId !== target.observationId) {
    return {
      ok: false,
      error:
        "The requested observation is stale or missing. Run browser.find again before clicking or typing.",
    };
  }

  const element = latestSnapshotElements.get(target.elementId);
  if (!element) {
    return {
      ok: false,
      error: `Could not find ${target.elementId} in observation ${target.observationId}. Run browser.find again.`,
    };
  }

  if (!element.isConnected) {
    return {
      ok: false,
      error:
        "The requested element is no longer attached to the page. Run browser.find again before retrying.",
    };
  }

  const descriptor = describeSnapshotElement(element, target.elementId);

  return {
    ok: true,
    element,
    descriptor: {
      ...descriptor,
      observationId: target.observationId,
    },
  };
}

function resolvePressTarget(target) {
  if (target) {
    return resolveActionTarget(target);
  }

  const element =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.body instanceof HTMLElement
        ? document.body
        : null;
  if (!element) {
    return {
      ok: false,
      error: "No active page element is available for browser.press.",
    };
  }

  const descriptor =
    describeSnapshotElement(
      element,
      findSnapshotElementIdForNode(element) || "active-element",
    ) || {
      id: "active-element",
      kind: element.tagName?.toLowerCase?.() || "element",
      text: normalizeText(getElementText(element)),
      label: normalizeText(getElementLabel(element)),
      region: inferElementRegion(element, element.getBoundingClientRect()),
    };

  return {
    ok: true,
    element,
    descriptor: {
      ...descriptor,
      observationId: latestObservation?.observationId || "",
    },
  };
}

function descriptorMatchesFindKinds(descriptor, kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return true;
  }

  const kind = String(descriptor.kind || "").toLowerCase();
  const tagName = String(descriptor.tagName || "").toLowerCase();
  return kinds.includes(kind) || kinds.includes(tagName);
}

function descriptorMatchesFindRegions(descriptor, regions) {
  if (!Array.isArray(regions) || regions.length === 0) {
    return true;
  }

  return descriptorMatchesAnyRegion(descriptor, regions);
}

function descriptorMatchesAnyRegion(descriptor, regions) {
  if (!Array.isArray(regions) || regions.length === 0) {
    return false;
  }

  const region = String(descriptor.region || "").toLowerCase();
  return Boolean(region) && regions.includes(region);
}

function scoreDescriptorForFind(descriptor, query) {
  const values = [
    descriptor.label,
    descriptor.text,
    descriptor.placeholder,
    descriptor.href,
    descriptor.selector,
    descriptor.region,
    ...(Array.isArray(descriptor.ancestors) ? descriptor.ancestors : []),
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  let score = 0;
  values.forEach((value) => {
    if (value === query) {
      score = Math.max(score, 1);
    } else if (value.startsWith(query)) {
      score = Math.max(
        score,
        Math.max(0.72, 0.92 - Math.max(0, value.length - query.length) * 0.01),
      );
    } else if (value.includes(query)) {
      score = Math.max(
        score,
        Math.max(0.36, 0.64 - Math.max(0, value.length - query.length) * 0.01),
      );
    }
  });

  if (score > 0 && ["button", "link"].includes(descriptor.kind)) {
    score += 0.03;
  }

  return Math.min(1, score);
}

function compareFindMatches(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  const navigationDelta = compareLeftNavDuplicateMatches(left, right);
  if (navigationDelta !== 0) {
    return navigationDelta;
  }

  const topDelta = (left.rect?.y ?? 0) - (right.rect?.y ?? 0);
  if (topDelta !== 0) {
    return topDelta;
  }

  return (left.rect?.x ?? 0) - (right.rect?.x ?? 0);
}

function compareLeftNavDuplicateMatches(left, right) {
  if (left.region !== "left_nav" || right.region !== "left_nav") {
    return 0;
  }

  const leftLabel = descriptorLabel(left);
  const rightLabel = descriptorLabel(right);
  if (!leftLabel || leftLabel !== rightLabel) {
    return 0;
  }

  const hrefDelta = Number(Boolean(right.href)) - Number(Boolean(left.href));
  if (hrefDelta !== 0) {
    return hrefDelta;
  }

  const ancestorDelta =
    (Array.isArray(right.ancestors) ? right.ancestors.length : 0) -
    (Array.isArray(left.ancestors) ? left.ancestors.length : 0);
  if (ancestorDelta !== 0) {
    return ancestorDelta;
  }

  const depthDelta = (right.rect?.x ?? 0) - (left.rect?.x ?? 0);
  if (depthDelta !== 0) {
    return depthDelta;
  }

  return 0;
}

function normalizeFindLimit(value) {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_FIND_RESULTS_LIMIT;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_FIND_RESULTS_LIMIT;
  }

  return Math.max(1, Math.min(MAX_FIND_RESULTS_LIMIT, Math.round(numeric)));
}

function buildFindSummary(query, matches, observationId = "") {
  if (!Array.isArray(matches) || matches.length === 0) {
    return `Found no matching elements for "${truncateText(query, 80)}"${
      observationId ? ` in ${observationId}` : ""
    }.`;
  }

  return `Found ${matches.length} matching element${
    matches.length === 1 ? "" : "s"
  } for "${truncateText(query, 80)}"${observationId ? ` in ${observationId}` : ""}.`;
}

function matchesWaitCondition(until, snapshot) {
  if (!until || typeof until !== "object") {
    return true;
  }

  const urlIncludes = normalizeText(until.urlIncludes || "");
  if (urlIncludes && !normalizeText(snapshot?.canonicalUrl || "").includes(urlIncludes)) {
    return false;
  }

  const titleIncludes = normalizeText(until.titleIncludes || "");
  if (titleIncludes && !normalizeText(snapshot?.pageTitle || "").includes(titleIncludes)) {
    return false;
  }

  const textIncludes = normalizeText(until.textIncludes || "");
  if (textIncludes && !normalizeText(snapshot?.textExcerpt || "").includes(textIncludes)) {
    return false;
  }

  const query = normalizeText(until.query || "");
  if (query) {
    const matchedDescriptors = (snapshot?.elements || [])
      .filter((descriptor) => descriptorMatchesFindKinds(descriptor, until.kinds))
      .filter((descriptor) => descriptorMatchesFindRegions(descriptor, until.regions))
      .filter(
        (descriptor) =>
          !descriptorMatchesAnyRegion(descriptor, until.excludeRegions),
      )
      .filter((descriptor) => scoreDescriptorForFind(descriptor, query) > 0);

    if (until.state === "disappear") {
      return matchedDescriptors.length === 0;
    }

    if (matchedDescriptors.length === 0) {
      return false;
    }
  }

  return true;
}

function scrollViewport(direction, amount) {
  const viewportWidth = Math.max(
    document.documentElement?.clientWidth || 0,
    window.innerWidth || 0,
  );
  const viewportHeight = Math.max(
    document.documentElement?.clientHeight || 0,
    window.innerHeight || 0,
  );
  const delta =
    typeof amount === "number"
      ? Math.max(40, Math.abs(amount))
      : amount === "viewport"
        ? Math.max(120, viewportHeight)
        : Math.max(120, Math.round(viewportHeight * 0.9));

  switch (direction) {
    case "up":
      window.scrollBy({ top: -delta, left: 0, behavior: "auto" });
      break;
    case "left":
      window.scrollBy({
        top: 0,
        left: -Math.max(80, Math.round(viewportWidth * 0.8)),
        behavior: "auto",
      });
      break;
    case "right":
      window.scrollBy({
        top: 0,
        left: Math.max(80, Math.round(viewportWidth * 0.8)),
        behavior: "auto",
      });
      break;
    case "down":
    default:
      window.scrollBy({ top: delta, left: 0, behavior: "auto" });
      break;
  }
}

function formatScrollAmount(amount) {
  if (typeof amount === "number") {
    return `${Math.abs(amount)}px`;
  }
  if (amount === "viewport") {
    return "one viewport";
  }
  return "one page";
}

function findSnapshotElementIdForNode(node) {
  for (const [elementId, element] of latestSnapshotElements.entries()) {
    if (element === node) {
      return elementId;
    }
  }
  return "";
}

function describeSnapshotElement(element, elementId) {
  if (!(element instanceof Element)) {
    return null;
  }

  const tagName = element.tagName.toLowerCase();
  const role = element.getAttribute("role") || "";
  const type =
    element instanceof HTMLInputElement ? (element.type || "text").toLowerCase() : "";
  const text = normalizeText(getElementText(element));
  const label = normalizeText(getElementLabel(element));
  const placeholder =
    "placeholder" in element ? normalizeText(element.placeholder || "") : "";
  const href =
    element instanceof HTMLAnchorElement
      ? normalizeText(element.href || "")
      : "";
  const rect = element.getBoundingClientRect();
  const ancestors = buildElementAncestors(element);

  return {
    id: elementId,
    kind: inferElementKind(element, tagName, role, type),
    tagName,
    role: role || undefined,
    type: type || undefined,
    text: text || undefined,
    label: label || undefined,
    placeholder: placeholder || undefined,
    href: href || undefined,
    visible: isElementVisible(element),
    enabled: !isElementDisabled(element),
    editable: isEditableElement(element),
    active: isElementActive(element),
    selected: isElementSelected(element),
    expanded: getElementExpandedState(element),
    checked:
      "checked" in element && typeof element.checked === "boolean"
        ? element.checked
        : undefined,
    filled: hasElementValue(element),
    sensitive: isSensitiveElement(element),
    region: inferElementRegion(element, rect),
    ancestors,
    selector: buildElementSelector(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function extractElementContent(element) {
  const descriptor = describeSnapshotElement(
    element,
    findSnapshotElementIdForNode(element) || "selector-target",
  );

  return {
    text: normalizeText(getElementText(element)),
    html:
      element instanceof HTMLElement
        ? truncateText(element.outerHTML, MAX_SELECTION_LENGTH)
        : "",
    href:
      element instanceof HTMLAnchorElement
        ? normalizeText(element.href || "")
        : "",
    value:
      isSensitiveElement(element) || !hasRawValue(element)
        ? ""
        : truncateText(getRawElementValue(element), MAX_SELECTION_LENGTH),
    descriptor,
  };
}

function summarizeObservation(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    observationId: snapshot.observationId || "",
    pageTitle: snapshot.pageTitle || "",
    canonicalUrl: snapshot.canonicalUrl || "",
    observedAt: snapshot.observedAt || Date.now(),
    textExcerpt: truncateText(snapshot.textExcerpt || "", 200),
    elementCount:
      Number.isFinite(snapshot.elementCount) && snapshot.elementCount >= 0
        ? snapshot.elementCount
        : Array.isArray(snapshot.elements)
          ? snapshot.elements.length
          : 0,
  };
}

function createActionRecord(action, beforeSnapshot, afterSnapshot, details) {
  return {
    actionId: nextActionId(),
    createdAt: Date.now(),
    action: sanitizeActionForHistory(action),
    status: details?.ok ? "success" : "error",
    summary: details?.summary || details?.error || action.action,
    error: details?.ok ? "" : details?.error || "",
    beforeSnapshot,
    afterSnapshot,
    diff: details?.diff || buildObservationDiff(beforeSnapshot, afterSnapshot),
    target: details?.target || null,
  };
}

function summarizeActionRecord(record) {
  if (!record) {
    return null;
  }

  return {
    actionId: record.actionId,
    createdAt: record.createdAt,
    action: record.action,
    status: record.status,
    summary: record.summary,
    error: record.error || "",
    before: summarizeObservation(record.beforeSnapshot),
    after: summarizeObservation(record.afterSnapshot),
    diff: record.diff || null,
    target: record.target || null,
  };
}

function sanitizeActionForHistory(action) {
  if (!action || typeof action !== "object") {
    return { action: "" };
  }

  return {
    action: action.action || "",
    query: typeof action.query === "string" ? action.query : undefined,
    kinds: Array.isArray(action.kinds) ? action.kinds : undefined,
    regions: Array.isArray(action.regions) ? action.regions : undefined,
    excludeRegions: Array.isArray(action.excludeRegions)
      ? action.excludeRegions
      : undefined,
    target: action.target
      ? {
          observationId: action.target.observationId || undefined,
          elementId: action.target.elementId || undefined,
        }
      : undefined,
    key: typeof action.key === "string" ? action.key : undefined,
    until: action.until || undefined,
    direction: typeof action.direction === "string" ? action.direction : undefined,
    amount:
      typeof action.amount === "number" || typeof action.amount === "string"
        ? action.amount
        : undefined,
    timeoutMs:
      Number.isFinite(action.timeoutMs) && action.timeoutMs > 0
        ? action.timeoutMs
        : undefined,
    text:
      typeof action.text === "string"
        ? truncateText(action.text, 80)
        : undefined,
    clear: action.clear === false ? false : undefined,
    submit: action.submit === true ? true : undefined,
  };
}

function buildObservationDiff(beforeSnapshot, afterSnapshot) {
  const before = beforeSnapshot || null;
  const after = afterSnapshot || null;
  const beforeLabels = collectObservationLabels(before);
  const afterLabels = collectObservationLabels(after);
  const added = [...afterLabels].filter((label) => !beforeLabels.has(label));
  const removed = [...beforeLabels].filter((label) => !afterLabels.has(label));

  return {
    changed: Boolean(
      !before ||
        !after ||
        before.pageTitle !== after.pageTitle ||
        before.canonicalUrl !== after.canonicalUrl ||
        before.textExcerpt !== after.textExcerpt ||
        added.length > 0 ||
        removed.length > 0,
    ),
    urlChanged: Boolean(before && after && before.canonicalUrl !== after.canonicalUrl),
    titleChanged: Boolean(before && after && before.pageTitle !== after.pageTitle),
    textChanged: Boolean(before && after && before.textExcerpt !== after.textExcerpt),
    added: added.slice(0, MAX_DIFF_ITEMS),
    removed: removed.slice(0, MAX_DIFF_ITEMS),
  };
}

function collectObservationLabels(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.elements)) {
    return new Set();
  }

  return new Set(
    snapshot.elements
      .map((descriptor) => descriptorLabel(descriptor))
      .filter(Boolean),
  );
}

function buildFindRelatedDescriptors(descriptor, allDescriptors) {
  if (!descriptor || !Array.isArray(allDescriptors)) {
    return [];
  }

  return allDescriptors
    .filter((candidate) => candidate.id !== descriptor.id)
    .map((candidate) => ({
      descriptor: candidate,
      score: scoreRelatedDescriptor(candidate, descriptor),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_FIND_RELATED_ITEMS)
    .map((entry) => ({
      elementId: entry.descriptor.id,
      kind: entry.descriptor.kind,
      text:
        entry.descriptor.label ||
        entry.descriptor.text ||
        entry.descriptor.placeholder ||
        entry.descriptor.href ||
        "",
      region: entry.descriptor.region || "",
      active: entry.descriptor.active === true,
      selected: entry.descriptor.selected === true,
      expanded: entry.descriptor.expanded,
    }));
}

function scoreRelatedDescriptor(candidate, focus) {
  let score = 0;
  if (candidate.region && candidate.region === focus.region) {
    score += 3;
  }

  const focusAncestors = new Set(Array.isArray(focus.ancestors) ? focus.ancestors : []);
  const sharedAncestors = (candidate.ancestors || []).filter((ancestor) =>
    focusAncestors.has(ancestor),
  );
  score += sharedAncestors.length * 4;

  if (candidate.kind === focus.kind) {
    score += 1;
  }

  const deltaY = Math.abs((candidate.rect?.y ?? 0) - (focus.rect?.y ?? 0));
  const deltaX = Math.abs((candidate.rect?.x ?? 0) - (focus.rect?.x ?? 0));
  if (deltaY <= 220) {
    score += 2;
  }
  if (deltaX <= 260) {
    score += 1;
  }

  return score;
}

async function waitForPageSettle() {
  let stableIterations = 0;
  let previousSignature = buildPageSettleSignature();

  for (let index = 0; index < ACTION_SETTLE_MAX_ITERATIONS; index += 1) {
    await delay(ACTION_SETTLE_INTERVAL_MS);
    const currentSignature = buildPageSettleSignature();
    if (currentSignature === previousSignature) {
      stableIterations += 1;
      if (stableIterations >= ACTION_SETTLE_STABLE_ITERATIONS) {
        break;
      }
    } else {
      previousSignature = currentSignature;
      stableIterations = 0;
    }
  }
}

function buildPageSettleSignature() {
  return [
    location.href,
    document.title || "",
    getDocumentTextExcerpt(),
    document.querySelectorAll(SNAPSHOT_CANDIDATE_SELECTOR).length,
  ].join("::");
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function descriptorLabel(descriptor) {
  return normalizeText(
    descriptor?.label ||
      descriptor?.text ||
      descriptor?.placeholder ||
      descriptor?.href ||
      "",
  );
}

function inferElementKind(element, tagName, role, type) {
  if (element instanceof HTMLAnchorElement || role === "link") {
    return "link";
  }
  if (element instanceof HTMLButtonElement || role === "button") {
    return "button";
  }
  if (element instanceof HTMLSelectElement) {
    return "select";
  }
  if (element instanceof HTMLTextAreaElement) {
    return "textarea";
  }
  if (element instanceof HTMLInputElement) {
    if (type === "checkbox" || type === "radio") {
      return type;
    }
    return "input";
  }
  if (isEditableElement(element)) {
    return "editable";
  }
  if (isHeuristicSnapshotCandidate(element)) {
    return "button";
  }
  return tagName;
}

function inferElementRegion(element, rect) {
  const semanticTokens = collectElementSemanticTokens(element);
  const tokenMatches = [
    ["modal", /(modal|dialog|drawer|popup|popover|tooltip)/],
    ["left_nav", /(sidebar|sider|aside|menu|nav|module|route)/],
    ["breadcrumb", /(breadcrumb|crumb)/],
    ["tab_bar", /(tab|tabs)/],
    ["header", /(header|topbar|toolbar)/],
    ["footer", /(footer|bottom)/],
    ["filter_panel", /(filter|search|query)/],
    ["table", /(table|grid|list|row|cell)/],
    ["form", /(form|field|input)/],
  ];

  for (const [region, pattern] of tokenMatches) {
    if (pattern.test(semanticTokens)) {
      return region;
    }
  }

  const viewportWidth = Math.max(
    document.documentElement?.clientWidth || 0,
    window.innerWidth || 0,
  );
  const viewportHeight = Math.max(
    document.documentElement?.clientHeight || 0,
    window.innerHeight || 0,
  );

  if (viewportWidth > 0 && rect.x + rect.width <= viewportWidth * 0.26) {
    return "left_nav";
  }
  if (viewportHeight > 0 && rect.y <= Math.max(120, viewportHeight * 0.12)) {
    return "header";
  }
  if (
    viewportHeight > 0 &&
    rect.y + rect.height >= viewportHeight * 0.88
  ) {
    return "footer";
  }

  return "main_content";
}

function buildElementAncestors(element) {
  const values = [];
  let current = element.parentElement;

  while (current instanceof HTMLElement && values.length < 4) {
    const label = summarizeAncestorElement(current, element);
    if (label && !values.includes(label)) {
      values.push(label);
    }
    current = current.parentElement;
  }

  return values;
}

function summarizeAncestorElement(ancestor, originElement) {
  const ownLabel = normalizeText(getElementLabel(ancestor));
  const ownText = normalizeText(getDirectNodeText(ancestor));
  const semanticName = summarizeSemanticTokens(ancestor);
  const originText = normalizeText(getElementText(originElement));
  const candidates = [ownLabel, ownText, semanticName].filter(Boolean);

  for (const candidate of candidates) {
    if (
      candidate &&
      candidate !== originText &&
      candidate.length >= 2 &&
      candidate.length <= 60
    ) {
      return candidate;
    }
  }

  return "";
}

function summarizeSemanticTokens(element) {
  const raw = collectElementSemanticTokens(element)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) {
    return "";
  }

  const tokens = raw
    .split(" ")
    .filter((token) => token && !/^\d+$/.test(token))
    .slice(0, 4);

  return normalizeText(tokens.join(" "));
}

function collectElementSemanticTokens(element) {
  const values = [];
  let current = element;
  let depth = 0;

  while (current instanceof HTMLElement && depth < 4) {
    values.push(current.id || "");
    values.push(typeof current.className === "string" ? current.className : "");
    values.push(current.getAttribute("role") || "");
    values.push(current.getAttribute("aria-label") || "");
    current = current.parentElement;
    depth += 1;
  }

  return values.join(" ").toLowerCase();
}

function isElementActive(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const ariaCurrent = element.getAttribute("aria-current");
  if (ariaCurrent && ariaCurrent !== "false") {
    return true;
  }

  const classTokens = `${element.id || ""} ${element.className || ""}`.toLowerCase();
  return /\b(active|isactive|selected|current|checked|open|expanded)\b/.test(
    classTokens,
  );
}

function isElementSelected(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const ariaSelected = element.getAttribute("aria-selected");
  if (ariaSelected === "true") {
    return true;
  }

  if ("selected" in element && typeof element.selected === "boolean") {
    return element.selected;
  }

  const classTokens = `${element.id || ""} ${element.className || ""}`.toLowerCase();
  return /\b(selected|isselected|checked)\b/.test(classTokens);
}

function getElementExpandedState(element) {
  if (!(element instanceof HTMLElement)) {
    return undefined;
  }

  const ariaExpanded = element.getAttribute("aria-expanded");
  if (ariaExpanded === "true") {
    return true;
  }
  if (ariaExpanded === "false") {
    return false;
  }

  const classTokens = `${element.id || ""} ${element.className || ""}`.toLowerCase();
  if (/\b(expanded|isopen|open)\b/.test(classTokens)) {
    return true;
  }
  if (/\b(collapsed|isclosed|closed)\b/.test(classTokens)) {
    return false;
  }

  return undefined;
}

function isSnapshotCandidate(element) {
  if (!(element instanceof Element)) {
    return false;
  }
  if (!isElementVisible(element)) {
    return false;
  }

  const tagName = element.tagName.toLowerCase();
  if (
    tagName === "input" &&
    element instanceof HTMLInputElement &&
    element.type?.toLowerCase() === "hidden"
  ) {
    return false;
  }

  return (
    element.matches(SNAPSHOT_CANDIDATE_SELECTOR) ||
    isHeuristicSnapshotCandidate(element)
  );
}

function isHeuristicSnapshotCandidate(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.matches(SNAPSHOT_CANDIDATE_SELECTOR)) {
    return false;
  }

  const text = normalizeText(getElementText(element));
  const style = window.getComputedStyle(element);
  const tabindex = element.getAttribute("tabindex");
  const classTokens = `${element.id || ""} ${element.className || ""}`.toLowerCase();
  const hasShortText = text && text.length <= 48;
  const hasSemanticDescendant = Boolean(element.querySelector(SNAPSHOT_CANDIDATE_SELECTOR));
  const hasPointerCue =
    style.cursor === "pointer" ||
    element.hasAttribute("onclick") ||
    (tabindex !== null && tabindex !== "-1");
  const hasNavCue =
    /(menu|nav|tab|route|item|entry|option|action|button|btn|link)/.test(
      classTokens,
    ) && hasShortText;

  if (!hasShortText || hasSemanticDescendant) {
    return false;
  }

  return hasPointerCue || hasNavCue;
}

function isElementVisible(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isElementDisabled(element) {
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
    ? element.disabled
    : element.getAttribute("aria-disabled") === "true";
}

function isEditableElement(element) {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return true;
  }

  return element instanceof HTMLElement ? element.isContentEditable : false;
}

function isSensitiveElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element instanceof HTMLInputElement) {
    const type = (element.type || "").toLowerCase();
    if (["password", "file", "hidden"].includes(type)) {
      return true;
    }
  }

  const sensitivePattern =
    /(password|passcode|secret|token|otp|one-time|credit|card|cvv|cvc|ssn|social security)/i;
  const attributes = [
    element.getAttribute("autocomplete"),
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("aria-label"),
    "placeholder" in element ? element.placeholder : "",
    getElementLabel(element),
  ]
    .filter(Boolean)
    .join(" ");

  return sensitivePattern.test(attributes);
}

function hasElementValue(element) {
  if (!hasRawValue(element) || isSensitiveElement(element)) {
    return false;
  }
  return Boolean(getRawElementValue(element));
}

function hasRawValue(element) {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}

function getRawElementValue(element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value || "";
  }
  if (element instanceof HTMLSelectElement) {
    return element.value || "";
  }
  return "";
}

function setElementTextValue(element, text, shouldClear) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const valueSetter = getValueSetter(element);
    const nextValue = shouldClear ? text : `${element.value || ""}${text}`;

    valueSetter.call(element, nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (element instanceof HTMLSelectElement) {
    const matchingOption = Array.from(element.options).find(
      (option) =>
        option.value === text || normalizeText(option.textContent || "") === text,
    );
    if (!matchingOption) {
      throw new Error(`No matching option found for "${text}".`);
    }

    element.value = matchingOption.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    if (shouldClear) {
      element.textContent = text;
    } else {
      element.textContent = `${element.textContent || ""}${text}`;
    }

    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    return;
  }

  throw new Error("Unsupported editable element.");
}

function getValueSetter(element) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  return (
    descriptor?.set ||
    function fallbackValueSetter(nextValue) {
      this.value = nextValue;
    }
  );
}

function dispatchKeyboardEnter(element) {
  dispatchKeyboardKey(element, "Enter");
}

function dispatchKeyboardKey(element, key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    return;
  }

  const keyboardEventOptions = {
    bubbles: true,
    cancelable: true,
    key: normalizedKey,
    code: normalizedKey,
  };
  element.dispatchEvent(new KeyboardEvent("keydown", keyboardEventOptions));
  element.dispatchEvent(new KeyboardEvent("keyup", keyboardEventOptions));
}

function focusElement(element) {
  if ("focus" in element && typeof element.focus === "function") {
    element.focus({ preventScroll: true });
  }
}

function scrollElementIntoView(element) {
  if ("scrollIntoView" in element && typeof element.scrollIntoView === "function") {
    element.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "auto",
    });
  }
}

function getElementLabel(element) {
  if (!(element instanceof Element)) {
    return "";
  }

  if ("labels" in element && Array.isArray(Array.from(element.labels || []))) {
    const labelText = Array.from(element.labels || [])
      .map((label) => label.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (labelText) {
      return labelText;
    }
  }

  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    ""
  );
}

function getElementText(element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value || element.placeholder || getElementLabel(element);
  }
  if (element instanceof HTMLSelectElement) {
    return element.selectedOptions?.[0]?.textContent || getElementLabel(element);
  }

  return (
    element.textContent ||
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    ""
  );
}

function getDirectNodeText(element) {
  if (!(element instanceof Element)) {
    return "";
  }

  return normalizeText(
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" "),
  );
}

function getDocumentTextExcerpt() {
  const text = normalizeText(document.body?.innerText || "");
  return truncateText(text, MAX_SNAPSHOT_TEXT_LENGTH);
}

function buildElementSelector(element) {
  if (!(element instanceof Element)) {
    return "";
  }

  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const attributeCandidates = [
    ["data-testid", element.getAttribute("data-testid")],
    ["data-test", element.getAttribute("data-test")],
    ["data-qa", element.getAttribute("data-qa")],
    ["name", element.getAttribute("name")],
    ["aria-label", element.getAttribute("aria-label")],
    ["placeholder", element.getAttribute("placeholder")],
  ];

  for (const [attributeName, attributeValue] of attributeCandidates) {
    if (!attributeValue) {
      continue;
    }

    const selector = `${element.tagName.toLowerCase()}[${attributeName}="${CSS.escape(attributeValue)}"]`;
    if (document.querySelectorAll(selector).length === 1) {
      return selector;
    }
  }

  return buildDomPathSelector(element);
}

function buildDomPathSelector(element) {
  const segments = [];
  let current = element;

  while (current instanceof Element && segments.length < 5) {
    let segment = current.tagName.toLowerCase();
    if (current.id) {
      segment += `#${CSS.escape(current.id)}`;
      segments.unshift(segment);
      break;
    }

    const parent = current.parentElement;
    if (parent) {
      const siblingTagMatches = Array.from(parent.children).filter(
        (sibling) => sibling.tagName === current.tagName,
      );
      if (siblingTagMatches.length > 1) {
        segment += `:nth-of-type(${siblingTagMatches.indexOf(current) + 1})`;
      }
    }

    segments.unshift(segment);
    current = current.parentElement;
  }

  return segments.join(" > ");
}

function summarizeDescriptor(descriptor) {
  const label =
    descriptor.label ||
    descriptor.text ||
    descriptor.placeholder ||
    descriptor.selector ||
    descriptor.id;
  return `${descriptor.kind} "${truncateText(label, 60)}"`;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
