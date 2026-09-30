/*
 * 实现逻辑说明：
 * 这里负责解析和读取 ChatGPT/Codex 登录态文件，
 * 默认优先使用 $CODEX_HOME/auth.json，未配置时回退到 ~/.codex/auth.json，
 * 也支持由启动入口通过命令行参数传入自定义路径，
 * 并统一校验 access_token/account_id 是否齐全。请求前会检查 token 有效期，
 * 在过期前五分钟内使用 refresh_token 串行刷新，并原子写回旋转后的登录态。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RawAuthFile = {
  tokens?: {
    access_token?: string;
    account_id?: string;
    refresh_token?: string;
    id_token?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
};

type RefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
};

type ReadCodexAuthOptions = {
  refreshEndpoint?: string;
};

type OAuthErrorResponse = {
  error?: string | {
    code?: string;
    message?: string;
  };
  error_description?: string;
};

export type CodexAuth = {
  accessToken: string;
  accountId: string;
};

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const REFRESH_WINDOW_SECONDS = 5 * 60;
const refreshesByAuthPath = new Map<string, Promise<CodexAuth>>();

class CodexAuthenticationError extends Error {
  statusCode = 401;

  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "CodexAuthenticationError";
  }
}

export function getDefaultCodexAuthFilePath() {
  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, "auth.json");
  }

  return path.join(os.homedir(), ".codex", "auth.json");
}

export function resolveCodexAuthFilePath(authFilePath?: string) {
  if (!authFilePath) {
    return getDefaultCodexAuthFilePath();
  }

  if (authFilePath === "~") {
    return os.homedir();
  }

  if (authFilePath.startsWith("~/")) {
    return path.join(os.homedir(), authFilePath.slice(2));
  }

  return path.resolve(authFilePath);
}

export function validateCodexAuthFile(authFilePath?: string) {
  const authPath = resolveCodexAuthFilePath(authFilePath);

  if (!fs.existsSync(authPath)) {
    throw new Error(`认证文件不存在: ${authPath}`);
  }

  const raw = fs.readFileSync(authPath, "utf8");
  let parsed: RawAuthFile;

  try {
    parsed = JSON.parse(raw) as RawAuthFile;
  } catch {
    throw new Error(`认证文件不是合法 JSON: ${authPath}`);
  }

  const accessToken = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id;

  if (!accessToken || !accountId) {
    throw new Error(`认证文件缺少 access_token 或 account_id: ${authPath}`);
  }

  return {
    authPath,
    auth: {
      accessToken,
      accountId,
    },
  };
}

function tokenExpiresSoon(accessToken: string) {
  const payloadSegment = accessToken.split(".")[1];
  if (!payloadSegment) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return (
      typeof payload.exp === "number" &&
      payload.exp <= Math.floor(Date.now() / 1000) + REFRESH_WINDOW_SECONDS
    );
  } catch {
    return false;
  }
}

async function refreshCodexAuth(authPath: string, refreshEndpoint: string) {
  const raw = fs.readFileSync(authPath, "utf8");
  const parsed = JSON.parse(raw) as RawAuthFile;
  const refreshToken = parsed.tokens?.refresh_token;

  if (!refreshToken) {
    throw new CodexAuthenticationError(
      `Codex 登录态已过期且无法刷新，请运行 codex login: ${authPath}`,
      "refresh_token_missing",
    );
  }

  const response = await fetch(refreshEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    let errorCode: string | undefined;

    try {
      const errorResponse = JSON.parse(responseText) as OAuthErrorResponse;
      errorCode = typeof errorResponse.error === "string"
        ? errorResponse.error
        : errorResponse.error?.code;
    } catch {
      // OAuth 错误体并不保证是 JSON；不要把可能敏感的原文返回给客户端。
    }

    if (response.status === 400 || response.status === 401) {
      const errorSuffix = errorCode ? ` (${errorCode})` : "";
      throw new CodexAuthenticationError(
        `Codex 登录态无法刷新${errorSuffix}，请运行 codex login`,
        errorCode,
      );
    }

    throw new Error(`Codex 认证刷新服务异常: HTTP ${response.status}`);
  }

  const refreshed = (await response.json()) as RefreshResponse;
  if (!refreshed.access_token) {
    throw new Error("Codex 认证刷新失败: 响应缺少 access_token");
  }

  const tokens = {
    ...parsed.tokens,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? refreshToken,
    id_token: refreshed.id_token ?? parsed.tokens?.id_token,
  };
  const updated: RawAuthFile = {
    ...parsed,
    tokens,
    last_refresh: new Date().toISOString(),
  };
  const temporaryPath = `${authPath}.${process.pid}.tmp`;
  const fileMode = fs.statSync(authPath).mode;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: fileMode });
    fs.renameSync(temporaryPath, authPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }

  return validateCodexAuthFile(authPath).auth;
}

export async function readCodexAuth(
  authFilePath?: string,
  options: ReadCodexAuthOptions = {},
): Promise<CodexAuth> {
  const validated = validateCodexAuthFile(authFilePath);
  if (!tokenExpiresSoon(validated.auth.accessToken)) return validated.auth;

  const existingRefresh = refreshesByAuthPath.get(validated.authPath);
  if (existingRefresh) return existingRefresh;

  const refresh = refreshCodexAuth(
    validated.authPath,
    options.refreshEndpoint ?? OAUTH_TOKEN_ENDPOINT,
  );
  refreshesByAuthPath.set(validated.authPath, refresh);

  try {
    return await refresh;
  } finally {
    if (refreshesByAuthPath.get(validated.authPath) === refresh) {
      refreshesByAuthPath.delete(validated.authPath);
    }
  }
}
