/**
 * dsh-openai-accounts — Web 客户端插件(browser bundle 入口)。
 *
 * UI 位置:
 * - 设置页独立菜单项(settings.section,id 'openai-accounts',order 12):账号管理;
 * - 输入栏工具行右侧 chip(conversation.input.right):当前账号名 + 可用额度,
 *   点击弹出额度详情/账号快速切换(conversation.input.overlay)。
 *   chip 受 provider 门控:仅当当前会话选中的模型 provider 等于插件的路由
 *   provider(默认 openai-codex,来自 host list().routeProvider)时显示;
 *   数据源 = 模型选择器共用的 ctx.modelDirectories store(即时推送,无轮询)。
 *
 * 与 Host 的通信:apply 内 ctx.remote.$mount(本包的 Remote 贡献,来自 descriptors),
 * 然后经 ctx.get('remote.openaiAccounts') 调用
 * list / switch / delete / loginStart / loginStatus / loginCancel / usage。
 *
 * 登录:Host 运行官方浏览器授权流程,页面收到 authUrl 后 window.open 打开授权页,
 * 期间轮询 loginStatus;完成后自动刷新列表。
 */

import type * as ReactNS from 'react'
import { INVOCATIONS } from './descriptors.js'

// 运行时经模块表 require('react');类型来自 @types/react(仅构建期)。
declare const require: (id: string) => unknown
const React = require('react') as typeof ReactNS

/** 客户端 Remote 贡献(与 lib/typert.js 的 invocations 一致)。 */
export const CONTRIBUTION = {
  package: 'dsh-openai-accounts',
  descriptors: INVOCATIONS,
}

/** 客户端 Cordis 上下文的最小契约。 */
interface ClientCtx {
  get(name: string): unknown
  effect?(callback: () => (() => void) | void): void
}

/** Remote 调用的统一信封。 */
type RemoteEnvelope =
  | { ok: true; value?: unknown }
  | { ok: false; error: unknown }

/** Host 返回的完整状态。 */
interface AccountsState {
  entries?: Array<{ alias: string; hint: string; active: boolean; hasKey: boolean }>
  active?: string | null
  envShadowed?: boolean
  /** 消费 access token 的 llm provider 路由(额度胶囊的门控依据)。 */
  routeProvider?: string
  error?: string
}

/** Host 返回的登录状态。 */
interface LoginState {
  status?: 'idle' | 'started' | 'waiting' | 'done' | 'error' | 'cancelled'
  alias?: string
  authUrl?: string
  error?: string
}

interface EntryRow {
  alias: string
  hint: string
  active: boolean
  hasKey: boolean
}

/** 账号额度/订阅视图(来自 wham/usage 端点)。 */
interface UsageView {
  planType?: string
  email?: string
  usedPercent?: number
  limitWindowSeconds?: number
  resetAt?: number
  resetAfterSeconds?: number
  limitReached?: boolean
  creditsAvailable?: boolean
  creditsUnlimited?: boolean
  creditsBalance?: string
  resetCredits?: number
  error?: string
}

/** 登录流程的 UI 阶段。 */
type LoginPhase = 'idle' | 'alias' | 'started' | 'waiting' | 'error'

export const name = 'openai-accounts'
export const inject = ['slots', 'remote', 'timer']

