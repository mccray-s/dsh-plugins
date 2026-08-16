/**
 * dsh-openai-accounts — DSH OpenAI 多账号切换插件(Host 半部)。
 *
 * 账号模型:ChatGPT 订阅账号(Codex Plus 等)的 OAuth 凭据。
 * - 登录:复用 pi-ai openai-codex provider 的官方浏览器授权流程(src/oauth.ts);
 * - 切换账号 = 把该账号的 access token 写入 `activeRef`(默认 DSH_CODEX_TOKEN);
 *   llm-pi-ai 的 `openai-codex` provider 路由(profile 配 apiKeyEnv)每请求重新解析,
 *   下一个请求立即使用新账号 —— 主代理与内建子代理统一生效。
 * - token 刷新:切换时 + `llm/stream` 瀑布(请求前惰性检查,5 分钟提前量),
 *   刷新与持久化由本插件负责(pi-ai 库内自动刷新需要 credential store,llm-pi-ai
 *   未注入,所以这里在库外承担)。
 * - 存储布局(credentials 服务,$DSH_HOME/.credentials.yaml,0600 私有):
 *     <indexRef>          = JSON { version:1, active, accounts:[{alias,hint}] }
 *     <keyPrefix><ALIAS>  = JSON OAuthCredential {access, refresh, expires, accountId?}
 *     <activeRef>         = 当前激活账号的 access token(切换目标)
 * - 环境变量遮蔽:进程环境存在 <activeRef> 时 set() 会 reject,list 返回 envShadowed。
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { getCodexOAuth, startBrowserLogin, type OAuthCredential } from './oauth.js'

// llm/stream 瀑布事件的最小契约(dsh-llm 的 Events 增强未加载,按需声明)。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'llm/stream'(options: StreamOptionsLike, next: () => AsyncIterable<unknown>): AsyncIterable<unknown>
  }
}

/** llm/stream 瀑布的 options 最小形态。 */
interface StreamOptionsLike {
  provider?: string
}

const DEFAULT_INDEX_REF = 'DSH_OPENAI_ACCOUNTS_INDEX'
const DEFAULT_ACTIVE_REF = 'DSH_CODEX_TOKEN'
const DEFAULT_KEY_PREFIX = 'DSH_OPENAI_KEY_'
const DEFAULT_ROUTE_PROVIDER = 'openai-codex'
/** 提前刷新余量:expires 距现在小于该值即刷新。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000
const ALIAS_RE = /^[A-Za-z0-9._-]{1,32}$/

/** 行配置:可覆盖凭据引用名与路由(见 cordis.patch.yml 注释)。 */
export interface Config {
  /** 切换目标凭据引用(access token),默认 DSH_CODEX_TOKEN。 */
  activeRef?: string
  /** 账号索引条目,默认 DSH_OPENAI_ACCOUNTS_INDEX。 */
  indexRef?: string
  /** 每账号凭据条目前缀,默认 DSH_OPENAI_KEY_。 */
  keyPrefix?: string
  /** 消费 access token 的 llm provider 路由,默认 openai-codex。 */
  routeProvider?: string
}

/** credentials 服务的本插件所需最小契约。 */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value?: string; source?: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

interface AccountEntry {
  alias: string
  hint: string
}

interface AccountsIndex {
  active: string | null
  accounts: AccountEntry[]
}

/** list 返回的完整状态(即 Remote 的 wire 形态)。 */
export interface OpenAiAccountsState {
  entries: Array<{ alias: string; hint: string; active: boolean; hasKey: boolean }>
  active: string | null
  envShadowed: boolean
  /** 消费 access token 的 llm provider 路由(客户端据此判断额度胶囊是否与当前模型相关)。 */
  routeProvider: string
}

/** 登录流程状态(Client 轮询用)。 */
export interface LoginView {
  status: 'idle' | 'started' | 'waiting' | 'done' | 'error' | 'cancelled'
  alias?: string
  /** 浏览器授权页地址(Client 收到后 window.open 打开)。 */
  authUrl?: string
  error?: string
}

