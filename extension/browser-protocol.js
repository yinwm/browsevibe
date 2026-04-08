export const BROWSER_PROTOCOL_VERSION = 2;

export const SUPPORTED_BROWSER_ACTIONS = Object.freeze([
  "browser.find",
  "browser.click",
  "browser.type",
  "browser.press",
  "browser.wait",
  "browser.extract",
  "browser.scroll",
]);

export const INTERNAL_BROWSER_ACTIONS = Object.freeze(["browser.snapshot"]);
export const EXTERNALLY_VISIBLE_BROWSER_ACTIONS = Object.freeze(
  SUPPORTED_BROWSER_ACTIONS,
);

export const WRITE_BROWSER_ACTIONS = new Set([
  "browser.click",
  "browser.type",
  "browser.press",
]);

const SUPPORTED_BROWSER_ACTION_SET = new Set(SUPPORTED_BROWSER_ACTIONS);
const INTERNAL_BROWSER_ACTION_SET = new Set(INTERNAL_BROWSER_ACTIONS);
const DEFAULT_MAX_KINDS = 8;
const DEFAULT_MAX_LIMIT = 12;
const DEFAULT_MAX_REGIONS = 6;
const DEFAULT_MAX_TIMEOUT_MS = 15000;

const DEFAULT_PROTOCOL_OPTIONS = Object.freeze({
  allowStringTarget: true,
  allowSelectorTarget: false,
  allowInternalActions: false,
  allowLegacyTopLevelTargetFields: true,
  limitMax: DEFAULT_MAX_LIMIT,
  maxKinds: DEFAULT_MAX_KINDS,
  maxRegions: DEFAULT_MAX_REGIONS,
  timeoutMaxMs: DEFAULT_MAX_TIMEOUT_MS,
});

export function normalizeBrowserAction(action, options = {}) {
  if (!action || typeof action !== "object") {
    return null;
  }

  const settings = resolveProtocolOptions(options);
  const actionType = normalizeActionType(action, settings);
  if (!actionType) {
    return null;
  }

  const normalized = {
    action: actionType,
    protocolVersion: BROWSER_PROTOCOL_VERSION,
  };

  const rawTarget = Object.prototype.hasOwnProperty.call(action, "target")
    ? action.target
    : settings.allowLegacyTopLevelTargetFields
      ? action
      : null;
  const target = normalizeBrowserActionTargetInput(rawTarget, settings);
  if (target) {
    normalized.target = target;
  }

  if (typeof action.text === "string") {
    normalized.text = action.text;
  }
  if (typeof action.query === "string") {
    normalized.query = action.query;
  }
  if (typeof action.key === "string" && action.key.trim()) {
    normalized.key = action.key.trim();
  }

  const kinds = normalizeBrowserActionKindsInput(action.kinds, settings);
  if (kinds.length > 0) {
    normalized.kinds = kinds;
  }

  const limit = normalizeBrowserActionLimitInput(action.limit, settings);
  if (limit !== null) {
    normalized.limit = limit;
  }

  const regions = normalizeBrowserActionRegionsInput(action.regions, settings);
  if (regions.length > 0) {
    normalized.regions = regions;
  }

  const excludeRegions = normalizeBrowserActionRegionsInput(
    action.excludeRegions,
    settings,
  );
  if (excludeRegions.length > 0) {
    normalized.excludeRegions = excludeRegions;
  }

  const until = normalizeBrowserActionUntilInput(action.until, settings);
  if (until) {
    normalized.until = until;
  }

  const timeoutMs = normalizeBrowserActionTimeoutInput(action.timeoutMs, settings);
  if (timeoutMs !== null) {
    normalized.timeoutMs = timeoutMs;
  }

  const direction = normalizeBrowserActionDirectionInput(action.direction);
  if (direction) {
    normalized.direction = direction;
  }

  const amount = normalizeBrowserActionAmountInput(action.amount);
  if (amount !== null) {
    normalized.amount = amount;
  }

  if (action.clear === false) {
    normalized.clear = false;
  }
  if (action.submit === true) {
    normalized.submit = true;
  }

  return normalized;
}

