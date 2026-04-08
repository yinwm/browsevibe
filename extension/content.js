const MAX_SELECTION_LENGTH = 4000;
const MAX_HEADING_COUNT = 5;
const MAX_SNAPSHOT_ELEMENTS = 30;
const MAX_SNAPSHOT_TEXT_LENGTH = 400;
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
  const snapshotElements = [];
  const nextSnapshotElements = new Map();

  Array.from(document.querySelectorAll(SNAPSHOT_CANDIDATE_SELECTOR))
    .filter((element) => isSnapshotCandidate(element))
    .slice(0, MAX_SNAPSHOT_ELEMENTS)
    .forEach((element, index) => {
      const elementId = `el-${index + 1}`;
      const descriptor = describeSnapshotElement(element, elementId);
      if (!descriptor) {
        return;
      }

      nextSnapshotElements.set(elementId, element);
      snapshotElements.push(descriptor);
    });

  latestSnapshotElements = nextSnapshotElements;

  return {
    pageTitle: document.title || "",
    canonicalUrl: location.href,
    observedAt: Date.now(),
    textExcerpt: getDocumentTextExcerpt(),
    elements: snapshotElements,
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

  const targetSource =
    action.target && typeof action.target === "object" ? action.target : action;
  const elementId =
    typeof targetSource.elementId === "string"
      ? targetSource.elementId.trim()
      : "";
  const selector =
    typeof targetSource.selector === "string"
      ? targetSource.selector.trim()
      : "";

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
    try {
      element = document.querySelector(target.selector);
    } catch (error) {
      return {
        ok: false,
        error: `Invalid selector: ${target.selector}`,
      };
    }
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
    checked:
      "checked" in element && typeof element.checked === "boolean"
        ? element.checked
        : undefined,
    filled: hasElementValue(element),
    sensitive: isSensitiveElement(element),
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
  return tagName;
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

  return true;
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