/** 账号额度/订阅视图(来自 wham/usage 端点)。 */
export interface UsageView {
  planType?: string
  email?: string
  /** 已用百分比(0-100);可用 = 100 - usedPercent,由客户端展示。 */
  usedPercent?: number
  limitWindowSeconds?: number
  resetAt?: number
  /** 距窗口重置的秒数(比绝对时间更直观,如「4天12小时后重置」)。 */
  resetAfterSeconds?: number
  limitReached?: boolean
  creditsAvailable?: boolean
  creditsUnlimited?: boolean
  creditsBalance?: string
  resetCredits?: number
  error?: string
}

/** subprocess 服务的最小契约(curl 拉取用量用)。 */
interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'pipe' | 'ignore'; stdout: 'pipe'; stderr: 'inherit' }
    graceMs: number
  }): {
    pid: number
    done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
    stdout?: AsyncIterable<Uint8Array>
  }
}

export default class OpenAiAccountsService extends TypertRemoteService {
  static inject = ['credentials'] as const

  private readonly credentials: CredentialsLike
  private readonly indexRef: string
  private readonly activeRef: string
  private readonly keyPrefix: string
  private readonly routeProvider: string
  private readonly subprocess: SubprocessLike | undefined
  private tail: Promise<void> = Promise.resolve()
  private login: { alias: string; controller: AbortController; authUrl?: string; error?: string; settled: boolean } | undefined
  private readonly refreshes = new Map<string, Promise<OAuthCredential>>()
  private readonly usageCache = new Map<string, { at: number; view: UsageView }>()
  private readonly usageTtlMs = 5 * 60 * 1000

  /**
   * @param ctx - Cordis Context(credentials 服务由 inject 保证就绪)。
   * @param config - 行配置,可覆盖凭据引用名与路由。
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'openaiAccounts')
    this.indexRef = config.indexRef ?? DEFAULT_INDEX_REF
    this.activeRef = config.activeRef ?? DEFAULT_ACTIVE_REF
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX
    this.routeProvider = config.routeProvider ?? DEFAULT_ROUTE_PROVIDER
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    if (credentials === undefined) {
      throw new Error('[openai-accounts] credentials service unavailable')
    }
    this.credentials = credentials
    this.subprocess = ctx.get('subprocess') as SubprocessLike | undefined

    // 启动恢复激活账号的 access token(必要时先刷新)。
    this.serialized(() => this.restoreActive()).catch((error: unknown) => {
      console.error('[openai-accounts] startup restore failed: ' + String(error))
    })

    // llm/stream 瀑布:路由匹配时,请求前惰性刷新(过期/接近过期)。
    ctx.on('llm/stream', this.streamRefresh.bind(this))
  }

  /** llm/stream 瀑布监听:路由匹配时先确保激活 token 新鲜,再放行。 */
  private async *streamRefresh(options: StreamOptionsLike, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
    if (options?.provider === this.routeProvider) {
      try {
        await this.ensureActiveFresh()
      } catch (error) {
        // 刷新失败不阻断请求:上游会以旧 token 失败并显式报错。
        console.warn('[openai-accounts] pre-request refresh failed: ' + String(error))
      }
    }
    yield* next()
  }

  // ---- 基础工具 ----