export function validateBrowserAction(action, options = {}) {
  if (!action || typeof action !== "object") {
    return {
      ok: false,
      error: {
        code: "invalid_payload",
        message: "Browser action payload must be a JSON object.",
        allowedActions: EXTERNALLY_VISIBLE_BROWSER_ACTIONS,
      },
    };
  }

  const settings = resolveProtocolOptions(options);
  const rawActionType =
    typeof action.action === "string"
      ? action.action.trim()
      : typeof action.type === "string"
        ? action.type.trim()
        : "";

  if (!rawActionType) {
    return {
      ok: false,
      error: {
        code: "missing_action",
        message: 'Browser action JSON must include an "action" field.',
        allowedActions: EXTERNALLY_VISIBLE_BROWSER_ACTIONS,
      },
    };
  }

  if (SUPPORTED_BROWSER_ACTION_SET.has(rawActionType)) {
    const normalized = normalizeBrowserAction(action, settings);
    return normalized
      ? { ok: true, request: normalized }
      : {
          ok: false,
          error: {
            code: "invalid_payload",
            message: `Could not normalize ${rawActionType}.`,
            allowedActions: EXTERNALLY_VISIBLE_BROWSER_ACTIONS,
          },
        };
  }

  if (settings.allowInternalActions && INTERNAL_BROWSER_ACTION_SET.has(rawActionType)) {
    const normalized = normalizeBrowserAction(action, settings);
    return normalized
      ? { ok: true, request: normalized }
      : {
          ok: false,
          error: {
            code: "invalid_payload",
            message: `Could not normalize ${rawActionType}.`,
            allowedActions: EXTERNALLY_VISIBLE_BROWSER_ACTIONS,
          },
        };
  }

  return {
    ok: false,
    error: {
      code: "unsupported_action",
      unsupportedAction: rawActionType,
      message: `${rawActionType} is not a supported browser action.`,
      allowedActions: EXTERNALLY_VISIBLE_BROWSER_ACTIONS,
      hint: buildUnsupportedActionHint(rawActionType),
    },
  };
}

export function normalizeBrowserActionTargetInput(value, options = {}) {
  if (!value) {
    return null;
  }

  const settings = resolveProtocolOptions(options);

  if (typeof value === "string") {
    if (!settings.allowStringTarget) {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (/^el-\d+$/i.test(trimmed)) {
      return { elementId: trimmed };
    }

    return settings.allowSelectorTarget ? { selector: trimmed } : null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const elementId =
    typeof value.elementId === "string" ? value.elementId.trim() : "";
  const observationId =
    typeof value.observationId === "string" ? value.observationId.trim() : "";
  const selector =
    settings.allowSelectorTarget && typeof value.selector === "string"
      ? value.selector.trim()
      : "";

  if (!elementId && !observationId && !selector) {
    return null;
  }

  return {
    elementId: elementId || undefined,
    observationId: observationId || undefined,
    selector: selector || undefined,
  };
}

export function normalizeBrowserActionKindsInput(value, options = {}) {
  const settings = resolveProtocolOptions(options);
  return normalizeStringListInput(value, settings.maxKinds);
}

export function normalizeBrowserActionLimitInput(value, options = {}) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const settings = resolveProtocolOptions(options);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.max(1, Math.min(settings.limitMax, Math.round(numeric)));
}

export function normalizeBrowserActionRegionsInput(value, options = {}) {
  const settings = resolveProtocolOptions(options);
  return normalizeStringListInput(value, settings.maxRegions);
}

export function normalizeBrowserActionUntilInput(value, options = {}) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const settings = resolveProtocolOptions(options);
  const normalized = {};

  if (typeof value.urlIncludes === "string" && value.urlIncludes.trim()) {
    normalized.urlIncludes = value.urlIncludes.trim();
  }
  if (typeof value.titleIncludes === "string" && value.titleIncludes.trim()) {
    normalized.titleIncludes = value.titleIncludes.trim();
  }
  if (typeof value.textIncludes === "string" && value.textIncludes.trim()) {
    normalized.textIncludes = value.textIncludes.trim();
  }
  if (typeof value.query === "string" && value.query.trim()) {
    normalized.query = value.query.trim();
  }

  const kinds = normalizeBrowserActionKindsInput(value.kinds, settings);
  if (kinds.length > 0) {
    normalized.kinds = kinds;
  }

  const regions = normalizeBrowserActionRegionsInput(value.regions, settings);
  if (regions.length > 0) {
    normalized.regions = regions;
  }

  const excludeRegions = normalizeBrowserActionRegionsInput(
    value.excludeRegions,
    settings,
  );
  if (excludeRegions.length > 0) {
    normalized.excludeRegions = excludeRegions;
  }

  if (value.state === "disappear") {
    normalized.state = "disappear";
  } else if (
    normalized.query ||
    normalized.urlIncludes ||
    normalized.titleIncludes ||
    normalized.textIncludes
  ) {
    normalized.state = "appear";
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function normalizeBrowserActionTimeoutInput(value, options = {}) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const settings = resolveProtocolOptions(options);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.max(100, Math.min(settings.timeoutMaxMs, Math.round(numeric)));
}

export function normalizeBrowserActionDirectionInput(value) {
  if (typeof value !== "string") {
    return "";
  }

  const direction = value.trim().toLowerCase();
  return ["up", "down", "left", "right"].includes(direction) ? direction : "";
}

export function normalizeBrowserActionAmountInput(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (["page", "viewport"].includes(trimmed)) {
    return trimmed;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

export function extractBrowserActionFromContent(content, options = {}) {
  const inspection = inspectBrowserActionFromContent(content, options);
  return inspection.status === "valid" ? inspection.request : null;
}

export function inspectBrowserActionFromContent(content, options = {}) {
  if (typeof content !== "string") {
    return { status: "none" };
  }

  const candidates = [];
  const browserActionMatch = content.match(/```browser-action\s*([\s\S]*?)```/i);
  if (browserActionMatch?.[1]) {
    candidates.push(browserActionMatch[1]);
  }

  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match?.[1]) {
      candidates.push(match[1]);
    }
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push(trimmed);
  }

  let firstInvalid = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const validation = validateBrowserAction(parsed, options);
      if (validation.ok) {
        return {
          status: "valid",
          request: validation.request,
          rawAction: parsed,
          candidate,
        };
      }
      if (!firstInvalid) {
        firstInvalid = {
          status: "invalid",
          request: coerceBrowserActionForDisplay(parsed),
          rawAction: parsed,
          error: validation.error,
          candidate,
        };
      }
    } catch (error) {
      if (!firstInvalid) {
        firstInvalid = {
          status: "invalid",
          request: {
            action: "",
          },
          rawAction: null,
          error: {
            code: "invalid_json",
            message: "Browser action block must contain valid JSON.",
            allowedActions: EXTERNALLY_VISIBLE_BROWSER_ACTIONS,
          },
          candidate,
        };
      }
    }
  }

  return firstInvalid || { status: "none" };
}

