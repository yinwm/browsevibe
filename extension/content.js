const MAX_SELECTION_LENGTH = 4000;
const MAX_HEADING_COUNT = 5;
const MAX_SNAPSHOT_ELEMENTS = 30;
const MAX_SNAPSHOT_TEXT_LENGTH = 400;
const DEFAULT_FIND_RESULTS_LIMIT = 8;
const MAX_FIND_RESULTS_LIMIT = 12;
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

let latestSnapshotElements = new Map();

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
  const normalizedAction = normalizeBrowserAction(action);
  if (!normalizedAction) {
    return { ok: false, error: "Invalid browser action payload." };
  }

  switch (normalizedAction.action) {
    case "browser.snapshot":
      return {
        ok: true,
        result: {
          snapshot: collectBrowserSnapshot(),
        },
      };
    case "browser.extract":
      return executeExtractAction(normalizedAction);
    case "browser.find":
      return executeFindAction(normalizedAction);
    case "browser.click":
      return executeClickAction(normalizedAction);
    case "browser.type":
      return executeTypeAction(normalizedAction);
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

function collectBrowserSnapshot() {
  const registry = collectBrowserSnapshotRegistry(MAX_SNAPSHOT_ELEMENTS);
  latestSnapshotElements = registry.elementMap;
  return buildBrowserSnapshotFromDescriptors(registry.descriptors);
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
    pageTitle: document.title || "",
    canonicalUrl: location.href,
    observedAt: Date.now(),
    textExcerpt: getDocumentTextExcerpt(),
    elements: descriptors.slice(0, MAX_SNAPSHOT_ELEMENTS),
  };
}

function executeExtractAction(action) {
  const snapshot = collectBrowserSnapshot();
  const resolvedTarget = action.target
    ? resolveActionTarget(action.target)
    : null;

  if (action.target && !resolvedTarget?.ok) {
    return {
      ok: false,
      error: resolvedTarget.error,
      result: {
        snapshot,
      },
    };
  }

  if (!resolvedTarget) {
    return {
      ok: true,
      result: {
        extracted: {
          pageTitle: snapshot.pageTitle,
          canonicalUrl: snapshot.canonicalUrl,
          textExcerpt: snapshot.textExcerpt,
          elementCount: snapshot.elements.length,
        },
        snapshot,
      },
    };
  }

  return {
    ok: true,
    result: {
      extracted: extractElementContent(resolvedTarget.element),
      target: resolvedTarget.descriptor,
      snapshot,
    },
  };
}

function executeClickAction(action) {
  const resolvedTarget = resolveActionTarget(action.target);
  if (!resolvedTarget.ok) {
    return {
      ok: false,
      error: resolvedTarget.error,
    };
  }

  const { element, descriptor } = resolvedTarget;
  if (!isElementVisible(element)) {
    return {
      ok: false,
      error: "Target element is not visible.",
      result: {
        target: descriptor,
      },
    };
  }

  if (isElementDisabled(element)) {
    return {
      ok: false,
      error: "Target element is disabled.",
      result: {
        target: descriptor,
      },
    };
  }

  scrollElementIntoView(element);
  focusElement(element);
  element.click();

  return {
    ok: true,
    result: {
      target: descriptor,
      summary: `Clicked ${summarizeDescriptor(descriptor)}.`,
    },
  };
}

function executeFindAction(action) {
  const query = normalizeText(action.query || "");
  if (!query) {
    return {
      ok: false,
      error: "browser.find requires a query string.",
    };
  }

  const registry = collectBrowserSnapshotRegistry();
  latestSnapshotElements = registry.elementMap;

  const matches = registry.descriptors
    .filter((descriptor) => descriptorMatchesFindKinds(descriptor, action.kinds))
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
      score: Number(descriptor.score.toFixed(2)),
    }));

  return {
    ok: true,
    result: {
      matches,
      summary: buildFindSummary(query, matches),
      snapshot: buildBrowserSnapshotFromDescriptors(registry.descriptors),
    },
  };
}

