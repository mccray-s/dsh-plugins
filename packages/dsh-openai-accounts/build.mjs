/**
 * dsh-openai-accounts 构建脚本(零仓库耦合):
 *   1. tsc 编译 src/** → build/(ESM)
 *   2. esbuild 打包 build/client.js(+ 内联 descriptors)→ build/client.bundle.cjs(仅 external: react)
 *   3. 包装 client bundle 为 __ModuleLoader__.load 闭包 → lib/client.js
 *   4. 组装 lib/:index.js(host)、typert.js(+descriptors.js)、client.js
 *
 * 依赖:包内 devDependencies(typescript / esbuild / @types/react,均来自公共 npm),
 * 首次使用先 `npm install`。
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const BIN = join(ROOT, 'node_modules', '.bin')
const BUILD = join(ROOT, 'build')
const LIB = join(ROOT, 'lib')

function run(bin, args) {
  execFileSync(join(BIN, bin), args, { stdio: 'inherit' })
}

// 1. tsc:src → build/
run('tsc', ['-p', join(ROOT, 'tsconfig.json')])

// 2. esbuild:client + 内联 descriptors(仅 react 走模块表 require)
run('esbuild', [
  join(BUILD, 'client.js'),
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--external:react',
  '--outfile=' + join(BUILD, 'client.bundle.cjs'),
])

// 3. 包装闭包(与仓库 clientBundle 的 banner/footer 格式一致)
const bundle = readFileSync(join(BUILD, 'client.bundle.cjs'), 'utf8')
const wrapped = [
  "window.__ModuleLoader__.load({ id: 'dsh-openai-accounts', factory: (require) => {",
  'var module = { exports: {} }; var exports = module.exports;',
  bundle,
  'return module.exports; } });',
].join('\n')

// 4. 组装 lib/
rmSync(LIB, { recursive: true, force: true })
mkdirSync(LIB, { recursive: true })
copyFileSync(join(BUILD, 'host.js'), join(LIB, 'index.js'))
copyFileSync(join(BUILD, 'oauth.js'), join(LIB, 'oauth.js'))
copyFileSync(join(BUILD, 'typert.js'), join(LIB, 'typert.js'))
copyFileSync(join(BUILD, 'descriptors.js'), join(LIB, 'descriptors.js'))
writeFileSync(join(LIB, 'client.js'), wrapped)

console.log('[dsh-openai-accounts] build ok → lib/{index,oauth,typert,descriptors,client}.js')
