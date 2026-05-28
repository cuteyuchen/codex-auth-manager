/**
 * 前后端共享的状态码、标签、凭据类型等常量。
 * 后端 import from "../shared/constants.js"
 * 前端 import from "../../shared/constants"
 */

// 账号状态码 → 中文标签 + Element Plus tag type
export const ACCOUNT_STATUSES: Record<string, {label: string; type: string}> = {
  authorized:          {label: "正常",         type: "success"},
  quota_exhausted:     {label: "额度已用尽",   type: "warning"},
  credential_expired:  {label: "凭据过期",     type: "danger"},
  account_abnormal:    {label: "账号状态异常", type: "danger"},
  account_deactivated: {label: "账号已被封禁", type: "danger"},
  network_error:       {label: "网络请求失败", type: "warning"},
  needs_manual_reauth: {label: "需要人工重登", type: "danger"},
  unchecked:           {label: "未检查",       type: "info"},
  access_token_only:   {label: "只保存 accessToken", type: "primary"},
};

// 允许触发自动重登的状态码
export const REAUTH_ELIGIBLE_STATUS_CODES = new Set(["credential_expired", "credential_invalid"]);

// 凭据类型
export const CREDENTIAL_TYPES = [
  {label: "已授权 Codex auth", value: "codex_auth"},
  {label: "只保存 accessToken", value: "access_token_only"},
  {label: "无凭据", value: "none"},
];
