import {Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit} from "undici";
import {appConfig} from "../core/config.js";

const HERO_SMS_DEFAULT_BASE_URL = "https://hero-sms.com/stubs/handler_api.php";

export interface HeroSmsCountryItem {
  countryId: number;
  countryName: string;
  countryNameEn: string;
  countryNameRu: string;
  phoneCode: string;
  visible: boolean | null;
  retry: boolean | null;
  rent: boolean | null;
  multiService: boolean | null;
}

export interface HeroSmsPriceItem {
  countryId: number;
  countryName: string;
  phoneCode: string;
  service: string;
  price: number | null;
  currency: string;
  available: number | null;
}

export interface HeroSmsBalance {
  balance: number | null;
  currency: string;
  raw: string;
}

function buildDispatcher() {
  return new Agent({
    connect: {rejectUnauthorized: false},
  });
}

async function requestHeroSms(action: string, query: Record<string, unknown> = {}): Promise<unknown> {
  const apiKey = String(appConfig.heroSMSApiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("HeroSMS API Key 未配置");
  }
  const url = new URL(HERO_SMS_DEFAULT_BASE_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  const response = await undiciFetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    dispatcher: buildDispatcher(),
  } satisfies UndiciRequestInit);
  const text = (await response.text()).trim();
  const payload = parsePayload(text);
  if (!response.ok) {
    throw new Error(`HeroSMS ${action} HTTP ${response.status}: ${formatPayload(payload)}`);
  }
  if (typeof payload === "string" && /^(BAD_|NO_|ERROR_|WRONG_|BANNED)/i.test(payload)) {
    throw new Error(`HeroSMS ${action}: ${payload}`);
  }
  return payload;
}

function parsePayload(text: string): unknown {
  if (!text) {
    return "";
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function asArray(payload: unknown, primitiveKey = "value"): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["data", "countries", "items", "list"]) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }
    return Object.entries(record).map(([key, value]) => {
      if (value && typeof value === "object") {
        return {country: key, ...(value as Record<string, unknown>)};
      }
      return {country: key, [primitiveKey]: value};
    });
  }
  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (value != null && typeof value === "object") {
      continue;
    }
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    const text = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(text)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(text)) {
      return false;
    }
  }
  return null;
}

export async function getHeroSmsCountries(): Promise<{countries: HeroSmsCountryItem[]; error?: string}> {
  try {
    const payload = await requestHeroSms("getCountries");
    const countries = asArray(payload, "name")
      .map((item) => {
        const record = item as Record<string, unknown>;
        const countryId = firstNumber(record.id, record.country, record.countryId, record.country_id);
        if (countryId == null) {
          return null;
        }
        const countryName = firstString(
          record.chn,
          record.zh,
          record.name,
          record.title,
          record.countryName,
          record.country_name,
          record.eng,
          record.en,
          record.rus,
          record.ru,
          record.value,
        );
        return {
          countryId,
          countryName: countryName || `国家 ID: ${countryId}`,
          countryNameEn: firstString(record.eng, record.en),
          countryNameRu: firstString(record.rus, record.ru),
          phoneCode: firstString(record.phoneCode, record.phone_code, record.prefix, record.code),
          visible: firstBoolean(record.visible),
          retry: firstBoolean(record.retry),
          rent: firstBoolean(record.rent),
          multiService: firstBoolean(record.multiService, record.multi_service),
        };
      })
      .filter((item): item is HeroSmsCountryItem => item !== null)
      .sort((left, right) => left.countryId - right.countryId);
    return {countries};
  } catch (error) {
    return {countries: [], error: error instanceof Error ? error.message : String(error)};
  }
}

export async function getHeroSmsBalance(): Promise<{balance: HeroSmsBalance | null; error?: string}> {
  try {
    const payload = await requestHeroSms("getBalance");
    return {balance: normalizeBalance(payload)};
  } catch (error) {
    return {balance: null, error: error instanceof Error ? error.message : String(error)};
  }
}

export async function getHeroSmsPrices(country: number, service = "dr"): Promise<{prices: HeroSmsPriceItem[]; error?: string}> {
  try {
    const payload = await requestHeroSms("getPrices", {country, service});
    const prices = normalizePrices(payload, country, service);
    return {prices};
  } catch (error) {
    return {prices: [], error: error instanceof Error ? error.message : String(error)};
  }
}

function normalizeBalance(payload: unknown): HeroSmsBalance {
  if (typeof payload === "string") {
    const raw = payload.trim();
    const matched = raw.match(/ACCESS_BALANCE:([+-]?\d+(?:\.\d+)?)/i);
    return {
      balance: matched ? Number(matched[1]) : firstNumber(raw),
      currency: "",
      raw,
    };
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    return {
      balance: firstNumber(record.balance, record.amount, record.value, record.money),
      currency: firstString(record.currency, record.currencyName),
      raw: formatPayload(payload),
    };
  }
  return {
    balance: firstNumber(payload),
    currency: "",
    raw: formatPayload(payload),
  };
}

function normalizePrices(payload: unknown, country: number, service: string): HeroSmsPriceItem[] {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const countryPayload = record[String(country)];
    if (countryPayload && countryPayload !== payload) {
      return normalizePrices(countryPayload, country, service);
    }
    const servicePayload = record[service] ?? record[service.toLowerCase()] ?? record[service.toUpperCase()];
    if (servicePayload && servicePayload !== payload) {
      return normalizePrices(servicePayload, country, service);
    }
    const directPrice = firstNumber(record.price, record.cost, record.activationCost, record.value);
    const directAvailable = firstNumber(record.count, record.available, record.quantity, record.physicalCount);
    if (directPrice != null || directAvailable != null) {
      return [{
        countryId: firstNumber(record.country, record.countryId, record.country_id, country) ?? country,
        countryName: firstString(record.countryName, record.country_name, record.name, country),
        phoneCode: firstString(record.phoneCode, record.phone_code, record.prefix),
        service: firstString(record.service, service),
        price: directPrice,
        currency: firstString(record.currency, record.currencyName),
        available: directAvailable,
      }];
    }
  }
  const items = asArray(payload, "price");
  return items.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      countryId: firstNumber(record.country, record.countryId, record.country_id, country) ?? country,
      countryName: firstString(record.countryName, record.country_name, record.name, country),
      phoneCode: firstString(record.phoneCode, record.phone_code, record.prefix),
      service: firstString(record.service, service),
      price: firstNumber(record.price, record.cost, record.activationCost, record.value),
      currency: firstString(record.currency, record.currencyName),
      available: firstNumber(record.count, record.available, record.quantity, record.physicalCount),
    };
  });
}
