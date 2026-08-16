/**
 * dsh-openai-accounts — Typert Host 描述符。
 *
 * 由 typert-loader 从 loader 条目自动发现(包导出 ./typert),注册进 typert 注册表,
 * api-gateway 据此把 Remote 调用路由到 `openaiAccounts` 服务。
 */

import { INVOCATIONS } from './descriptors.js'

export const TYPERT = {
  package: 'dsh-openai-accounts',
  face: 'host',
  schemas: [],
  invocations: INVOCATIONS,
  model: { services: [], events: [], objects: [] },
}