function executeTypeAction(action) {
  if (typeof action.text !== "string") {
    return {
      ok: false,
      error: "browser.type requires a text string.",
    };
  }

  const resolvedTarget = resolveActionTarget(action.target);
  if (!resolvedTarget.ok) {
    return {
      ok: false,
      error: resolvedTarget.error,
    };
  }

  const { element, descriptor } = resolvedTarget;
  if (!isEditableElement(element)) {
    return {
      ok: false,
      error: "Target element is not editable.",
      result: {
        target: descriptor,
      },
    };
  }

  if (isSensitiveElement(element)) {
    return {
      ok: false,
      error: "Sensitive inputs are blocked for browser.type.",
      result: {
        target: {
          ...descriptor,
          sensitive: true,
        },
      },
    };
  }

  if (isElementDisabled(element)) {
    return {
      ok: false,
      error: "Target element is disabled.",
      result: {
        target: descriptor,
      },
    };
  }

  scrollElementIntoView(element);
  focusElement(element);
  setElementTextValue(element, action.text, action.clear !== false);

  if (action.submit) {
    dispatchKeyboardEnter(element);
  }

  return {
    ok: true,
    result: {
      target: descriptor,
      summary: `Typed into ${summarizeDescriptor(descriptor)}.`,
    },
  };
}

function normalizeBrowserAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  const actionType =
    typeof action.action === "string"
      ? action.action.trim()
      : typeof action.type === "string"
        ? action.type.trim()
        : "";

  if (!actionType) {
    return null;
  }

  const normalized = {
    action: actionType,
  };

  const target = normalizeActionTarget(action);
  if (target) {
    normalized.target = target;
  }

  if (typeof action.text === "string") {
    normalized.text = action.text;
  }
  if (typeof action.query === "string") {
    normalized.query = action.query;
  }
  const kinds = normalizeFindKindsInput(action.kinds);
  if (kinds.length > 0) {
    normalized.kinds = kinds;
  }
  const limit = normalizeFindLimitInput(action.limit);
  if (limit !== null) {
    normalized.limit = limit;
  }
  if (action.clear === false) {
    normalized.clear = false;
  }
  if (action.submit === true) {
    normalized.submit = true;
  }

  return normalized;
}

function normalizeActionTarget(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  return normalizeActionTargetInput(
    Object.prototype.hasOwnProperty.call(action, "target") ? action.target : action,
  );
}

function normalizeFindKindsInput(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter(Boolean),
    ),
  ).slice(0, 8);
}

function normalizeFindLimitInput(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.max(1, Math.min(MAX_FIND_RESULTS_LIMIT, Math.round(numeric)));
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

function normalizeActionTargetInput(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (/^el-\d+$/i.test(trimmed)) {
      return { elementId: trimmed };
    }

    return { selector: trimmed };
  }

  if (typeof value !== "object") {
    return null;
  }

  const elementId =
    typeof value.elementId === "string" ? value.elementId.trim() : "";
  const selector =
    typeof value.selector === "string" ? value.selector.trim() : "";

  if (!elementId && !selector) {
    return null;
  }

  return {
    elementId: elementId || undefined,
    selector: selector || undefined,
  };
}

function resolveActionTarget(target) {
  if (!target) {
    return {
      ok: false,
      error: "Browser action target is required.",
    };
  }

  let element = null;
  if (target.elementId && latestSnapshotElements.has(target.elementId)) {
    const snapshotElement = latestSnapshotElements.get(target.elementId);
    if (snapshotElement?.isConnected) {
      element = snapshotElement;
    }
  }

  if (!element && target.selector) {
    const selectorTarget = resolveTargetBySelector(target.selector);
    if (selectorTarget.error) {
      return {
        ok: false,
        error: selectorTarget.error,
      };
    }
    element = selectorTarget.element;
  }

  if (!element) {
    return {
      ok: false,
      error: "Could not resolve the requested page element.",
    };
  }

  return {
    ok: true,
    element,
    descriptor: describeSnapshotElement(
      element,
      target.elementId ||
        findSnapshotElementIdForNode(element) ||
        "selector-target",
    ),
  };
}

