export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<T>;
}

export async function apiSend<T>(url: string, method: "POST" | "PUT" | "DELETE", body: unknown = {}): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: method === "DELETE" ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<T>;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as {error?: string};
    return payload.error || text;
  } catch {
    return text;
  }
}

export interface UsageWindow {
    window_key: string;
    label: string;
    used_percent: number | null;
    remaining_percent: number | null;
    reset_at: string | null;
    limit_reached: boolean | number | null;
}

export interface Account {
    id: number;
    email: string;
    provider: string | null;
    status: string;
    status_code: string | null;
    status_label: string | null;
    credential_type: string | null;
    plan: string | null;
    remaining_percent: number | null;
    used_percent: number | null;
    reset_at: string | null;
    last_check_at: string | null;
    last_refresh_at: string | null;
    last_auth_at: string | null;
    last_error: string | null;
    auto_reauth: number;
    created_at: string;
    updated_at: string;
    auth_file_path: string | null;
    auth_file_name: string | null;
    auth_credential_type: string | null;
    current_step: string | null;
    step_status: string | null;
    last_step_at: string | null;
    usage_windows: UsageWindow[];
}

export interface Job {
    id: number;
    type: string;
    status: string;
    title: string;
    error: string | null;
    waiting_for_input: number;
    input_prompt: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
}

export interface JobEvent {
    id: number;
    job_id: number;
    level: string;
    message: string;
    created_at: string;
}

export interface MailSource {
    id: number;
    name: string;
    provider: string;
    mail_type_id: number | null;
    mail_type_key: string | null;
    mail_type_name: string | null;
    subtype: string | null;
    vendor: string | null;
    batch_note: string | null;
    enabled: boolean;
    supports_auto_code: boolean;
    mailbox_count: number;
    unused_count: number;
    used_count: number;
    failed_count: number;
    has_config: boolean;
    created_at: string;
    updated_at: string;
}

export interface MailType {
    id: number;
    key: string;
    provider: string;
    name: string;
    subtype: string | null;
    domain_hint: string | null;
    supports_auto_code: boolean;
    enabled: boolean;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

export interface Mailbox {
    id: number;
    source_id: number;
    source_name: string;
    mail_type_id: number | null;
    mail_type_key: string | null;
    mail_type_name: string | null;
    subtype: string | null;
    email: string;
    provider: string;
    status: string;
    used: number;
    has_password: boolean;
    has_client_id: boolean;
    has_refresh_token: boolean;
    has_access_token: boolean;
    supports_auto_code: number;
    last_code_status: string | null;
    last_code_at: string | null;
    last_used_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
}

export interface LatestEmail {
    id?: string;
    sender?: string;
    recipient?: string | string[];
    subject?: string;
    content?: string;
    html?: string;
    snippet?: string;
    receivedAt?: string;
    timestamp?: number;
    verificationCode?: string;
}

export interface HeroSmsCountry {
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

export interface HeroSmsPrice {
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
