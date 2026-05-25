import {appConfig, type HotmailMode, type MailProviderName} from "../core/config.js";
import {generateRandomDeviceProfile} from "../core/device-profile.js";
import {
  appendErrorEmail,
  appendSuccessEmail,
  clearErrorEmailFile,
  removeEmailFromSourceFile,
} from "../core/email-error-recorder.js";
import {
  getHotmailEmailsFile,
  getHotmailRemainingEmailCount,
} from "../core/mail/hotmail-email-queue.js";
import {OpenAIClient, type SavedAuthRecord} from "../core/openai.js";
import {createSMSBroker} from "../core/sms/index.js";
import {getAccount, getAccountPassword, setAccountPassword, upsertAccountFromAuthRecord, loadAuthRecord, updateAuthFileStep} from "./auth-service.js";
import {
  JobCancelledError,
  addJobEvent,
  isJobCancellationRequested,
  onJobCancelled,
  throwIfJobCancelled,
  updateJobStatus,
  waitForJobInput,
} from "./job-service.js";
import {getDb, currentTimestamp} from "./db.js";
import {
  consumeReservedMailbox,
  createDatabaseMailboxProvider,
  markMailboxUsed,
  setMailboxLastError,
} from "./mailbox-service.js";
import {MAILBOX_CONFIG} from "../core/mailbox.js";
import {
  resolvePushServices,
  saveAuthFileJsonObjectToCPAService,
  uploadAuthFileToSub2APIService,
  type PushServiceConfig,
} from "./integration-service.js";

const OPENAI_PASSWORD_MIN_LENGTH = 8;
type UploadTarget = "none" | "cpa" | "sub2api" | "both";

export interface RegisterOptions {
    jobId?: number;
    email?: string;
    emails?: string[];
    rounds?: number;
    authOnly?: boolean;
    manualOtp?: boolean;
    directSignupAuth?: boolean;
    saveAccessToken?: boolean;
    enableSmsVerification?: boolean;
    password?: string;
    mailboxSourceId?: number;
    mailboxTypeId?: number;
    useMailboxPool?: boolean;
    cliProvider?: MailProviderName;
    cliHotmailMode?: HotmailMode;
    uploadTarget?: UploadTarget;
    shouldCancel?: () => boolean;
}

export interface RegisterResult {
    success: number;
    failed: number;
    smsNumbersUsed: number;
    smsSuccessCount: number;
    emails: string[];
    failedEmails: string[];
}

interface SingleRegistrationResult {
    email: string;
    smsNumbersUsed: number;
    smsSuccessCount: number;
}

function createBroker() {
  return appConfig.heroSMSApiKey ? createSMSBroker({
    apiKey: appConfig.heroSMSApiKey,
    pollAttempts: appConfig.heroSMSPollAttempts,
    pollIntervalMs: appConfig.heroSMSPollIntervalMs,
    maxPrice: appConfig.heroSMSMaxPrice,
    country: appConfig.heroSMSCountry,
  }) : undefined;
}

function isSmsVerificationEnabled(options: RegisterOptions): boolean {
  return options.enableSmsVerification !== false;
}

function createBrokerForRegistration(options: RegisterOptions) {
  if (!isSmsVerificationEnabled(options)) {
    return undefined;
  }
  return createBroker();
}

function summarizeSmsBrokerUsage(broker: unknown): {smsNumbersUsed: number; smsSuccessCount: number} {
  const reader = broker as {getHistory?: () => {phoneStats?: Record<string, unknown>; totalAttemptsSucceeded?: number}} | undefined;
  if (typeof reader?.getHistory !== "function") {
    return {smsNumbersUsed: 0, smsSuccessCount: 0};
  }
  const history = reader.getHistory();
  return {
    smsNumbersUsed: Object.keys(history.phoneStats ?? {}).length,
    smsSuccessCount: Number(history.totalAttemptsSucceeded ?? 0),
  };
}

