# dsh-plugins

> ⚠️ **个人自用仓库**:本仓库为作者个人使用的 DSH 插件集合,非官方项目,不承诺
> 持续维护或接口稳定。使用前请自行阅读源码。

DSH(DeepSeek Harness)插件集合 — pnpm workspace monorepo。

## 包列表

| 包 | 说明 |
| --- | --- |
| [dsh-openai-accounts](packages/dsh-openai-accounts/README.md) | ChatGPT 订阅多账号管理插件(登录 / 切换 / 额度)— [npm](https://www.npmjs.com/package/dsh-openai-accounts) |

## 结构

```
dsh-plugins/
├── package.json          # workspace 根(统一脚本:pnpm build / pnpm check)
├── pnpm-workspace.yaml   # packages/*
└── packages/
    └── dsh-openai-accounts/   # 独立插件包(独立 package.json + cordis.patch.yml + 独立发布)
```

## 开发

```sh
pnpm install                # 安装全部包依赖
pnpm -r build               # 构建全部包
pnpm -r check               # 语法检查全部包
```

## 发布

每个包独立发布到 npm(已发布:[dsh-openai-accounts](https://www.npmjs.com/package/dsh-openai-accounts)):

```sh
cd packages/dsh-openai-accounts
npm publish
```

> 提示:本机 npm 全局缓存有 root 权限问题,所有 npm 命令建议带
> `--cache "$PWD/.npm-cache"`(包内已建本地缓存目录)。

仓库 GitHub Topics:`dsh-plugin`、`deepseek-harness`、`dsh`。