export async function apply(ctx: ClientCtx): Promise<void> {
  const slots = ctx.get('slots') as SlotsLike | undefined
  const remote = ctx.get('remote') as RemoteLike | undefined
  const timer = ctx.get('timer') as TimerLike | undefined
  if (slots === undefined || remote === undefined || timer === undefined) return
  // 收窄后的不可空别名(闭包内 TS 对捕获变量会丢失收窄)。
  const slotsApi: SlotsLike = slots
  const timerApi: TimerLike = timer

  // 挂载本包的 Remote 命名空间(网关上下文),随后经服务名调用。
  await remote.$mount(CONTRIBUTION)
  const accounts = ctx.get('remote.openaiAccounts') as Record<string, (...args: unknown[]) => Promise<RemoteEnvelope>> | undefined
  if (accounts === undefined) {
    console.error('[openai-accounts] remote.openaiAccounts unavailable after $mount')
    return
  }

  const call = async (method: string, args?: unknown): Promise<AccountsState> => {
    try {
      const fn = accounts[method]
      if (typeof fn !== 'function') return { error: `unknown method "${method}"` }
      const res = method === 'list' || method === 'loginStatus' || method === 'loginCancel' ? await fn() : await fn(args)
      if (res && res.ok === true) return (res.value ?? {}) as AccountsState
      if (res && res.ok === false) {
        return { error: messageOf(res.error) }
      }
      return {}
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  // 注入插件全局样式(旋转动画 + 原生风格 hover/disabled 反馈;卸载时随 ctx.effect 清理)。
  // 对齐原生 Button/Menu 规范:chip 常驻交互底色(hover 加深)、按钮 hover 底色、
  // primary hover = button-primary-hover、危险 hover = interactive-bg-hover-danger、
  // disabled = opacity 0.4。class 带 dsh-oa- 前缀避免全局冲突。
  const pluginStyle = [
    '@keyframes dsh-oa-spin { to { transform: rotate(360deg); } }',
    '.dsh-oa-chip { background: var(--dsw-alias-interactive-bg-hover); }',
    '.dsh-oa-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }',
    '.dsh-oa-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
    '.dsh-oa-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }',
    '.dsh-oa-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }',
    '.dsh-oa-chip:disabled, .dsh-oa-btn:disabled, .dsh-oa-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }',
  ].join('\n')
  if (ctx.effect !== undefined) {
    ctx.effect(() => {
      const style = document.createElement('style')
      style.id = 'dsh-openai-accounts-style'
      style.textContent = pluginStyle
      document.head.appendChild(style)
      return () => { style.remove() }
    })
  } else {
    const style = document.createElement('style')
    style.id = 'dsh-openai-accounts-style'
    style.textContent = pluginStyle
    document.head.appendChild(style)
  }

  // 按钮样式常量(设置页与快捷面板共用;对齐原生 Button 组件,md: h36/r18;sm: h28/r14)。
  const primaryButtonStyle: ReactNS.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
    border: 'none', borderRadius: 18, height: 36, padding: '0 14px', fontSize: 14, cursor: 'pointer',
  }
  const ghostButtonStyle: ReactNS.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    background: 'transparent', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, height: 36, padding: '0 14px',
    fontSize: 14, cursor: 'pointer',
  }
  const smallButtonStyle: ReactNS.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 14,
    height: 28, padding: '0 10px',
    color: 'var(--dsw-alias-label-primary)', fontSize: 12, cursor: 'pointer',
  }
  const dangerButtonStyle: ReactNS.CSSProperties = {
    ...smallButtonStyle,
    // 与模型管理一致:无边框红字,仅 hover 时出现危险底色。
    border: 'none',
    color: 'var(--dsw-alias-state-error-primary)',
  }

  // SVG 图标:viewBox 保证字形中心精确(Unicode 符号如 ⟳/⚙ 的视觉中心会偏移),
  // 旋转 animation 作用于 svg 元素自身,transform-origin 默认 50% 50% → 中心旋转。
  const iconRefresh = (size: number, spin: boolean): ReactNS.ReactElement => React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { display: 'block', animation: spin ? 'dsh-oa-spin 0.9s linear infinite' : undefined },
  },
    React.createElement('path', { d: 'M23 4v6h-6' }),
    React.createElement('path', { d: 'M1 20v-6h6' }),
    React.createElement('path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }),
  )
  const iconSettings = (size: number): ReactNS.ReactElement => React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { display: 'block' },
  },
    React.createElement('circle', { cx: 12, cy: 12, r: 3 }),
    React.createElement('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' }),
  )

  // ---- 设置页:账号管理(settings.section 'openai-accounts')----
  function AccountPage(): ReactNS.ReactElement {
    const [view, setView] = React.useState({
      loading: false, busy: false, entries: [] as EntryRow[], active: null as string | null,
      envShadowed: false, error: null as string | null, confirmRemove: null as string | null,
      loginPhase: 'idle' as LoginPhase, loginAlias: '', loginError: null as string | null,
      authUrl: null as string | null, authOpened: false,
      usage: {} as Record<string, UsageView>, usageLoading: {} as Record<string, boolean>,
      busyAction: null as string | null,
    })

    const applyResult = (res: AccountsState): void => setView((v) => ({
      ...v, loading: false, busy: false,
      entries: Array.isArray(res.entries) ? res.entries : v.entries,
      active: typeof res.active === 'string' ? res.active : v.active,
      envShadowed: !!res.envShadowed,
      error: typeof res.error === 'string' ? res.error : null,
    }))

    const refresh = async (): Promise<void> => {
      setView((v) => ({ ...v, loading: true, error: null }))
      const res = await call('list')
      applyResult(res)
      // 列表就绪后为每个账号拉取额度/订阅(host 侧 5 分钟缓存)。
      const aliases = (Array.isArray(res.entries) ? res.entries : []).map((e: EntryRow) => e.alias)
      for (const alias of aliases) void loadUsage(alias, false)
    }
    React.useEffect(() => { void refresh() }, [])

    const loadUsage = async (alias: string, force: boolean): Promise<void> => {
      setView((v) => ({ ...v, usageLoading: { ...v.usageLoading, [alias]: true } }))
      const res = await call('usage', { alias, force }) as unknown as UsageView
      setView((v) => ({
        ...v,
        usage: { ...v.usage, [alias]: res },
        usageLoading: { ...v.usageLoading, [alias]: false },
      }))
    }

    const act = async (action: string | null, method: string, args?: unknown): Promise<AccountsState> => {
      setView((v) => ({ ...v, busy: true, busyAction: action, error: null }))
      const res = await call(method, args)
      applyResult(res)
      setView((v) => ({ ...v, busy: false, busyAction: null }))
      return res
    }

    // ---- 登录轮询:started/waiting 阶段每 2 秒查一次状态 ----
    const pollLogin = async (): Promise<void> => {
      const res = await call('loginStatus')
      const status = (res as unknown as LoginState).status
      if (status === 'waiting') {
        const ls = res as unknown as LoginState
        setView((v) => {
          const next = {
            ...v,
            authUrl: ls.authUrl ?? v.authUrl,
          }
          // 首次拿到授权 URL:直接打开浏览器授权页(被拦截时面板上有链接兜底)。
          if (next.authUrl !== null && !v.authOpened) {
            next.authOpened = true
            try {
              window.open(next.authUrl, '_blank')
            } catch { /* 弹窗被拦截:链接可用 */ }
          }
          return next
        })
        return
      }
      if (status === 'done') {
        setView((v) => ({
          ...v, loginPhase: 'idle', loginAlias: '', authUrl: null, authOpened: false, loginError: null,
        }))
        void refresh()
        return
      }
      if (status === 'error') {
        setView((v) => ({
          ...v, loginPhase: 'error', loginError: ((res as unknown as LoginState).error) ?? '登录失败',
        }))
        return
      }
      if (status === 'idle' || status === 'cancelled') {
        setView((v) => ({
          ...v, loginPhase: 'idle', loginAlias: '', authUrl: null, authOpened: false, loginError: null,
        }))
      }
    }
    const polling = view.loginPhase === 'started' || view.loginPhase === 'waiting'
    React.useEffect(() => {
      if (!polling) return
      const dispose = timerApi.interval(() => { void pollLogin() }, 2000)
      return dispose
    }, [polling])

    const startLogin = async (): Promise<void> => {
      const res = await call('loginStart', { alias: view.loginAlias.trim() })
      if (res.error) {
        setView((v) => ({ ...v, loginPhase: 'error', loginError: res.error ?? null }))
        return
      }
      setView((v) => ({ ...v, loginPhase: 'started', loginError: null }))
    }

    const cancelLogin = async (): Promise<void> => {
      await call('loginCancel')
      setView((v) => ({
        ...v, loginPhase: 'idle', loginAlias: '', authUrl: null, authOpened: false, loginError: null,
      }))
    }

    // 输入框:无边框 + 底色(原生输入风格,interactive 底色)。
    const inputStyle: ReactNS.CSSProperties = {
      width: '100%', boxSizing: 'border-box', marginBottom: 6, padding: '7px 10px',
      border: 'none', borderRadius: 10,
      background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)', fontSize: 13,
    }

    const row = (entry: EntryRow): ReactNS.ReactElement => {
      const isActive = entry.active === true
      const confirming = view.confirmRemove === entry.alias
      // 操作按钮统一在卡片右上角(第一行右侧,垂直居中)。
      const actions = isActive
        ? null // 已激活:绿点已在别名旁标识,不显示切换/激活文字
        : React.createElement('button', {
            disabled: view.busy,
            onClick: () => { void act('switch', 'switch', { alias: entry.alias }) },
            className: 'dsh-oa-btn',
            style: smallButtonStyle,
          }, view.busyAction === 'switch' ? '切换中…' : '切换')
      const remove = confirming
        ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('button', {
              disabled: view.busy,
              onClick: () => { void act('delete', 'delete', { alias: entry.alias }); setView((v) => ({ ...v, confirmRemove: null })) },
              className: 'dsh-oa-btn-danger',
              style: dangerButtonStyle,
            }, view.busyAction === 'delete' ? '删除中…' : '确认删除?'),
            React.createElement('button', {
              disabled: view.busy,
              onClick: () => setView((v) => ({ ...v, confirmRemove: null })),
              className: 'dsh-oa-btn',
              style: smallButtonStyle,
            }, '取消'))
        : React.createElement('button', {
            disabled: view.busy,
            onClick: () => setView((v) => ({ ...v, confirmRemove: entry.alias })),
            className: 'dsh-oa-btn-danger',
            style: dangerButtonStyle,
          }, '删除')
      const usage = view.usage[entry.alias]
      const usageBusy = view.usageLoading[entry.alias] === true
      const planBadge = usage && usage.planType
        ? React.createElement('span', {
            style: {
              fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 8,
              background: 'var(--dsw-alias-interactive-bg-hover)',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, usage.planType.toUpperCase())
        : null
      // 额度块:进度条上方左右分布(左=额度描述,右=重置时间),进度条撑满宽度。
      let usageBody: ReactNS.ReactElement | null = null
      if (usage && usage.error) {
        usageBody = React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, marginTop: 6 } }, '用量获取失败:' + usage.error)
      } else if (usage && typeof usage.usedPercent === 'number') {
        const pct = Math.max(0, Math.min(100, usage.usedPercent))
        const avail = Math.max(0, 100 - pct)
        const over = pct >= 80
        const windowLabel = usage.limitWindowSeconds === 604800 ? '周额度'
          : usage.limitWindowSeconds === 18000 ? '5小时额度'
          : usage.limitWindowSeconds !== undefined ? Math.round(usage.limitWindowSeconds / 3600) + 'h额度'
          : '额度'
        const resetText = usage.resetAfterSeconds !== undefined
          ? '距重置 ' + formatDuration(usage.resetAfterSeconds)
          : usage.resetAt !== undefined
            ? '重置 ' + new Date(usage.resetAt * 1000).toLocaleString()
            : ''
        usageBody = React.createElement('div', { style: { marginTop: 8 } },
          React.createElement('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 },
          },
            React.createElement('div', {
              style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden', flexWrap: 'wrap', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
            },
              React.createElement('span', {
                style: { color: over ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
              }, `可用 ${avail}%`),
              React.createElement('span', { style: { whiteSpace: 'nowrap' } }, `已用 ${pct}% · ${windowLabel}`),
              usage.limitReached ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '已达上限') : null,
              usage.creditsAvailable === true
                ? React.createElement('span', { style: { whiteSpace: 'nowrap' } }, usage.creditsUnlimited === true ? '· 额度无限' : `· Credits ${usage.creditsBalance ?? ''}`)
                : null,
              usage.resetCredits !== undefined && usage.resetCredits > 0
                ? React.createElement('span', { style: { whiteSpace: 'nowrap' } }, `· 重置券×${usage.resetCredits}`)
                : null),
            resetText
              ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, whiteSpace: 'nowrap' } }, resetText)
              : null),
          React.createElement('div', {
            style: {
              height: 4, borderRadius: 2, overflow: 'hidden', width: '100%',
              background: 'var(--dsw-alias-interactive-bg-hover)',
            },
          },
            React.createElement('div', {
              style: {
                width: avail + '%', height: '100%',
                background: over ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
              },
            })),
        )
      } else if (usageBusy) {
        usageBody = React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, marginTop: 6 } }, '加载额度…')
      }
      return React.createElement('div', {
        key: entry.alias,
        style: {
          display: 'flex', flexDirection: 'column', padding: '10px 12px',
          border: '1px solid ' + (isActive ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)'),
          borderRadius: 12, marginBottom: 8,
          background: isActive ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
        },
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: isActive ? 600 : 400 } }, entry.alias),
            isActive
              ? React.createElement('span', {
                  title: '已激活',
                  style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)', flexShrink: 0 },
                })
              : null,
            planBadge,
            usage && usage.email
              ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, usage.email)
              : null,
            !entry.hasKey ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 11, whiteSpace: 'nowrap' } }, '缺凭据') : null),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('button', {
              disabled: view.busy || usageBusy,
              onClick: () => { void loadUsage(entry.alias, true) },
              title: '刷新额度',
              className: 'dsh-oa-btn',
              style: { ...smallButtonStyle, padding: '0 8px' },
            }, iconRefresh(14, usageBusy)),
            actions,
            remove),
        ),
        usageBody,
      )
    }

    const banner = (text: string, color: string): ReactNS.ReactElement => React.createElement('div', {
      style: { padding: '8px 12px', borderRadius: 8, marginBottom: 10, fontSize: 12, color, border: '1px solid ' + color, background: 'var(--dsw-alias-bg-layer-1)' },
    }, text)

    // ---- 登录面板(分阶段)----
    let loginPanel: ReactNS.ReactElement | null = null
    if (view.loginPhase === 'alias') {
      loginPanel = React.createElement('div', { style: { marginTop: 16, marginBottom: 10, padding: 12, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12 } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, marginBottom: 6 } }, '添加订阅账号(浏览器授权)'),
        React.createElement('input', {
          placeholder: '别名(如 apps)', value: view.loginAlias,
          disabled: view.busy,
          onChange: (e: ReactNS.ChangeEvent<HTMLInputElement>) => setView((v) => ({ ...v, loginAlias: e.target.value })),
          style: inputStyle,
        }),
        React.createElement('div', { style: { display: 'flex', gap: 6 } },
          React.createElement('button', {
            disabled: view.busy || !view.loginAlias.trim(),
            onClick: () => { void startLogin() },
            className: 'dsh-oa-btn-primary',
            style: primaryButtonStyle,
          }, '开始登录'),
          React.createElement('button', {
            disabled: view.busy,
            onClick: () => setView((v) => ({ ...v, loginPhase: 'idle', loginAlias: '' })),
            className: 'dsh-oa-btn',
            style: ghostButtonStyle,
          }, '取消')))
    } else if (view.loginPhase === 'started') {
      loginPanel = React.createElement('div', { style: { marginTop: 16, marginBottom: 10, padding: 12, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12 } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, marginBottom: 6 } }, '正在启动登录…'),
        React.createElement('button', { onClick: () => { void cancelLogin() }, className: 'dsh-oa-btn', style: ghostButtonStyle }, '取消'))
    } else if (view.loginPhase === 'waiting') {
      loginPanel = React.createElement('div', { style: { marginTop: 16, marginBottom: 10, padding: 12, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12 } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, marginBottom: 8 } }, '浏览器授权页已打开'),
        view.authUrl
          ? React.createElement('div', { style: { marginBottom: 8 } },
              React.createElement('a', {
                href: view.authUrl,
                target: '_blank', rel: 'noreferrer',
                onClick: () => { try { if (view.authUrl !== null) window.open(view.authUrl, '_blank') } catch { /* 链接本身可打开 */ } },
                style: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 13 },
              }, '如果未自动打开,点击这里重新打开授权页'))
          : null,
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, marginBottom: 8 } }, '在打开的页面完成登录后,这里会自动继续(轮询中)…'),
        React.createElement('button', { onClick: () => { void cancelLogin() }, className: 'dsh-oa-btn', style: ghostButtonStyle }, '取消'))
    } else if (view.loginPhase === 'error') {
      loginPanel = React.createElement('div', { style: { marginTop: 16, marginBottom: 10 } },
        banner(view.loginError ?? '登录失败', 'var(--dsw-alias-state-error-primary)'),
        React.createElement('button', {
          onClick: () => setView((v) => ({ ...v, loginPhase: 'idle', loginAlias: '', loginError: null })),
          style: ghostButtonStyle,
        }, '关闭'))
    }

    return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: 640 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 12 } },
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 14, fontWeight: 600, marginBottom: 4 } }, 'OpenAI 账号'),
          React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, 'ChatGPT 订阅账号管理:登录、切换与删除。当前激活账号的 access token 会写入 DSH 凭据,主代理与子代理统一生效。')),
        view.loginPhase === 'idle'
          ? React.createElement('button', {
              disabled: view.busy,
              onClick: () => setView((v) => ({ ...v, loginPhase: 'alias', loginAlias: '' })),
              style: { ...ghostButtonStyle, whiteSpace: 'nowrap', marginTop: 2 },
            }, '➕ 添加账号')
          : null),
      view.envShadowed ? banner('⚠ 当前凭据引用被进程环境变量遮蔽,切换会失败;请先 unset 该环境变量', 'var(--dsw-alias-state-warn-primary)') : null,
      view.error ? banner(view.error, 'var(--dsw-alias-state-error-primary)') : null,
      view.loading ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: 8 } }, '加载中…')
        : view.entries.length === 0
          ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: '0 0 8px' } }, '尚无账号,点击右上角「添加账号」开始(第一个账号将自动激活)')
          : React.createElement('div', null, view.entries.map(row)),
      loginPanel,
    )
  }

  slotsApi.inject('settings.section', () => slotsApi.register(
    { name: 'settings.section', id: 'openai-accounts', order: 12, label: 'OpenAI 账号' },
    () => React.createElement(AccountPage, null),
  ))

  // ---- 计划/额度便捷面板:输入栏 chip(conversation.input.right)+ 浮层(conversation.input.overlay)----
  const planStore = {
    open: false,
    loading: false,
    entries: [] as EntryRow[],
    active: null as string | null,
    usage: {} as Record<string, UsageView>,
    /** 消费 access token 的 llm provider 路由(来自 host list();未知前假设插件默认值)。 */
    routeProvider: null as string | null,
    /** 打开时 chip 的视口位置(popover 据此锚定)。 */
    anchor: null as { left: number; right: number; top: number; bottom: number } | null,
    /** 正在切换的账号别名(切换按钮 loading 态)。 */
    switching: null as string | null,
    /** 正在刷新额度(⟳ 旋转态)。 */
    refreshing: false,
    /** 最近一次操作失败信息(popover 底部红色提示)。 */
    error: null as string | null,
    listeners: new Set<() => void>(),
  }
  const planNotify = (): void => { for (const listener of planStore.listeners) listener() }
  const usePlanStore = (): typeof planStore => {
    const [, force] = React.useState(0)
    React.useEffect(() => {
      const listener = (): void => force((n) => n + 1)
      planStore.listeners.add(listener)
      return () => { planStore.listeners.delete(listener) }
    }, [])
    return planStore
  }
  /** 自动刷新间隔:对齐 host 侧 usage 缓存 TTL(5 分钟)。 */
  const AUTO_REFRESH_MS = 5 * 60 * 1000
  let planLoadInFlight = false
  const planLoad = async (forceUsage: boolean): Promise<void> => {
    if (planLoadInFlight) return
    planLoadInFlight = true
    try {
      planStore.loading = true
      planStore.error = null
      planNotify()
      const res = await call('list')
      const entries = Array.isArray(res.entries) ? res.entries : []
      planStore.entries = entries
      planStore.active = typeof res.active === 'string' ? res.active : null
      planStore.routeProvider = typeof res.routeProvider === 'string' ? res.routeProvider : 'openai-codex'
      // 并行拉取额度;整体覆盖 usage 顺带清除已删除账号的残留。
      const usage: Record<string, UsageView> = {}
      await Promise.all(entries.map(async (e) => {
        usage[e.alias] = await call('usage', { alias: e.alias, force: forceUsage }) as unknown as UsageView
      }))
      planStore.usage = usage
    } finally {
      planStore.loading = false
      planLoadInFlight = false
      planNotify()
    }
  }

  /** ctx.modelDirectories 服务的最小契约(ui-model-selection 提供,可选)。 */
  const modelDirs = ctx.get('modelDirectories') as
    | {
        directoryFor(sessionId: string): {
          store: {
            subscribe(fn: () => void): () => void
            getSnapshot(): { current: { provider?: string } | null }
          }
          load(): Promise<unknown>
        }
      }
    | undefined

  /**
   * 门控钩子:仅当当前会话选中的模型 provider 等于插件的路由 provider
   * (planStore.routeProvider,默认 openai-codex)时返回 true。
   * 数据源 = 模型选择器自己订阅的同一份 ModelDirectory store(即时推送)。
   * 兜底:sessionId 缺失 / modelDirectories 不可用 / 会话不可解析 → 返回 true(保持现状始终显示)。
   */
  const usePlanGate = (sessionId: string | undefined): boolean => {
    const [current, setCurrent] = React.useState<{ provider?: string } | null | undefined>(undefined)
    const [fallback, setFallback] = React.useState(false)
    React.useEffect(() => {
      setFallback(false)
      setCurrent(undefined)
      if (sessionId === undefined || modelDirs === undefined) {
        setFallback(true)
        return
      }
      try {
        const directory = modelDirs.directoryFor(sessionId)
        const sync = (): void => setCurrent(directory.store.getSnapshot().current)
        sync()
        const stop = directory.store.subscribe(sync)
        void directory.load().catch(() => undefined)
        return stop
      } catch {
        setFallback(true)
        return undefined
      }
    }, [sessionId])
    if (fallback) return true
    // undefined = 尚未同步;null = 目录未加载(subagent 会话等)→ 隐藏,避免错误闪现。
    if (current === undefined || current === null) return false
    return current.provider === (planStore.routeProvider ?? 'openai-codex')
  }

  /** 输入栏工具行右侧的紧凑 chip:计划 + 可用额度;仅当当前模型走 OpenAI 路由时显示。 */
  function PlanChip(props: { sessionId?: string }): ReactNS.ReactElement | null {
    const store = usePlanStore()
    const visible = usePlanGate(props.sessionId)
    React.useEffect(() => {
      if (!visible) return
      // 可见即刷新一次,之后每 5 分钟自动刷新(无需点击);隐藏时停表。
      void planLoad(false)
      const dispose = timerApi.interval(() => { void planLoad(false) }, AUTO_REFRESH_MS)
      return dispose
    }, [visible])
    if (!visible) return null
    const activeUsage = store.active !== null ? store.usage[store.active] : undefined
    const avail = typeof activeUsage?.usedPercent === 'number' ? Math.round(100 - activeUsage.usedPercent) : undefined
    // 降级显示:账号名称 + 可用额度,次级样式(不喧宾夺主)。
    const label = store.loading && store.entries.length === 0
      ? '…'
      : store.active !== null
        ? store.active + (avail !== undefined ? ` · 可用${avail}%` : '')
        : store.entries.length > 0 ? '查看额度' : 'OpenAI 未配置'
    return React.createElement('button', {
      onClick: (e: ReactNS.MouseEvent<HTMLButtonElement>) => {
        const next = !planStore.open
        if (next) {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          planStore.anchor = { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        }
        planStore.open = next
        planNotify()
        if (next) void planLoad(true)
      },
      title: 'OpenAI 账号额度(点击展开)',
      className: 'dsh-oa-chip',
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 24,
        padding: '0 10px', borderRadius: 10, cursor: 'pointer',
        border: 'none',
        color: activeUsage?.error !== undefined ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
        fontSize: 12, whiteSpace: 'nowrap',
      },
    }, label)
  }

  /** 输入栏浮层:账号快捷查看 + 快速切换;锚定 chip 的 popover,受 provider 门控。 */
  function PlanPopover(props: { sessionId?: string }): ReactNS.ReactElement | null {
    const store = usePlanStore()
    const visible = usePlanGate(props.sessionId)
    React.useEffect(() => {
      if (!visible && store.open) {
        planStore.open = false
        planNotify()
      }
    }, [visible])
    if (!store.open || !visible) return null
    // 菜单项风格:无边框 + hover 底色(注入的 .dsh-oa-btn),对齐原生 Menu item(r8)。
    const chipButton: ReactNS.CSSProperties = {
      background: 'transparent', border: 'none', borderRadius: 8,
      color: 'var(--dsw-alias-label-primary)', fontSize: 12, padding: '3px 10px', cursor: 'pointer',
    }
    const closeBtn: ReactNS.CSSProperties = {
      background: 'transparent', border: 'none', borderRadius: 6,
      color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer', padding: '2px 6px',
    }
    const badge = (plan: string | undefined): ReactNS.ReactElement | null => plan
      ? React.createElement('span', {
          style: {
            fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 8,
            background: 'var(--dsw-alias-interactive-bg-hover)',
            color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
          },
        }, plan.toUpperCase())
      : null
    // 账号行:与设置页同构的简化版 —— 当前账号 = 卡片(额度条就地展开),其余 = 紧凑切换行。
    const rows = store.entries.map((e, idx) => {
      const u = store.usage[e.alias]
      const isActive = e.alias === store.active
      const p = u && typeof u.usedPercent === 'number' ? Math.max(0, Math.min(100, u.usedPercent)) : undefined
      const av = p !== undefined ? 100 - p : undefined
      const over = (p ?? 0) >= 80
      const err = u && u.error ? u.error : undefined
      const resetText = u && u.resetAfterSeconds !== undefined
        ? '距重置 ' + formatDuration(u.resetAfterSeconds)
        : u && u.resetAt !== undefined
          ? '重置 ' + new Date(u.resetAt * 1000).toLocaleString()
          : ''
      const switchButton = (): ReactNS.ReactElement => React.createElement('button', {
        disabled: store.switching !== null,
        onClick: () => { void (async () => {
          planStore.switching = e.alias
          planStore.error = null
          planNotify()
          const res = await call('switch', { alias: e.alias })
          await planLoad(true)
          planStore.switching = null
          if (res.error) planStore.error = res.error
          planNotify()
        })() },
        className: 'dsh-oa-btn',
        style: smallButtonStyle, // 与设置页切换按钮一致
      }, store.switching === e.alias ? '切换中…' : '切换')
      if (isActive) {
        // 当前账号:卡片(底色 + 圆角),别名行 + 额度行(左描述右重置)+ 进度条撑满。
        const quotaBody = err
          ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 10, marginTop: 6 } }, '用量获取失败:' + err)
          : av !== undefined
            ? React.createElement('div', { style: { marginTop: 8 } },
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 } },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden', flexWrap: 'wrap', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } },
                    React.createElement('span', { style: { color: over ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' } }, `可用 ${av}%`),
                    React.createElement('span', { style: { whiteSpace: 'nowrap' } }, `已用 ${p}%`),
                    u && u.limitReached ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '已达上限') : null),
                  resetText
                    ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 10, whiteSpace: 'nowrap' } }, resetText)
                    : null),
                React.createElement('div', {
                  style: {
                    height: 4, borderRadius: 2, overflow: 'hidden', width: '100%',
                    background: 'var(--dsw-alias-interactive-bg-hover)',
                  },
                },
                  React.createElement('div', {
                    style: {
                      width: av + '%', height: '100%',
                      background: over ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
                    },
                  })),
              )
            : React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 10, marginTop: 6 } }, '加载额度…')
        return React.createElement('div', {
          key: e.alias,
          style: {
            borderRadius: 10, padding: '8px 10px', margin: '0 0 6px',
            background: 'var(--dsw-alias-interactive-bg-hover)',
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
              React.createElement('span', {
                style: {
                  color: 'var(--dsw-alias-label-primary)', fontSize: 12, fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
              }, e.alias),
              React.createElement('span', {
                title: '已激活',
                style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)', flexShrink: 0 },
              }),
              badge(u?.planType),
              u && u.email
                ? React.createElement('span', {
                    style: {
                      color: 'var(--dsw-alias-label-tertiary)', fontSize: 10,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    },
                  }, u.email)
                : null),
          ),
          quotaBody,
        )
      }
      // 非激活账号:紧凑行(别名 + 徽章 + 可用% + 切换)。
      return React.createElement('div', {
        key: e.alias,
        style: {
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 2px',
          ...(idx > 0 ? { borderTop: '1px solid var(--dsw-alias-separator-primary)' } : {}),
        },
      },
        React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 } },
          React.createElement('span', {
            style: {
              color: 'var(--dsw-alias-label-primary)', fontSize: 12,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, e.alias),
          badge(u?.planType)),
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 10, whiteSpace: 'nowrap' } },
          err ? '获取失败' : av !== undefined ? `可用 ${av}%` : '加载中…'),
        switchButton(),
      )
    })
    // 锚定 chip:右缘对齐 chip,优先 chip 上方;空间不足(输入栏贴近视口顶部)则下方。
    const panelW = 320
    const anchor = store.anchor
    let pos: ReactNS.CSSProperties
    if (anchor !== null) {
      const gap = 8
      const left = Math.max(8, Math.min(anchor.right - panelW, window.innerWidth - panelW - 8))
      pos = { position: 'fixed', left, top: anchor.top > 420 ? anchor.top - 340 - gap : anchor.bottom + gap }
    } else {
      pos = { position: 'fixed', right: 16, bottom: 150 }
    }
    return React.createElement('div', {
      style: {
        ...pos,
        width: panelW, boxSizing: 'border-box',
        // 对齐原生 Menu 卡片:r12 + inverted hairline + 菜单背景 + shadow-lv3 + 4px 内边距。
        zIndex: 1100, padding: 4, borderRadius: 12,
        maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
        background: 'var(--dsw-specific-menu)',
        border: '1px solid var(--dsw-alias-border-inverted)',
        boxShadow: 'var(--dsw-shadow-lv3)',
        color: 'var(--dsw-alias-label-primary)',
      },
    },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, 'OpenAI 账号'),
        React.createElement('button', {
          onClick: () => { planStore.open = false; planNotify() },
          style: closeBtn,
        }, '✕')),
      rows.length > 0 ? rows : React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, padding: '6px 0' } }, '暂无账号,请到 设置 → OpenAI 账号 添加'),
      store.error ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, marginTop: 6 } }, '操作失败:' + store.error) : null,
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
        React.createElement('button', {
          disabled: store.refreshing,
          onClick: () => { void (async () => {
            planStore.refreshing = true
            planStore.error = null
            planNotify()
            await planLoad(true)
            planStore.refreshing = false
            planNotify()
          })() },
          title: '刷新额度',
          className: 'dsh-oa-btn',
          style: { ...chipButton, padding: '3px 8px', color: 'var(--dsw-alias-label-secondary)' },
        }, iconRefresh(14, store.refreshing)),
        React.createElement('button', {
          onClick: () => {
            planStore.open = false
            planNotify()
            void openSettingsSection()
          },
          title: '打开设置 · OpenAI 账号',
          className: 'dsh-oa-btn',
          style: { ...chipButton, marginLeft: 'auto', padding: '3px 8px', color: 'var(--dsw-alias-label-secondary)' },
        }, iconSettings(14)),
      ),
    )
  }

  slotsApi.inject('conversation.input.right', () => slotsApi.register(
    { name: 'conversation.input.right', id: 'openai-accounts-plan', order: 999, label: 'OpenAI 账号额度' },
    (props) => React.createElement(PlanChip, props),
  ))
  slotsApi.inject('conversation.input.overlay', () => slotsApi.register(
    { name: 'conversation.input.overlay', id: 'openai-accounts-plan-overlay', order: 999, label: 'OpenAI 账号额度详情' },
    (props) => React.createElement(PlanPopover, props),
  ))
}