function shouldCancelRegistration(options: RegisterOptions): boolean {
  return Boolean(options.shouldCancel?.() || (options.jobId && isJobCancellationRequested(options.jobId)));
}

function rethrowIfCancellation(error: unknown, options: RegisterOptions): void {
  if (error instanceof JobCancelledError || shouldCancelRegistration(options)) {
    throw error;
  }
}

function logEmailOtpCode(targetEmail: string, code: string): void {
  console.log(`[邮箱验证码] ${targetEmail} code=${code}`);
}

function createCancellationSignal(jobId?: number) {
  let cancelled = false;
  const off = jobId
    ? onJobCancelled(jobId, () => {
      cancelled = true;
    })
    : undefined;
  return {
    isCancelled: () => cancelled || Boolean(jobId && isJobCancellationRequested(jobId)),
    dispose: () => off?.(),
  };
}

async function recordAuthFailureEmail(email: string): Promise<void> {
  const errorFile = await appendErrorEmail(email);
  if (errorFile) {
    console.error(`[失败记录] 已写入 ${errorFile}`);
  }
}

async function removeSuccessfulEmail(email: string): Promise<void> {
  const successFile = await appendSuccessEmail(email);
  if (successFile) {
    console.log(`[成功记录] 已写入 ${successFile}`);
  }
  const sourceFile = await removeEmailFromSourceFile(email);
  if (sourceFile) {
    console.log(`[邮箱文件] 授权成功，已从 ${sourceFile} 删除 ${email}`);
  }
}

async function importAuthFileFromResult(authFile?: string, password?: string): Promise<void> {
  if (!authFile) {
    return;
  }
  const record = await loadAuthRecord(authFile);
  const account = await upsertAccountFromAuthRecord(record, authFile);
  if (password) {
    await setAccountPassword(account.id, password);
  }
}

async function pushAuthFileAfterRegistration(authFile: string | undefined, target: UploadTarget | undefined, jobId?: number): Promise<void> {
  const normalizedTarget = target ?? "none";
  if (!authFile || normalizedTarget === "none") {
    return;
  }
  const record = await loadAuthRecord(authFile);
  const fileName = authFile.split(/[\\/]/).pop() || "auth.json";
  if (normalizedTarget === "cpa" || normalizedTarget === "both") {
    const services = await resolvePushServices("cpa");
    if (!services.length) {
      const message = "未配置启用的 CPA 推送服务";
      console.warn(`cliproxyApiAuthUploadFailed: ${fileName} error=${message}`);
      if (jobId) {
        addJobEvent(jobId, "error", `CPA 自动上传失败: ${fileName} ${message}`);
      }
    }
    for (const service of services) {
      try {
        await saveAuthFileJsonObjectToCPAService({
          baseUrl: service.baseUrl,
          managementKey: service.secret,
        }, fileName, record as unknown as Record<string, unknown>);
        console.log(`cliproxyApiAuthUploaded: ${fileName} service=${formatPushServiceName(service)}`);
        if (jobId) {
          addJobEvent(jobId, "success", `已上传 CPA: 服务=${formatPushServiceName(service)} 文件=${fileName}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`cliproxyApiAuthUploadFailed: ${fileName} service=${formatPushServiceName(service)} error=${message}`);
        if (jobId) {
          addJobEvent(jobId, "error", `CPA 自动上传失败: 服务=${formatPushServiceName(service)} 文件=${fileName} ${message}`);
        }
      }
    }
  }
  if (normalizedTarget === "sub2api" || normalizedTarget === "both") {
    const services = await resolvePushServices("sub2api");
    if (!services.length) {
      const message = "未配置启用的 Sub2API 推送服务";
      console.warn(`sub2apiAuthUploadFailed: ${fileName} error=${message}`);
      if (jobId) {
        addJobEvent(jobId, "error", `Sub2API 自动上传失败: ${fileName} ${message}`);
      }
    }
    for (const service of services) {
      try {
        const result = await uploadAuthFileToSub2APIService({
          baseUrl: service.baseUrl,
          adminApiKey: service.secret,
          options: service.options,
        }, fileName, record as SavedAuthRecord);
        console.log(`sub2apiAuthUploaded: ${fileName} service=${formatPushServiceName(service)} created=${result.created} updated=${result.updated} skipped=${result.skipped}`);
        if (jobId) {
          addJobEvent(jobId, "success", `已上传 Sub2API: 服务=${formatPushServiceName(service)} 文件=${fileName} created=${result.created} updated=${result.updated} skipped=${result.skipped}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`sub2apiAuthUploadFailed: ${fileName} service=${formatPushServiceName(service)} error=${message}`);
        if (jobId) {
          addJobEvent(jobId, "error", `Sub2API 自动上传失败: 服务=${formatPushServiceName(service)} 文件=${fileName} ${message}`);
        }
      }
    }
  }
}

function formatPushServiceName(service: PushServiceConfig): string {
  return `${service.name}${service.fallback ? "(全局配置)" : ""}`;
}

function resolveRegistrationPassword(input?: string): string {
  const password = input?.trim() || appConfig.defaultPassword.trim();
  if (password.length < OPENAI_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `账号密码长度不足：OpenAI 注册密码至少需要 ${OPENAI_PASSWORD_MIN_LENGTH} 位，请在注册页填写账号密码或在配置页设置默认密码。`,
    );
  }
  return password;
}

