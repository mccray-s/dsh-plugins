/**
 * Remote 描述符 — Host(typert.js)与 Client(client bundle)共用同一构造。
 *
 * 注意:构建后,typert.ts 与 client.ts 分别打包/拷贝各自的 descriptors.js 副本:
 * - lib/typert.js 以 ESM import 方式引用 lib/descriptors.js(Node 侧);
 * - lib/client.js 由 esbuild 内联该模块(浏览器侧必须自包含)。
 */

/** 宽松 schema:通过 typert-loader 的 zod v4 形状检查,parse 恒等返回(调用双方都由本插件控制)。 */
export interface LaxSchema {
  _zod: { type: string }
  parse(value: unknown): unknown
}

export function laxSchema(): LaxSchema {
  return { _zod: { type: 'object' }, parse: (value) => value }
}

/** 单个 JSON 参数的描述符(wire 名 = 参数名 = 'args',客户端传一个位置参数)。 */
export interface InvocationParameterDescriptor {
  name: string
  wire: string
  source: 'json'
  codec: { mode: 'strict'; typeSymbol: string; schema: LaxSchema }
}

/** 一个直接调用的 Remote 方法描述符。 */
export interface InvocationDescriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: InvocationParameterDescriptor[]
  result: { mode: 'strict'; typeSymbol: string; schema: LaxSchema }
}

const RESULT = {
  mode: 'strict',
  typeSymbol: 'dsh-openai-accounts#OpenAiAccountsState',
  schema: laxSchema(),
} as const

export type AccountMethod = 'list' | 'switch' | 'delete' | 'loginStart' | 'loginStatus' | 'loginCancel' | 'usage'

function jsonArg(): InvocationParameterDescriptor {
  return {
    name: 'args',
    wire: 'args',
    source: 'json',
    codec: { mode: 'strict', typeSymbol: 'dsh-openai-accounts#args', schema: laxSchema() },
  }
}

function invocation(method: AccountMethod): InvocationDescriptor {
  return {
    id: 'dsh-openai-accounts#openaiAccounts/' + method,
    service: 'openaiAccounts',
    namespace: 'openaiAccounts',
    method,
    invocation: { kind: 'direct' },
    parameters: method === 'list' || method === 'loginStatus' || method === 'loginCancel' ? [] : [jsonArg()],
    result: RESULT,
  }
}

export const INVOCATIONS: readonly InvocationDescriptor[] = [
  invocation('list'),
  invocation('switch'),
  // 注意:wire 方法名不能与 RemoteNamespaceService 的保留成员冲突
  // (如 remove —— 网关客户端命名空间服务自带 remove 方法),否则 $mount 拒绝。
  invocation('delete'),
  invocation('loginStart'),
  invocation('loginStatus'),
  invocation('loginCancel'),
  invocation('usage'),
]
