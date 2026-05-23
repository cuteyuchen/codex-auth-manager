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
import {addJobEvent, waitForJobInput} from "./job-service.js";
import {getDb, currentTimestamp} from "./db.js";
import {
  consumeReservedMailbox,
  createDatabaseMailboxProvider,
  markMailboxUsed,
  setMailboxLastError,
} from "./mailbox-service.js";
import {MAILBOX_CONFIG} from "../core/mailbox.js";
import {saveAuthFileJsonObjectToCLIProxyAPI} from "../core/cliproxyapi.js";
import {uploadAuthFileToSub2API} from "../core/sub2api.js";

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
    password?: string;
    mailboxSourceId?: number;
    mailboxTypeId?: number;
    useMailboxPool?: boolean;
    cliProvider?: MailProviderName;
    cliHotmailMode?: HotmailMode;
    uploadTarget?: UploadTarget;
}

export interface RegisterResult {
    success: number;
    failed: number;
    emails: string[];
    failedEmails: string[];
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
    try {
      await saveAuthFileJsonObjectToCLIProxyAPI(fileName, record as unknown as Record<string, unknown>);
      console.log(`cliproxyApiAuthUploaded: ${fileName}`);
      if (jobId) {
        addJobEvent(jobId, "success", `已上传 CPA: ${fileName}`);
      }
    } catch (error) {
      console.warn(`cliproxyApiAuthUploadFailed: ${fileName} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (normalizedTarget === "sub2api" || normalizedTarget === "both") {
    try {
      const result = await uploadAuthFileToSub2API(fileName, record as SavedAuthRecord);
      console.log(`sub2apiAuthUploaded: ${fileName} created=${result.created} updated=${result.updated} skipped=${result.skipped}`);
      if (jobId) {
        addJobEvent(jobId, "success", `已上传 Sub2API: ${fileName}`);
      }
    } catch (error) {
      console.warn(`sub2apiAuthUploadFailed: ${fileName} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
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

async function runSingleRegistration(options: RegisterOptions, email?: string): Promise<string> {
  const password = resolveRegistrationPassword(options.password);
  const smsBroker = createBroker();
  const deviceProfile = generateRandomDeviceProfile();
  const databaseProvider = options.useMailboxPool && !email
    ? createDatabaseMailboxProvider(options.mailboxSourceId, options.mailboxTypeId)
    : undefined;
  const progressCallback = options.jobId
    ? (_step: number | string, _total: number, message: string) => {
      addJobEvent(options.jobId as number, "info", `凭据阶段: ${message}`);
    }
    : undefined;
  const emailOtpProvider = options.manualOtp && options.jobId
    ? async (targetEmail: string, excludeCodes: string[]) => {
      const code = await waitForJobInput(options.jobId as number, `请输入 ${targetEmail} 的邮箱验证码`);
      if (excludeCodes.includes(code)) {
        throw new Error(`验证码已使用过: ${code}`);
      }
      return code;
    }
    : databaseProvider
      ? (targetEmail: string, excludeCodes: string[]) => databaseProvider.getEmailVerificationCode(targetEmail, {excludeCodes})
      : undefined;
  const emailAddressProvider = databaseProvider
    ? async () => {
      return databaseProvider.getEmailAddress();
    }
    : undefined;
  if (emailAddressProvider && !email) {
    email = await emailAddressProvider();
  }
  if (options.authOnly) {
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
    });
    const result = await client.authLoginHTTP();
    console.log(`[授权成功] 邮箱：${client.email} 密码：${password} 授权文件：${result.authFile ?? ""}`);
    await importAuthFileFromResult(result.authFile, password);
    return client.email;
  }

  if (options.directSignupAuth) {
    const client = new OpenAIClient({
      email: email || undefined,
      password,
      deviceProfile,
      manualMode: options.manualOtp,
      emailOtpProvider,
      progressCallback,
      signupScreenHint: "signup",
      smsBroker,
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
      return client.email;
    } catch (error) {
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
  });
  try {
    await registerClient.authRegisterHTTP();
  } catch (error) {
    await recordAuthFailureEmail(registerClient.email);
    const mailbox = consumeReservedMailbox();
    if (mailbox) {
      setMailboxLastError(mailbox.id, error instanceof Error ? error.message : String(error), true);
    }
    throw error;
  }

  if (options.saveAccessToken) {
    const accessToken = await registerClient.getChatGPTAccessToken();
    const accessTokenFile = await registerClient.saveChatGPTAccessToken(accessToken);
    await importAuthFileFromResult(accessTokenFile, password);
    console.log(`[注册成功] 邮箱：${registerClient.email} 密码：${password}`);
    console.log(`[access_token_file] ${accessTokenFile}`);
    const mailbox = consumeReservedMailbox();
    if (mailbox) {
      markMailboxUsed(mailbox.id, true, "used");
    }
    return registerClient.email;
  }

  const loginClient = new OpenAIClient({
    email: registerClient.email,
    password,
    deviceProfile,
    manualMode: options.manualOtp,
    progressCallback,
    emailOtpProvider,
    smsBroker,
  });
  try {
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
    return loginClient.email;
  } catch (error) {
    await recordAuthFailureEmail(loginClient.email);
    const mailbox = consumeReservedMailbox();
    if (mailbox) {
      setMailboxLastError(mailbox.id, error instanceof Error ? error.message : String(error), true);
    }
    throw error;
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
  const successEmails: string[] = [];
  const failedEmails: string[] = [];

  for (let index = 0; index < maxRounds; index += 1) {
    if (usesHotmailEmailQueue) {
      const remaining = await getHotmailRemainingEmailCount();
      if (remaining <= 0) {
        console.log("邮箱列表已全部使用完毕，自动停止");
        break;
      }
    }

    const targetEmail = emails[index] ?? "";
    console.log(`第 ${index + 1} 轮开始: ${targetEmail || "自动邮箱"}`);
    try {
      const registeredEmail = await runSingleRegistration(options, targetEmail);
      success += 1;
      successEmails.push(registeredEmail);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      failedEmails.push(targetEmail || "auto");
      console.error(`[授权失败] ${targetEmail || "auto"} ${message}`);
    }
  }

  return {
    success,
    failed,
    emails: successEmails,
    failedEmails,
  };
}

export async function reauthorizeAccount(accountId: number, jobId?: number): Promise<{email: string; authFile?: string}> {
  const account = getAccount(accountId);
  const password = await getAccountPassword(account);
  const deviceProfile = generateRandomDeviceProfile();
  const emailOtpProvider = jobId
    ? async (targetEmail: string, excludeCodes: string[]) => {
      const code = await waitForJobInput(jobId, `请输入 ${targetEmail} 的邮箱验证码`);
      if (excludeCodes.includes(code)) {
        throw new Error(`验证码已使用过: ${code}`);
      }
      return code;
    }
    : undefined;
  const client = new OpenAIClient({
    email: account.email,
    password,
    deviceProfile,
    manualMode: Boolean(jobId),
    emailOtpProvider,
    progressCallback: jobId
      ? (_step, _total, message) => {
        updateAuthFileStep(accountId, message, "running");
        addJobEvent(jobId, "info", `凭据阶段: ${message}`);
      }
      : undefined,
    smsBroker: createBroker(),
  });
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
  if (jobId) {
    addJobEvent(jobId, "success", `重新授权成功: ${account.email}`);
  }
  return {email: account.email, authFile: result.authFile};
}