async function runSingleRegistration(options: RegisterOptions, email?: string): Promise<SingleRegistrationResult> {
  throwIfJobCancelled(options.jobId);
  const cancellation = createCancellationSignal(options.jobId);
  const scopedOptions: RegisterOptions = {
    ...options,
    shouldCancel: () => Boolean(options.shouldCancel?.() || cancellation.isCancelled()),
  };
  try {
    return await runSingleRegistrationInner(scopedOptions, email);
  } finally {
    cancellation.dispose();
  }
}

async function runSingleRegistrationInner(options: RegisterOptions, email?: string): Promise<SingleRegistrationResult> {
  const password = resolveRegistrationPassword(options.password);
  const smsVerificationEnabled = isSmsVerificationEnabled(options);
  const smsBroker = createBrokerForRegistration(options);
  const deviceProfile = generateRandomDeviceProfile();
  const databaseProvider = options.useMailboxPool && !email
    ? createDatabaseMailboxProvider(options.mailboxSourceId, options.mailboxTypeId)
    : undefined;
  const progressCallback = options.jobId
    ? (_step: number | string, _total: number, message: string) => {
      addJobEvent(options.jobId as number, "info", `凭据阶段: ${message}`);
      throwIfJobCancelled(options.jobId);
    }
    : undefined;
  const shouldCancel = () => shouldCancelRegistration(options);
  const emailOtpProvider = options.manualOtp && options.jobId
    ? async (targetEmail: string, excludeCodes: string[]) => {
      const code = await waitForJobInput(options.jobId as number, `请输入 ${targetEmail} 的邮箱验证码`);
      if (excludeCodes.includes(code)) {
        throw new Error(`验证码已使用过: ${code}`);
      }
      logEmailOtpCode(targetEmail, code);
      return code;
    }
    : databaseProvider
      ? async (targetEmail: string, excludeCodes: string[]) => {
        const code = await databaseProvider.getEmailVerificationCode(targetEmail, {excludeCodes});
        logEmailOtpCode(targetEmail, code);
        return code;
      }
      : undefined;
  const emailAddressProvider = databaseProvider
    ? async () => {
      return databaseProvider.getEmailAddress();
    }
    : undefined;
  if (emailAddressProvider && !email) {
    throwIfJobCancelled(options.jobId);
    email = await emailAddressProvider();
  }
  if (options.authOnly) {
    throwIfJobCancelled(options.jobId);
    if (!email) {
      throw new Error("只登录授权模式必须指定邮箱");
    }
    const client = new OpenAIClient({
      email,
      password,
      deviceProfile,
      manualMode: options.manualOtp,
      emailOtpProvider,
      progressCallback,
      smsBroker,
      smsVerificationDisabled: !smsVerificationEnabled,
      shouldCancel,
    });
    const result = await client.authLoginHTTP();
    console.log(`[授权成功] 邮箱：${client.email} 密码：${password} 授权文件：${result.authFile ?? ""}`);
    await importAuthFileFromResult(result.authFile, password);
    return {email: client.email, ...summarizeSmsBrokerUsage(smsBroker)};
  }

  if (options.directSignupAuth || !options.saveAccessToken) {
    throwIfJobCancelled(options.jobId);
    const client = new OpenAIClient({
      email: email || undefined,
      password,
      deviceProfile,
      manualMode: options.manualOtp,
      emailOtpProvider,
      progressCallback,
      signupScreenHint: "signup",
      smsBroker,
      smsVerificationDisabled: !smsVerificationEnabled,
      shouldCancel,
    });
    try {
      const result = await client.authRegisterAndAuthorizeHTTP();
      const finalPassword = password;
      console.log(`[授权成功] 邮箱：${client.email} 密码：${finalPassword} 授权文件：${result.authFile ?? ""}`);
      await removeSuccessfulEmail(client.email);
      await importAuthFileFromResult(result.authFile, finalPassword);
      await pushAuthFileAfterRegistration(result.authFile, options.uploadTarget, options.jobId);
      const mailbox = consumeReservedMailbox();
      if (mailbox) {
        markMailboxUsed(mailbox.id, true, "used");
      }
      return {email: client.email, ...summarizeSmsBrokerUsage(smsBroker)};
    } catch (error) {
      rethrowIfCancellation(error, options);
      await recordAuthFailureEmail(client.email);
      const mailbox = consumeReservedMailbox();
      if (mailbox) {
        setMailboxLastError(mailbox.id, error instanceof Error ? error.message : String(error), true);
      }
      throw error;
    }
  }

  const registerClient = new OpenAIClient({
    email: email || undefined,
    password,
    deviceProfile,
    manualMode: options.manualOtp,
    emailOtpProvider,
    progressCallback,
    smsBroker,
    smsVerificationDisabled: !smsVerificationEnabled,
    shouldCancel,
  });
  try {
    throwIfJobCancelled(options.jobId);
    await registerClient.authRegisterHTTP();
  } catch (error) {
    rethrowIfCancellation(error, options);
    await recordAuthFailureEmail(registerClient.email);
    const mailbox = consumeReservedMailbox();
    if (mailbox) {
      setMailboxLastError(mailbox.id, error instanceof Error ? error.message : String(error), true);
    }
    throw error;
  }

  if (options.saveAccessToken) {
    throwIfJobCancelled(options.jobId);
    const accessToken = await registerClient.getChatGPTAccessToken();
    const accessTokenFile = await registerClient.saveChatGPTAccessToken(accessToken);
    await importAuthFileFromResult(accessTokenFile, password);
    console.log(`[注册成功] 邮箱：${registerClient.email} 密码：${password}`);
    console.log(`[access_token_file] ${accessTokenFile}`);
    const mailbox = consumeReservedMailbox();
    if (mailbox) {
      markMailboxUsed(mailbox.id, true, "used");
    }
    return {email: registerClient.email, ...summarizeSmsBrokerUsage(smsBroker)};
  }

  const loginClient = new OpenAIClient({
    email: registerClient.email,
    password,
    deviceProfile,
    manualMode: options.manualOtp,
    progressCallback,
    emailOtpProvider,
    smsBroker,
    smsVerificationDisabled: !smsVerificationEnabled,
    shouldCancel,
  });
  try {
    throwIfJobCancelled(options.jobId);
    const result = await loginClient.authLoginHTTP();
    const finalPassword = password;
    console.log(`[授权成功] 邮箱：${loginClient.email} 密码：${finalPassword} 授权文件：${result.authFile ?? ""}`);
    await removeSuccessfulEmail(loginClient.email);
    await importAuthFileFromResult(result.authFile, finalPassword);
    await pushAuthFileAfterRegistration(result.authFile, options.uploadTarget, options.jobId);
    const mailbox = consumeReservedMailbox();
    if (mailbox) {
      markMailboxUsed(mailbox.id, true, "used");
    }
    return {email: loginClient.email, ...summarizeSmsBrokerUsage(smsBroker)};
  } catch (error) {
    rethrowIfCancellation(error, options);
    await recordAuthFailureEmail(loginClient.email);
    const mailbox = consumeReservedMailbox();
    if (mailbox) {
      setMailboxLastError(mailbox.id, error instanceof Error ? error.message : String(error), true);
    }
    throw error;
  }
}