  private keyRef(alias: string): string {
    return this.keyPrefix + alias.toUpperCase()
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async readIndex(): Promise<AccountsIndex> {
    const raw = (await this.credentials.resolve(this.indexRef))?.value
    if (!raw) return { active: null, accounts: [] }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.accounts)) {
        const accounts: AccountEntry[] = []
        for (const entry of parsed.accounts as unknown[]) {
          if (isRecord(entry) && typeof entry.alias === 'string' && ALIAS_RE.test(entry.alias)) {
            accounts.push({ alias: entry.alias, hint: typeof entry.hint === 'string' ? entry.hint : '' })
          }
        }
        const active = typeof parsed.active === 'string' && accounts.some((a) => a.alias === parsed.active)
          ? parsed.active
          : null
        return { active, accounts }
      }
    } catch { /* 损坏则回退空索引 */ }
    return { active: null, accounts: [] }
  }

  private async writeIndex(index: AccountsIndex): Promise<void> {
    await this.credentials.set(
      this.indexRef,
      JSON.stringify({ version: 1, active: index.active, accounts: index.accounts }),
    )
  }

  private async readCredential(alias: string): Promise<OAuthCredential | undefined> {
    const raw = (await this.credentials.resolve(this.keyRef(alias)))?.value
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isRecord(parsed) && typeof parsed.access === 'string' && typeof parsed.refresh === 'string' && typeof parsed.expires === 'number') {
        return {
          access: parsed.access,
          refresh: parsed.refresh,
          expires: parsed.expires,
          accountId: typeof parsed.accountId === 'string' ? parsed.accountId : undefined,
        }
      }
    } catch { /* 损坏视为无凭据 */ }
    return undefined
  }

  private async writeCredential(alias: string, credential: OAuthCredential): Promise<void> {
    await this.credentials.set(this.keyRef(alias), JSON.stringify(credential))
  }

  private async listState(): Promise<OpenAiAccountsState> {
    const index = await this.readIndex()
    const entries: OpenAiAccountsState['entries'] = []
    for (const account of index.accounts) {
      const credential = await this.readCredential(account.alias)
      entries.push({
        alias: account.alias,
        hint: account.hint,
        active: account.alias === index.active,
        hasKey: credential !== undefined,
      })
    }
    let envShadowed = false
    if (index.active) {
      const resolved = await this.credentials.resolve(this.activeRef)
      if (resolved && resolved.source === 'env') envShadowed = true
    }
    return { entries, active: index.active, envShadowed, routeProvider: this.routeProvider }
  }

  // ---- 刷新 ----

  /**
   * 刷新一个账号的凭据(按账号 in-flight 去重),并写回存储。
   */
  private refreshCredential(alias: string, credential: OAuthCredential): Promise<OAuthCredential> {
    const existing = this.refreshes.get(alias)
    if (existing !== undefined) return existing
    const task = (async () => {
      try {
        const refreshed = await getCodexOAuth().refresh(credential)
        await this.writeCredential(alias, refreshed)
        return refreshed
      } finally {
        this.refreshes.delete(alias)
      }
    })()
    this.refreshes.set(alias, task)
    return task
  }

  /** 激活账号接近过期时刷新,并保证 activeRef 持有最新 access token。 */
  private async ensureActiveFresh(): Promise<void> {
    const index = await this.readIndex()
    if (!index.active) return
    const credential = await this.readCredential(index.active)
    if (!credential) return
    const fresh = credential.expires <= Date.now() + REFRESH_SKEW_MS
      ? await this.refreshCredential(index.active, credential)
      : credential
    await this.credentials.set(this.activeRef, fresh.access)
  }

  private async restoreActive(): Promise<void> {
    await this.ensureActiveFresh()
  }

  // ---- Remote 方法(与 src/typert.ts 的 invocations 一一对应)----

  list(): Promise<OpenAiAccountsState> {
    return this.serialized(() => this.listState())
  }

  switch(args: { alias: string }): Promise<OpenAiAccountsState | { error: string }> {
    return this.serialized(() => this.switchAccount(String(args?.alias ?? '')))
  }

  delete(args: { alias: string }): Promise<OpenAiAccountsState | { error: string }> {
    return this.serialized(() => this.deleteAccount(String(args?.alias ?? '')))
  }

  loginStart(args: { alias: string }): LoginView | { error: string } {
    const alias = String(args?.alias ?? '')
    if (!ALIAS_RE.test(alias)) {
      return { error: 'alias must be 1-32 chars of letters, digits, dot, underscore or hyphen' }
    }
    if (this.login !== undefined && !this.login.settled) {
      return { error: 'a login is already in progress' }
    }
    const login: NonNullable<OpenAiAccountsService['login']> = { alias, controller: new AbortController(), settled: false }
    this.login = login
    void (async () => {
      try {
        const { run, promise } = startBrowserLogin(alias)
        // 授权 URL 到达后同步到 login 状态(Client 轮询可见并 window.open)。
        const urlPoll = setInterval(() => {
          if (run.authUrl !== undefined && login.authUrl === undefined) {
            login.authUrl = run.authUrl
          }
        }, 200)
        try {
          const { credential } = await promise
          login.settled = true
          await this.serialized(() => this.completeLogin(login, credential))
        } finally {
          clearInterval(urlPoll)
        }
      } catch (error) {
        login.settled = true
        if (!login.controller.signal.aborted) {
          login.error = messageOf(error)
        }
      }
    })()
    return { status: 'started', alias }
  }

  loginStatus(): LoginView {
    const login = this.login
    if (login === undefined) return { status: 'idle' }
    if (login.settled) {
      return login.error !== undefined
        ? { status: 'error', alias: login.alias, error: login.error }
        : { status: 'done', alias: login.alias }
    }
    if (login.authUrl !== undefined) {
      return {
        status: 'waiting',
        alias: login.alias,
        authUrl: login.authUrl,
      }
    }
    return { status: 'started', alias: login.alias }
  }

  loginCancel(): LoginView {
    if (this.login !== undefined && !this.login.settled) {
      this.login.controller.abort()
    }
    return { status: 'idle' }
  }

  /**
   * 用量视图:只读凭据 + 缓存,不写索引,故不经全局 serialized 串行锁,
   * 允许多账号并发 curl(与 list/switch/delete 的索引一致性无关)。
   */
  usage(args: { alias: string; force?: boolean }): Promise<UsageView> {
    return this.usageOf(String(args?.alias ?? ''), args?.force === true)
  }

  // ---- 用量/订阅 ----

  /** 账号额度视图:优先走缓存(5 分钟 TTL),force 时强制刷新。 */
  private async usageOf(alias: string, force: boolean): Promise<UsageView> {
    if (!ALIAS_RE.test(alias)) return { error: 'invalid alias' }
    if (!force) {
      const hit = this.usageCache.get(alias)
      if (hit !== undefined && Date.now() - hit.at < this.usageTtlMs) return hit.view
    }
    const view = await this.fetchUsage(alias)
    this.usageCache.set(alias, { at: Date.now(), view })
    return view
  }

  /**
   * 拉取 wham/usage 端点(订阅计划 + 额度窗口 + credits):
   * GET https://chatgpt.com/backend-api/wham/usage,Authorization: Bearer <access>。
   * 注意 web 服务的 fetch 不支持自定义 header,这里经 subprocess 调 curl。
   */
  private async fetchUsage(alias: string): Promise<UsageView> {
    if (this.subprocess === undefined) return { error: 'subprocess service unavailable' }
    const credential = await this.readCredential(alias)
    if (!credential) return { error: `account "${alias}" has no stored credential` }
    let fresh = credential
    if (fresh.expires <= Date.now() + REFRESH_SKEW_MS) {
      try {
        fresh = await this.refreshCredential(alias, credential)
      } catch (error) {
        return { error: 'token refresh failed: ' + messageOf(error) }
      }
    }
    const child = this.subprocess.spawn({
      argv: [
        'curl', '-sS', '-f', '-m', '10',
        '-A', 'dsh-openai-accounts',
        '-H', 'Authorization: Bearer ' + fresh.access,
        'https://chatgpt.com/backend-api/wham/usage',
      ],
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3_000,
    })
    let out = ''
    const decoder = new TextDecoder()
    if (child.stdout !== undefined) {
      try {
        for await (const chunk of child.stdout) {
          out += decoder.decode(chunk, { stream: true })
        }
      } catch { /* 流中断:以已收集内容为准 */ }
    }
    out += decoder.decode()
    const outcome = await child.done
    if (outcome.exitCode !== 0) {
      return { error: `usage endpoint failed (curl exit ${String(outcome.exitCode)})` }
    }
    try {
      const payload = JSON.parse(out) as Record<string, unknown>
      const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {}
      const primary = isRecord(rateLimit.primary_window) ? rateLimit.primary_window : {}
      const credits = isRecord(payload.credits) ? payload.credits : {}
      const resetCredits = isRecord(payload.rate_limit_reset_credits) ? payload.rate_limit_reset_credits : {}
      return {
        planType: typeof payload.plan_type === 'string' ? payload.plan_type : undefined,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        usedPercent: typeof primary.used_percent === 'number' ? primary.used_percent : undefined,
        limitWindowSeconds: typeof primary.limit_window_seconds === 'number' ? primary.limit_window_seconds : undefined,
        resetAt: typeof primary.reset_at === 'number' ? primary.reset_at : undefined,
        resetAfterSeconds: typeof primary.reset_after_seconds === 'number' ? primary.reset_after_seconds : undefined,
        limitReached: rateLimit.limit_reached === true,
        creditsAvailable: credits.has_credits === true,
        creditsUnlimited: credits.unlimited === true,
        creditsBalance: typeof credits.balance === 'string' ? credits.balance : undefined,
        resetCredits: typeof resetCredits.available_count === 'number' ? resetCredits.available_count : undefined,
      }
    } catch (error) {
      return { error: 'usage endpoint returned invalid data: ' + messageOf(error) }
    }
  }

  // ---- 业务实现 ----

  private async completeLogin(login: { alias: string }, credential: OAuthCredential): Promise<void> {
    const index = await this.readIndex()
    const account = index.accounts.find((a) => a.alias === login.alias)
    if (account) account.hint = credential.access.slice(-4)
    else index.accounts.push({ alias: login.alias, hint: credential.access.slice(-4) })
    await this.writeCredential(login.alias, credential)
    if (index.active === null) {
      // 第一个账号自动激活。
      index.active = login.alias
      await this.credentials.set(this.activeRef, credential.access)
    }
    await this.writeIndex(index)
  }

  private async switchAccount(alias: string): Promise<OpenAiAccountsState | { error: string }> {
    if (!ALIAS_RE.test(alias)) return { error: 'invalid alias' }
    const index = await this.readIndex()
    if (!index.accounts.some((a) => a.alias === alias)) {
      return { error: `account "${alias}" not found` }
    }
    const credential = await this.readCredential(alias)
    if (!credential) return { error: `account "${alias}" has no stored credential` }
    try {
      const fresh = credential.expires <= Date.now() + REFRESH_SKEW_MS
        ? await this.refreshCredential(alias, credential)
        : credential
      await this.credentials.set(this.activeRef, fresh.access) // 被环境变量遮蔽时此处会 reject
    } catch (error) {
      return { error: messageOf(error) }
    }
    index.active = alias
    await this.writeIndex(index)
    return this.listState()
  }

  private async deleteAccount(alias: string): Promise<OpenAiAccountsState | { error: string }> {
    if (!ALIAS_RE.test(alias)) return { error: 'invalid alias' }
    const index = await this.readIndex()
    const nextAccounts = index.accounts.filter((a) => a.alias !== alias)
    if (nextAccounts.length === index.accounts.length) return { error: `account "${alias}" not found` }
    try {
      await this.credentials.unset(this.keyRef(alias))
    } catch (error) {
      return { error: messageOf(error) }
    }
    let active = index.active
    if (active === alias) {
      if (nextAccounts.length > 0) {
        active = nextAccounts[0].alias
        const credential = await this.readCredential(active)
        if (credential) {
          try {
            const fresh = credential.expires <= Date.now() + REFRESH_SKEW_MS
              ? await this.refreshCredential(active, credential)
              : credential
            await this.credentials.set(this.activeRef, fresh.access)
          } catch (error) {
            return { error: messageOf(error) }
          }
        } else {
          await this.credentials.unset(this.activeRef)
        }
      } else {
        active = null
        await this.credentials.unset(this.activeRef)
      }
    }
    await this.writeIndex({ active, accounts: nextAccounts })
    return this.listState()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