function normalizeActionType(action, settings) {
  const actionType =
    typeof action.action === "string"
      ? action.action.trim()
      : typeof action.type === "string"
        ? action.type.trim()
        : "";

  if (SUPPORTED_BROWSER_ACTION_SET.has(actionType)) {
    return actionType;
  }

  if (settings?.allowInternalActions && INTERNAL_BROWSER_ACTION_SET.has(actionType)) {
    return actionType;
  }

  return "";
}

function resolveProtocolOptions(options) {
  return {
    ...DEFAULT_PROTOCOL_OPTIONS,
    ...(options && typeof options === "object" ? options : {}),
  };
}

function normalizeStringListInput(value, maxItems) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
}

function buildUnsupportedActionHint(actionType) {
  switch (actionType) {
    case "browser.screenshot":
      return "If you need to inspect the page, use browser.find or browser.extract instead.";
    case "browser.select":
      return "Use browser.click, browser.type, or browser.press to interact with dropdowns.";
    case "browser.navigate":
      return "Use browser.click followed by browser.wait to move through the site.";
    default:
      return "Use one of the supported browser actions instead of inventing a new one.";
  }
}

function coerceBrowserActionForDisplay(action) {
  if (!action || typeof action !== "object") {
    return { action: "" };
  }

  return {
    action:
      typeof action.action === "string"
        ? action.action.trim()
        : typeof action.type === "string"
          ? action.type.trim()
          : "",
    query: typeof action.query === "string" ? action.query : undefined,
    key: typeof action.key === "string" ? action.key : undefined,
    target:
      action.target && typeof action.target === "object"
        ? {
            observationId:
              typeof action.target.observationId === "string"
                ? action.target.observationId
                : undefined,
            elementId:
              typeof action.target.elementId === "string"
                ? action.target.elementId
                : undefined,
          }
        : undefined,
  };
}