async function waitBetweenRegistrationRounds(jobId: number | undefined, delayMs: number, nextRound: number): Promise<void> {
  const normalizedDelayMs = Math.max(0, Math.floor(delayMs));
  if (!normalizedDelayMs) {
    return;
  }
  const seconds = Math.ceil(normalizedDelayMs / 1000);
  console.log(`[延迟] 轮次间等待 ${seconds}s，之后开始第 ${nextRound} 轮`);
  const deadline = Date.now() + normalizedDelayMs;
  while (Date.now() < deadline) {
    throwIfJobCancelled(jobId);
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
}

export async function runRegistrationJob(options: RegisterOptions): Promise<RegisterResult> {
  const previousProvider = MAILBOX_CONFIG.provider;
  const previousHotmailMode = appConfig.hotmailMode;
  if (!options.useMailboxPool) {
    if (options.cliProvider) {
      MAILBOX_CONFIG.provider = options.cliProvider;
    }
    if (options.cliHotmailMode) {
      appConfig.hotmailMode = options.cliHotmailMode;
    }
  }
  try {
    return await runRegistrationJobInner(options);
  } finally {
    MAILBOX_CONFIG.provider = previousProvider;
    appConfig.hotmailMode = previousHotmailMode;
  }
}

async function runRegistrationJobInner(options: RegisterOptions): Promise<RegisterResult> {
  const emails = [
    ...(options.emails ?? []),
    ...(options.email ? [options.email] : []),
  ].map((item) => item.trim()).filter(Boolean);
  const maxRounds = options.rounds && options.rounds > 0 ? options.rounds : (emails.length || 1);
  const usesMailboxPool = Boolean(options.useMailboxPool && emails.length === 0);
  const usesHotmailEmailQueue = appConfig.provider === "hotmail" && emails.length === 0 && !usesMailboxPool;
  if (usesHotmailEmailQueue) {
    const errorFile = await clearErrorEmailFile(await getHotmailEmailsFile());
    console.log(`[失败记录] 已清理 ${errorFile}`);
  }

  let success = 0;
  let failed = 0;
  let smsNumbersUsed = 0;
  let smsSuccessCount = 0;
  const successEmails: string[] = [];
  const failedEmails: string[] = [];

  for (let index = 0; index < maxRounds; index += 1) {
    throwIfJobCancelled(options.jobId);
    if (usesHotmailEmailQueue) {
      const remaining = await getHotmailRemainingEmailCount();
      if (remaining <= 0) {
        console.log("邮箱列表已全部使用完毕，自动停止");
        break;
      }
    }

    const targetEmail = emails[index] ?? "";
    const modeLabel = usesMailboxPool ? "邮箱池" : (targetEmail ? "指定邮箱" : "自动邮箱");
    console.log(`第 ${index + 1} 轮开始: 成功=${success} 失败=${failed} 模式=${modeLabel}`);
    try {
      const result = await runSingleRegistration(options, targetEmail);
      success += 1;
      smsNumbersUsed += result.smsNumbersUsed;
      smsSuccessCount += result.smsSuccessCount;
      successEmails.push(result.email);
    } catch (error) {
      rethrowIfCancellation(error, options);
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      failedEmails.push(targetEmail || "auto");
      console.error(`[授权失败] ${targetEmail || "auto"} ${message}`);
    }
    console.log(`[任务统计] 总轮数 ${maxRounds}，已完成 ${index + 1}，成功 ${success}，失败 ${failed}，短信号码 ${smsNumbersUsed}，短信成功 ${smsSuccessCount}`);
    if (index < maxRounds - 1) {
      await waitBetweenRegistrationRounds(options.jobId, appConfig.loopDelayMs, index + 2);
    }
  }

  const completed = success + failed;
  console.log(`自动模式结束: 已执行=${completed} 成功=${success} 失败=${failed} 短信号码=${smsNumbersUsed} 短信成功=${smsSuccessCount}`);
  console.log(`成功邮箱(${successEmails.length}): ${successEmails.length ? successEmails.join(", ") : "无"}`);
  console.log(`失败邮箱(${failedEmails.length}): ${failedEmails.length ? failedEmails.join(", ") : "无"}`);

  return {
    success,
    failed,
    smsNumbersUsed,
    smsSuccessCount,
    emails: successEmails,
    failedEmails,
  };
}

export function assertRegistrationSucceeded(result: RegisterResult): RegisterResult {
  if (result.failed > 0) {
    throw new Error(`注册任务失败 ${result.failed} 轮，成功 ${result.success} 轮`);
  }
  if (result.success <= 0) {
    throw new Error("注册任务未成功完成任何账号");
  }
  return result;
}

export type ReauthMode = "auto" | "manual";

function setNeedsManualReauth(accountId: number, errorMessage: string): void {
  const timestamp = currentTimestamp();
  getDb().prepare(`
    UPDATE accounts
    SET needs_manual_reauth = 1,
        last_reauth_attempt_at = @last_reauth_attempt_at,
        last_reauth_error = @last_reauth_error,
        last_error = @last_error,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: accountId,
    last_reauth_attempt_at: timestamp,
    last_reauth_error: errorMessage,
    last_error: errorMessage,
    updated_at: timestamp,
  });
}

function clearNeedsManualReauth(accountId: number): void {
  const timestamp = currentTimestamp();
  getDb().prepare(`
    UPDATE accounts
    SET needs_manual_reauth = 0,
        last_reauth_attempt_at = @last_reauth_attempt_at,
        last_reauth_error = NULL,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: accountId,
    last_reauth_attempt_at: timestamp,
    updated_at: timestamp,
  });
}

