/**
 * Provider-owned OAuth:复用 pi-ai 内置 openai-codex provider 的官方
 * login / refresh 实现(协议、端点、PKCE、本地回调与版本同步),
 * 本插件只负责"何时登录、结果存哪、失败怎么办"。
 *
 * 登录方式固定为浏览器直开授权(Browser login):
 * - pi-ai 内部自动起本地回调服务器(127.0.0.1:1455)并生成授权 URL;
 * - notify(auth_url) 携带授权页地址,由 Client window.open 直接打开;
 * - 用户在授权页登录后,OpenAI 重定向回本地回调,pi-ai 完成换取 credential。
 */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

/** pi-ai OAuth credential 的运行时形态。 */
export interface OAuthCredential {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

/** pi-ai 登录交互的 prompt 形状(只处理 select 与 manual_code)。 */
export interface AuthPromptSelect {
  type: 'select'
  message: string
  options: Array<{ id: string; label: string }>
}

export interface AuthPromptManualCode {
  type: 'manual_code'
  message: string
  placeholder: string
  signal: AbortSignal
}

/** pi-ai 登录交互的 notify 事件(只关心 auth_url)。 */
export interface AuthEventAuthUrl {
  type: 'auth_url'
  url: string
  instructions?: string
}

export type AuthEvent = AuthEventAuthUrl | { type: 'device_code' | 'info' | 'progress'; [key: string]: unknown }

/** provider 自带的 OAuth 契约。 */
export interface ProviderOwnedOAuth {
  login(interaction: {
    signal: AbortSignal
    prompt(prompt: AuthPromptSelect | AuthPromptManualCode): Promise<string>
    notify(event: AuthEvent): void
  }): Promise<OAuthCredential>
  refresh(credential: OAuthCredential): Promise<OAuthCredential>
  toAuth(credential: OAuthCredential): Promise<{ apiKey: string }>
}

let cached: ProviderOwnedOAuth | undefined

/** 获取 openai-codex provider 自带的 OAuth(懒加载 + 缓存)。 */
export function getCodexOAuth(): ProviderOwnedOAuth {
  if (cached !== undefined) return cached
  const provider = builtinProviders().find((p) => p.id === 'openai-codex')
  const oauth = provider?.auth?.oauth as ProviderOwnedOAuth | undefined
  if (oauth === undefined) {
    throw new Error('[openai-accounts] pi-ai openai-codex provider OAuth unavailable')
  }
  cached = oauth
  return cached
}

/** 一次登录的运行时状态(Client 轮询用)。 */
export interface LoginRun {
  alias: string
  controller: AbortController
  authUrl?: string
  error?: string
}

export interface BrowserLoginResult {
  run: LoginRun
  promise: Promise<{ credential: OAuthCredential }>
}

/** 永不 resolve 的 prompt:浏览器流程中手动粘贴授权码非必需,回调服务器会完成。 */
function pendingPrompt(): Promise<string> {
  return new Promise<string>(() => { /* 由 AbortSignal 或流程完成终结 */ })
}

/**
 * 以浏览器直开授权方式启动一次登录。
 * 调用方随后轮询 run.authUrl 出现后 window.open 打开;用户授权后 promise 兑现。
 */
export function startBrowserLogin(alias: string): BrowserLoginResult {
  const controller = new AbortController()
  const run: LoginRun = { alias, controller }
  const promise = getCodexOAuth().login({
    signal: controller.signal,
    prompt: async (prompt) => {
      if (prompt.type === 'select') {
        // 登录方式选择:固定选择 Browser login(默认项)。
        const browser = prompt.options.find((option) => /browser/i.test(option.label))
        if (browser === undefined) {
          throw new Error('[openai-accounts] pi-ai offered no browser login option')
        }
        return browser.id
      }
      // manual_code(手动粘贴授权码):不需要,本地回调服务器会完成;挂起等待即可。
      return pendingPrompt()
    },
    notify: (event) => {
      if (event.type === 'auth_url') {
        run.authUrl = event.url
      }
    },
  })
  return {
    run,
    promise: promise.then((credential) => ({ credential })),
  }
}
