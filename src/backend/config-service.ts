import {
  DEFAULT_CONFIG,
  appConfig,
  getConfigKeys,
  isSecretConfigKey,
  updateConfigValues,
  type AppConfig,
} from "../core/config.js";

function maskValue(value: unknown): {hasValue: boolean; tail: string} {
  const text = typeof value === "string" ? value : "";
  return {
    hasValue: Boolean(text),
    tail: text ? text.slice(-4) : "",
  };
}

export function getConfigForUi(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of getConfigKeys()) {
    if (isSecretConfigKey(String(key))) {
      result[key] = maskValue(appConfig[key]);
    } else {
      result[key] = appConfig[key] ?? DEFAULT_CONFIG[key];
    }
  }
  return result;
}

export function updateConfigFromUi(patch: Record<string, unknown>): Record<string, unknown> {
  const cleanPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_CONFIG)) {
      continue;
    }
    if (isSecretConfigKey(key)) {
      if (value === null) {
        cleanPatch[key] = "";
        continue;
      }
      if (typeof value === "string" && value.length > 0) {
        cleanPatch[key] = value as never;
      }
      continue;
    }
    cleanPatch[key as keyof AppConfig] = value as never;
  }
  updateConfigValues(cleanPatch);
  return getConfigForUi();
}