/** slots 服务的最小契约。 */
interface SlotsLike {
  inject(name: string, register: () => unknown): void
  /** 会话级 slot 的渲染会收到框架标准 props(至少含 sessionId)。 */
  register(entry: unknown, render: (props: { sessionId?: string }) => unknown): unknown
}

/** 'remote' 服务的最小契约($mount 挂载 Remote 贡献)。 */
interface RemoteLike {
  $mount(contribution: unknown): Promise<unknown>
}

/** timer 服务的最小契约。 */
interface TimerLike {
  interval(callback: () => void, delay: number): () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 秒数 → 「X天Y小时」/「Y小时」紧凑倒计时。 */
function formatDuration(seconds: number): string {
  const hours = Math.max(0, Math.round(seconds / 3600))
  if (hours < 24) return hours + '小时'
  const days = Math.floor(hours / 24)
  const rem = hours % 24
  return days + '天' + (rem > 0 ? rem + '小时' : '')
}

/**
 * 一步直达设置页的「OpenAI 账号」分区(设置壳层的 open/active 是组件内
 * 局部 state,无对外服务,这里模拟两次点击;任一环节找不到则静默失败):
 * 1. 若无设置对话框 → 点击文本恰为「设置」/「Settings」的触发按钮;
 * 2. 轮询等待 [role="dialog"] nav 挂载(≤2s),点击文本以「OpenAI 账号」结尾的导航格。
 */
async function openSettingsSection(): Promise<void> {
  try {
    if (document.querySelector('[role="dialog"]') === null) {
      const buttons = Array.from(document.querySelectorAll('button'))
      const trigger = buttons.find((b) => {
        const text = (b.textContent ?? '').trim()
        return text === '设置' || text === 'Settings'
      })
      if (trigger === undefined) return
      ;(trigger as HTMLButtonElement).click()
    }
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const cell = Array.from(document.querySelectorAll('[role="dialog"] nav button'))
        .find((b) => (b.textContent ?? '').endsWith('OpenAI 账号'))
      if (cell !== undefined) {
        ;(cell as HTMLButtonElement).click()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } catch { /* 静默:用户仍可手动打开设置 */ }
}