export async function reauthorizeAccount(
  accountId: number,
  jobId?: number,
  options: {mode?: ReauthMode} = {},
): Promise<{email: string; authFile?: string}> {
  const mode: ReauthMode = options.mode ?? "auto";
  const account = getAccount(accountId);
  const password = await getAccountPassword(account);
  const deviceProfile = generateRandomDeviceProfile();
  const databaseProvider = account.source_id ? createDatabaseMailboxProvider(account.source_id) : null;
  if (mode === "auto" && jobId) {
    addJobEvent(jobId, "info", databaseProvider
      ? `自动重登: 优先使用邮箱来源 #${account.source_id} 取邮箱验证码`
      : "自动重登: 账号未配置邮箱来源，将无法处理邮箱验证");
  }
  const emailOtpProvider = async (targetEmail: string, excludeCodes: string[]) => {
    if (databaseProvider) {
      try {
        const code = await databaseProvider.getEmailVerificationCode(targetEmail, {excludeCodes});
        logEmailOtpCode(targetEmail, code);
        return code;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (mode === "auto") {
          throw new Error(`邮箱自动取码失败: ${message}`);
        }
        if (jobId) {
          addJobEvent(jobId, "warn", `邮箱自动取码失败: ${message}，等待人工输入`);
        }
      }
    }
    if (!jobId || mode === "auto") {
      throw new Error("账号未配置可用的邮箱来源，无法自动取码");
    }
    const code = await waitForJobInput(jobId, `请输入 ${targetEmail} 的邮箱验证码`);
    if (excludeCodes.includes(code)) {
      throw new Error(`验证码已使用过: ${code}`);
    }
    logEmailOtpCode(targetEmail, code);
    return code;
  };
  const client = new OpenAIClient({
    email: account.email,
    password,
    deviceProfile,
    manualMode: mode === "manual" && Boolean(jobId),
    emailOtpProvider,
    progressCallback: jobId
      ? (_step, _total, message) => {
        updateAuthFileStep(accountId, message, "running");
        addJobEvent(jobId, "info", `凭据阶段: ${message}`);
      }
      : undefined,
    smsBroker: mode === "auto" ? undefined : createBroker(),
    smsVerificationDisabled: mode === "auto",
    shouldCancel: () => jobId ? isJobCancellationRequested(jobId) : false,
  });
  try {
    const result = await client.authLoginHTTP();
    await importAuthFileFromResult(result.authFile, password);
    getDb().prepare(`
        UPDATE accounts
        SET status = 'reauthorized',
            last_auth_at = @last_auth_at,
            last_error = NULL,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
      id: accountId,
      last_auth_at: currentTimestamp(),
      updated_at: currentTimestamp(),
    });
    clearNeedsManualReauth(accountId);
    if (jobId) {
      addJobEvent(jobId, "success", `重新授权成功: ${account.email}`);
    }
    return {email: account.email, authFile: result.authFile};
  } catch (error) {
    if (error instanceof JobCancelledError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (mode === "auto") {
      setNeedsManualReauth(accountId, message);
      if (jobId) {
        addJobEvent(jobId, "error", `自动重登失败已标记为需要人工重登: ${message}`);
      }
    } else if (jobId) {
      addJobEvent(jobId, "error", `重新授权失败: ${message}`);
    }
    throw error;
  }
}

export async function manualReauthAccount(
  accountId: number,
  jobId: number,
): Promise<{email: string; authFile?: string}> {
  const account = getAccount(accountId);
  const deviceProfile = generateRandomDeviceProfile();
  const client = new OpenAIClient({
    email: account.email,
    password: "",
    deviceProfile,
    manualMode: true,
    progressCallback: (_step, _total, message) => {
      updateAuthFileStep(accountId, message, "running");
      addJobEvent(jobId, "info", `凭据阶段: ${message}`);
    },
    shouldCancel: () => isJobCancellationRequested(jobId),
  });
  const authorizeUrl = client.prepareManualLogin();
  addJobEvent(jobId, "info", `授权链接已生成: ${authorizeUrl}`);
  updateJobStatus(jobId, "waiting_input", {
    result: {auth_url: authorizeUrl, callback_required: true, account_id: accountId},
    inputPrompt: "请在浏览器登录后，粘贴回调地址（http://localhost/?code=...&state=...）",
  });
  try {
    const callbackUrl = await waitForJobInput(jobId, "请在浏览器登录后，粘贴回调地址");
    updateJobStatus(jobId, "running", {result: {auth_url: authorizeUrl, callback_received: true}});
    addJobEvent(jobId, "info", "已收到回调地址，正在交换授权码");
    const result = await client.finalizeManualCallback(callbackUrl.trim());
    const password = await getAccountPassword(account);
    await importAuthFileFromResult(result.authFile, password);
    getDb().prepare(`
        UPDATE accounts
        SET status = 'reauthorized',
            last_auth_at = @last_auth_at,
            last_error = NULL,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
      id: accountId,
      last_auth_at: currentTimestamp(),
      updated_at: currentTimestamp(),
    });
    clearNeedsManualReauth(accountId);
    addJobEvent(jobId, "success", `人工重登成功: ${account.email}`);
    return {email: account.email, authFile: result.authFile};
  } catch (error) {
    if (error instanceof JobCancelledError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    addJobEvent(jobId, "error", `人工重登失败: ${message}`);
    throw error;
  }
}
