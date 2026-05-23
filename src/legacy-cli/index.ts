import {appConfig} from "../core/config.js";
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
import {OpenAIClient} from "../core/openai.js";
import {createSMSBroker} from "../core/sms/index.js";

const OPENAI_PASSWORD_MIN_LENGTH = 8;

function getDefaultPassword(): string {
  const password = appConfig.defaultPassword.trim();
  if (password.length < OPENAI_PASSWORD_MIN_LENGTH) {
    throw new Error(`默认密码未配置或长度不足，请先在 Web 配置页填写至少 ${OPENAI_PASSWORD_MIN_LENGTH} 位的默认密码`);
  }
  return password;
}

function readArgValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return "";
  }
  return process.argv[index + 1] ?? "";
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readNumberArg(flag: string): number | null {
  const raw = readArgValue(flag).trim();
  if (!raw) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}


const smsBroker = appConfig.heroSMSApiKey ? createSMSBroker({
  apiKey: appConfig.heroSMSApiKey,
  pollAttempts: appConfig.heroSMSPollAttempts,
  pollIntervalMs: appConfig.heroSMSPollIntervalMs,
  maxPrice: appConfig.heroSMSMaxPrice,
  country: appConfig.heroSMSCountry
}) : undefined

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

interface RunOnceResult {
    email: string;
}

class AuthRunError extends Error {
  readonly email: string;
  readonly cause: unknown;

  constructor(email: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "AuthRunError";
    this.email = email;
    this.cause = cause;
  }
}

async function runOnce(): Promise<RunOnceResult> {
  const email = readArgValue("--email").trim();
  const manualOtp = hasFlag("--otp");
  const directSignupAuth = hasFlag("--sign");
  const saveAccessToken = hasFlag("--at");
  const deviceProfile = generateRandomDeviceProfile();
  const password = getDefaultPassword();
  if (directSignupAuth) {
    const client = new OpenAIClient({
      email: email || undefined,
      password,
      deviceProfile,
      manualMode: manualOtp,
      signupScreenHint: "signup",
      smsBroker
    });
    let result;
    try {
      result = await client.authRegisterAndAuthorizeHTTP();
    } catch (error) {
      await recordAuthFailureEmail(client.email);
      throw new AuthRunError(client.email, error);
    }
    console.log(
      `[✅️授权成功] 邮箱：${client.email} 密码：${password} 授权文件：${result.authFile ?? ""}`,
    );
    await removeSuccessfulEmail(client.email);
    return {email: client.email};
  }

  const registerClient = new OpenAIClient({
    email: email || undefined,
    password,
    deviceProfile,
    manualMode: manualOtp,
    smsBroker
  });
  try {
    await registerClient.authRegisterHTTP();
  } catch (error) {
    await recordAuthFailureEmail(registerClient.email);
    throw new AuthRunError(registerClient.email, error);
  }

  if (saveAccessToken) {
    const accessToken = await registerClient.getChatGPTAccessToken();
    const accessTokenFile = await registerClient.saveChatGPTAccessToken(accessToken);
    console.log(`[✅️注册成功] 邮箱：${registerClient.email} 密码：${password}`);
    console.log(`[access_token_file] ${accessTokenFile}`);
    console.log(`[access_token] ${accessToken}`);
    return {email: registerClient.email};
  }

  const loginClient = new OpenAIClient({
    email: registerClient.email,
    password,
    deviceProfile,
    manualMode: manualOtp,
    smsBroker
  });
  let result;
  try {
    result = await loginClient.authLoginHTTP();
  } catch (error) {
    await recordAuthFailureEmail(loginClient.email);
    throw new AuthRunError(loginClient.email, error);
  }
  console.log(
    `[✅️授权成功] 邮箱：${loginClient.email} 密码：${password} 授权文件：${result.authFile ?? ""}`,
  );
  await removeSuccessfulEmail(loginClient.email);
  return {email: loginClient.email};
}

async function main() {
  let round = 0;
  let successCount = 0;
  let failCount = 0;
  const successEmails: string[] = [];
  const failedEmails: string[] = [];
  const manualEmail = readArgValue("--email").trim();
  const authOnly = hasFlag("--auth");
  const manualOtp = hasFlag("--otp");
  const maxRounds = readNumberArg("--n");

  if (authOnly) {
    if (!manualEmail) {
      throw new Error("使用 --auth 时必须同时指定 --email");
    }
    try {
      const deviceProfile = generateRandomDeviceProfile();
      const password = getDefaultPassword();
      const client = new OpenAIClient({
        email: manualEmail,
        password,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker,
      });
      const result = await client.authLoginHTTP();
      console.log(
        `[✅️授权成功] 邮箱：${client.email} 密码：${password} 授权文件：${result.authFile ?? ""}`,
      );
    } catch (error) {
      console.error(`[❌️授权失败]`, error);
    }
    return;
  }

  if (manualEmail) {
    try {
      await runOnce();
    } catch (error) {
      console.error(`[❌️授权失败]`, error);
    }
    return;
  }

  const usesHotmailEmailQueue = appConfig.provider === "hotmail";
  if (usesHotmailEmailQueue) {
    const errorFile = await clearErrorEmailFile(await getHotmailEmailsFile());
    console.log(`[失败记录] 已清理 ${errorFile}`);
  }

  while (!maxRounds || round < maxRounds) {
    if (usesHotmailEmailQueue) {
      const remainingEmails = await getHotmailRemainingEmailCount();
      if (remainingEmails <= 0) {
        console.log("邮箱列表已全部使用完毕，自动停止");
        break;
      }
    }

    round += 1;
    console.log(
      `第 ${round} 轮开始: 成功=${successCount} 失败=${failCount} 模式=自动`,
    );
    try {
      const result = await runOnce();
      successEmails.push(result.email);
      successCount += 1;
    } catch (error) {
      failCount += 1;
      console.error(`[❌️授权失败]`, error);
      if (error instanceof AuthRunError && error.email) {
        failedEmails.push(error.email);
      }
    }

    if ((!maxRounds || round < maxRounds) && appConfig.loopDelayMs > 0) {
      console.log(`[延迟] 轮次间等待 ${appConfig.loopDelayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, appConfig.loopDelayMs));
    }
  }

  console.log(
    `自动模式结束: 已执行=${round} 成功=${successCount} 失败=${failCount}`,
  );
  console.log(`成功邮箱(${successEmails.length}): ${successEmails.length ? successEmails.join(", ") : "无"}`);
  console.log(`失败邮箱(${failedEmails.length}): ${failedEmails.length ? failedEmails.join(", ") : "无"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