function resolveTargetBySelector(selector) {
  const normalizedSelector = String(selector || "").trim();
  if (!normalizedSelector) {
    return {
      element: null,
      error: "",
    };
  }

  const textSelector = resolveTextSelector(normalizedSelector);
  if (textSelector.matched) {
    return {
      element: textSelector.element,
      error: textSelector.error || "",
    };
  }

  const hasTextSelector = resolveHasTextSelector(normalizedSelector);
  if (hasTextSelector.matched) {
    return {
      element: hasTextSelector.element,
      error: hasTextSelector.error || "",
    };
  }

  try {
    return {
      element: document.querySelector(normalizedSelector),
      error: "",
    };
  } catch (error) {
    return {
      element: null,
      error: `Invalid selector: ${normalizedSelector}`,
    };
  }
}

function resolveTextSelector(selector) {
  const match = selector.match(/^text\s*=\s*(.+)$/i);
  if (!match?.[1]) {
    return {
      matched: false,
      element: null,
    };
  }

  const query = normalizeText(stripMatchingQuotes(match[1]));
  if (!query) {
    return {
      matched: true,
      element: null,
    };
  }

  const snapshotCandidates = Array.from(latestSnapshotElements.values()).filter(
    (element) => element?.isConnected && isElementVisible(element),
  );
  const element =
    findBestTextSelectorMatch(snapshotCandidates, query) ||
    findBestTextSelectorMatch(
      collectSnapshotCandidateElements(),
      query,
    );

  return {
    matched: true,
    element,
    error: "",
  };
}

function resolveHasTextSelector(selector) {
  const match = selector.match(/^(.*?)\s*:has-text\((.+)\)\s*$/i);
  if (!match) {
    return {
      matched: false,
      element: null,
      error: "",
    };
  }

  const baseSelector = String(match[1] || "").trim();
  const query = normalizeText(stripMatchingQuotes(match[2]));
  if (!query) {
    return {
      matched: true,
      element: null,
      error: "",
    };
  }

  let candidates = [];
  if (baseSelector) {
    try {
      candidates = Array.from(document.querySelectorAll(baseSelector));
    } catch (error) {
      return {
        matched: true,
        element: null,
        error: `Invalid selector: ${baseSelector}`,
      };
    }
  } else {
    candidates = collectSnapshotCandidateElements();
  }

  return {
    matched: true,
    element: findBestTextSelectorMatch(
      candidates.filter((element) => element?.isConnected && isElementVisible(element)),
      query,
    ),
    error: "",
  };
}

function findBestTextSelectorMatch(candidates, query) {
  let bestCandidate = null;
  let bestScore = 0;

  candidates.forEach((element) => {
    const score = scoreTextSelectorMatch(element, query);
    if (score > bestScore) {
      bestCandidate = element;
      bestScore = score;
    }
  });

  return bestCandidate;
}

function scoreTextSelectorMatch(element, query) {
  if (!(element instanceof Element)) {
    return 0;
  }

  const values = [
    getElementLabel(element),
    getElementText(element),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("placeholder"),
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  let score = 0;
  values.forEach((value) => {
    if (value === query) {
      score = Math.max(score, 100);
    } else if (value.startsWith(query)) {
      score = Math.max(score, 70 - Math.max(0, value.length - query.length));
    } else if (value.includes(query)) {
      const extraLength = Math.max(0, value.length - query.length);
      if (query.length >= 3 || extraLength <= 2) {
        score = Math.max(score, 40 - extraLength);
      }
    }
  });

  return score;
}

function descriptorMatchesFindKinds(descriptor, kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return true;
  }

  const kind = String(descriptor.kind || "").toLowerCase();
  const tagName = String(descriptor.tagName || "").toLowerCase();
  return kinds.includes(kind) || kinds.includes(tagName);
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

  const topDelta = (left.rect?.y ?? 0) - (right.rect?.y ?? 0);
  if (topDelta !== 0) {
    return topDelta;
  }

  return (left.rect?.x ?? 0) - (right.rect?.x ?? 0);
}

function normalizeFindLimit(value) {
  return normalizeFindLimitInput(value) || DEFAULT_FIND_RESULTS_LIMIT;
}

function buildFindSummary(query, matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return `Found no matching elements for "${truncateText(query, 80)}".`;
  }

  return `Found ${matches.length} matching element${
    matches.length === 1 ? "" : "s"
  } for "${truncateText(query, 80)}".`;
}

function stripMatchingQuotes(value) {
  const text = String(value || "").trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
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
  const keyboardEventOptions = {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    code: "Enter",
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
