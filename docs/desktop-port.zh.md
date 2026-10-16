# 桌面端分支 —— DeepSeek Harness `0.2.0-rc.2`

> English: [docs/desktop-port.md](desktop-port.md)（**权威版本**，改动清单与验证证据以英文版为准）

这是 [PerryLink/dsh-auto-review](https://github.com/PerryLink/dsh-auto-review) 的 **fork 的 `desktop` 分支**，把这个插件移植到 DeepSeek Harness **桌面端运行时 `0.2.0-rc.2`**（即 `@deepseek-ai/dsh` 当前的 `latest`），并修掉了移植过程中发现的一批缺陷。上游 `main` 面向的是 `0.2.1-alpha.1` 那条线。

本文只讲**分支自己改了什么**；插件本身的设计与配置项请看上游的 README。

---

## 一、不要从 npm 装这个

`npm i dsh-auto-review` 装到的是**上游 `0.12.17`**，它的 `dependencies` 会拖进 `0.2.1-alpha.1` 的 harness 依赖树。把这样的包装进 `0.2.0-rc.2` 的 profile，**那棵树会被提升（hoist）到 profile 自己的 `node_modules`**，而 `dsh-app-boot` 优先解析 profile 的 `node_modules` —— 于是真正启动的宿主不是你装的那个，结果是**开机崩溃**。

本分支不是"把版本号钉住绕开它"，而是**把这个失效机制直接移除**：`dependencies` 里**不再有任何 `@deepseek-ai/*` 包**。`test/desktop-port.spec.ts` 里有一条测试，一旦有人加回来就会失败。

---

## 二、安装

### 方案 A —— vendor + `link:`（本分支实际开发与验证所依据的方式）

```powershell
$plugins = "$env:USERPROFILE\.dsh\profiles\desktop\plugins"
git clone --branch desktop https://github.com/renleihaokun/dsh-auto-review.git "$plugins\dsh-auto-review"
cd "$plugins\dsh-auto-review"
pnpm install --ignore-scripts
pnpm run build
```

然后在 `~/.dsh/profiles/desktop/package.json` 里：

```json
{
  "dependencies": { "dsh-auto-review": "link:./plugins/dsh-auto-review" },
  "dsh": { "profile": { "bundles": ["dsh-auto-review"] } }
}
```

`link:` 安装**不会安装被链接包的依赖**，这正是它不可能遮住宿主运行时的原因。profile 加载的是你自己 `pnpm run build` 出来的 `lib/`。

### 方案 B —— `dsh` 插件的 git 通道

```powershell
dsh plugin --profile desktop add github:renleihaokun/dsh-auto-review#desktop
```

> **本分支未验证此路径。** git 通道会在隔离环境里装依赖并执行包的 `prepare` 脚本，也就是会产生第一节那个提升行为的代码路径。本分支已经没有可提升的 `@deepseek-ai/*` 运行时依赖，机制上不复存在——但有实测证据支撑的是方案 A。

### 必须补的 profile patch —— 权限档位

自动审查**只在会话的权限档位是 `review` 时才启用**。这个档位必须由 profile 提供，而插件**故意不默认下发**它：`permission` 这一行是**整行替换**配置的，已经在自定义档位的 profile 会因此出现两行同 id。

把下面这段加进你的 **profile** patch 层（`~/.dsh/profiles/desktop/cordis.patch.yml`），并**把你原本的档位一并重述**：

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
      review: { sandbox: workspace-write, approval: ask }
```

然后在权限下拉里选 **AI 审查**，或在运行中的会话里执行 `/permission review`。不加这段的话插件是「挂载了但空转」——永远是 fail-closed，不会 fail-open。

插件自带的 `cordis.patch.yml` 里有一段同样的注释块，就在可选 `invariant` 行旁边。

### Windows + pnpm 注意事项（只影响构建/测试）

pnpm 默认的**隔离** `node_modules` 布局在 Windows 上会创建 **junction**，随之有两件事会坏，且都在本插件之外：

1. **TypeScript 7 的原生编译器找不到自己。** `typescript` 的 `lib/tsc.js` 用 `import.meta.resolve("@typescript/typescript-win32-x64/package.json")` 定位平台包；经 junction 路径启动时，Node 保留 junction 路径，向上逐级找 `node_modules` 永远到不了 `.pnpm/typescript@…/node_modules`，于是抛 *"Unable to resolve @typescript/typescript-win32-x64"*。
2. **Vite/vitest 解析不到自己的部分依赖** —— 同一机制：经 junction 路径加载的模块，找不到只存在于 `.pnpm/` 下的依赖。

两者都不是本分支引入的，也不影响 Linux CI。这里的做法是改用**扁平（hoisted）布局**，也就是 `npm install` 的产物：

```powershell
pnpm install --ignore-scripts --config.node-linker=hoisted
```

`--ignore-scripts` 跳过 `node-pty` / `koffi` 的原生 postinstall；它们只有 `eval` 面需要，`typecheck` / `test` / `build` 都不需要。

---

## 三、改了什么

### 3.1 源码回植（本分支的主要工作）

上游的 npm 包里**自带 `src/**`**，但插件真正加载的是 `lib/` 下的**打包产物**，而 `lib/` 不被 git 跟踪。最初的移植是**直接改在 `lib/index.js` 上**的——能跑，但无法评审、无法类型检查、无法测试。

本分支把这批补丁**全部重新表达为 TypeScript 源码**，涉及 8 个文件：

| 文件 | 改动 |
|---|---|
| `src/runtime.ts` | `PRESET_GATE`；档位门禁（`presetGateState` / `effectiveEnabled`）；`/auto-review on` 的拒绝；面板实时视图（`livePanelView` / `sessionById`）；进程级累计计数（`MemoryTally` / `tallies` / `tallyFor` / `MEMORY_RECENT_CAP`）及其在裁决/拒绝/失败路径上的更新。 |
| `src/review.ts` | `redactInlineSecrets`（F3a）及接入 `sanitizeArguments`（F3b）与转录行 `contextLine`（F3c）；`renderCallContext` 的截断披露（F4a）；`buildReviewPrompt` 中配套的拒绝规则（F4b）。 |
| `src/projection.ts` | 持久化 state schema 加 `sessionId`、`initAutoReviewProjection(enableByDefault, sessionId)`、可选 `liveView`、`stateVersion: 4`。 |
| `src/projection-types.ts` | `AutoReviewProjectionState.sessionId` —— bundle 级补丁带不上的配套类型。 |
| `src/messages.ts` | `presetGated` 的 `en`/`zh` 文案，以及两处 `description` 措辞纠正。 |
| `src/index.ts` | 导出 `PRESET_GATE`。 |
| `src/cache.ts`、`src/config.ts` | 措辞：审查方不是"第二模型"。 |
| `test/*` | `projection.spec.ts` / `command.spec.ts` 跟进 v4 契约与新措辞；`desktop-port.spec.ts` 为新增。 |

`src/eval/**` **刻意不动**：那里的 "second-model review" 是 `dsh-eval` 评测引擎**另一个真实功能**（可用 `--review-model` 配置），确实是第二个模型。

### 3.2 配置与元数据

- **`dependencies` 只剩 `tsdown` / `typescript` / `yaml` / `zod`。** 上游放在这里的 14 个 `@deepseek-ai/dsh-*`（为了让 `dsh-eval` 开箱可用）全部移入 `devDependencies`。**代价说清楚：本分支的 `dsh-eval` / `./eval` 面不再为使用者安装。** 这是"移除崩溃机制"而非"钉住版本绕开"的必然取舍。`tsdown`/`typescript`/`zod`/`yaml` 留在 `dependencies`，因为 git 通道的隔离 `prepare` 环境没有 devDependencies。
- **`peerDependencies`** 从六段 `||` 并集收敛为 `>=0.2.0-rc.2 <0.3.0`，`@deepseek-ai/cordis ^4.0.4`、`@deepseek-ai/schemastery ^3.18.4`，`engines.dsh` 同步。只测过 `0.2.0-rc.2` 却在分支上宣称支持 `0.1.x`，那是没有证据的承诺。
- **`@deepseek-ai/dsh-api-remotes`** 加入 `dsh.client.inject`（取代 `@deepseek-ai/dsh-client-ui-slots`，后者的类型仍被 `src/client/index.ts` 引用），并声明为**可选 peer** —— 该注入表里其它名字本来就都是可选 peer。
- **`pnpm-workspace.yaml`** 把整个 `@deepseek-ai/dsh-*` 图钉到 `0.2.0-rc.2`。这张图只用于构建/测试，不会进入任何使用者 profile。
- **`cordis.patch.yml`** 行 id 用 `perrylink-auto-review`（桌面端 profile 内置的实验版 auto-review 已经插入了 `id: auto-review`，两个 insert 不能同 id）；`toolsPolicy.overrides` **同时**覆盖 `bash` 与 `pwsh`，一份 patch 在两种 shell 环境都可用；并设置 `reviewerProvider: spawn` 与 `fallbackPolicy: delegate`。
- 版本号 `0.12.17-desktop.1`，`package.json#desktopBranch` 记录来源。

### 3.3 与上游的有意分歧

1. **"第二模型" → "同模型独立"。** 审查方跑在 `spawn` 上：一个**完全不继承**请求会话轮次的全新子代理。它是同一个模型在独立读证据。上游 schema 默认是 `fork`，会把审查方直接种在**它正在审判的那些轮次**之上——本分支在自带 patch 里显式设为 `spawn`。
2. **`/auto-review on` 的拒绝文案已本地化。** bundle 级补丁把中文串**硬编码在调用点**。现在它归位到 `en`/`zh` 消息表（`presetGated`）；**中文输出逐字节相同**，而英文用户拿到的是英文而不是中文。
3. 截断披露里的 `<n>` 与 prompt 中的拒绝规则是新增的 —— bundle 级补丁只有披露、没有规则，而让披露**可执行**的正是那条规则。
4. 纯装饰性：`PRESET_GATE` 从 bundle 前导移入 `src/runtime.ts`；魔术数 `10` 变成 `MEMORY_RECENT_CAP`；若干文档注释得到纠正（例如 `buildContextSection` 原本写着工具调用参数"原样"进入转录——F3c 之后这句话就不成立了）。

---

## 四、修掉的四个缺陷

四个都是复核移植时发现的，每一个都能被 `test/desktop-port.spec.ts` 复现。

### F1 —— 档位读取失败会**重新打开**已关闭的门（fail-**open**）

权限档位服务抛异常时，`presetGateState` 返回 `{ mounted: false, on: false }`。而 `effectiveEnabled` 把 `mounted: false` 理解为"这个 profile 没有档位服务"，于是**回落到粘性会话开关**——结果一个过期的内存 `true`，或日志里一条 `autoReview/state { enabled: true }`，就能在档位**已经读不出来之后**继续让 answerer 认领请求。现在读失败报 `{ mounted: true, on: false }`，门保持关闭。两种状态是**刻意不合并**的，代码里写了原因。

### F2 —— `/auto-review on` 写入了一个 answerer 根本不看的覆盖

档位未选中时，命令仍然追加了持久的 `autoReview/state { enabled: true }`。answerer 忽略它（档位优先于开关），但命令自己每次都把它读回来，于是在本会话剩下的时间里一直回你 *"已经是 ON"*。现在它直接拒绝并给出补救方式（`/permission review`），且**什么都不写**。

### F3 —— 自由字符串参数里的密钥**原样**送到审查方面前

基于 key 的脱敏只检查对象的**键**，所以命令行字符串对它是隐形的：

```
deploy --token sk-live-123            →  deploy --token [REDACTED]
--api-key=ak-9                         →  --api-key=[REDACTED]
API_SECRET="s3cr3t"                    →  API_SECRET="[REDACTED]"
curl -H "Authorization: Bearer tok-42" →  curl -H "Authorization: Bearer [REDACTED]"
```

**两条渲染路径都已覆盖**：待决调用自身的预览走 `sanitizeArguments`，紧凑转录行走 `contextLine`——而**转录行才是把密钥原样送到审查方面前的那条路径**。**已知局限（有测试钉住）**：旁边没有键名的裸密钥（`echo sk-live-123`）仍然可见。这是启发式，不是密钥扫描器。

### F4 —— 被截断的证据会被当成完整证据

待决调用的预览会在 `reasonMaxChars`（默认 2000）处被 `…` 截断。审查方只看到长命令无害的开头时，可能放行一个关键参数已被切掉的操作。现在截断会被标注并计数：

```
Tool call arguments (sensitive values redacted, TRUNCATED):
…
[TRUNCATED EVIDENCE: only the first 2000 of 5496 characters are shown; the remainder is
NOT visible to you. An action you cannot see in full is insufficient evidence — the verdict
rules require DENY on insufficient evidence. Deny unless the visible part alone proves the
action safe.]
```

并且裁决规则里增加了 `- truncated evidence counts as insufficient: when the arguments are marked TRUNCATED, DENY.`

### 另外修掉的 —— 面板全是 0

`autoReview` 面板投影折叠的是插件自己的 `autoReview/*` 会话事件。而在拒绝未标记未知事件类型的宿主上（`auditMayAppend()` 为 false，`0.2.0-rc.2` 正是如此），**这些事件一条都不会被写入**，于是面板在一个空日志上做折叠。现在持久化 state 带上所属 `sessionId`（state version 4），运行时替换成一个实时视图，从内存镜像里给出开关状态与本会话真实活动；在会标记的宿主上仍是纯折叠说了算，原样返回。

---

## 五、验证

### 仓库自身的门禁

| 检查 | 结果 |
|---|---|
| `pnpm run typecheck`（`tsconfig.json` + `tsconfig.test.json`） | **通过** |
| `pnpm test` | **27 个文件 / 318 个用例全部通过** |
| `pnpm run build` | **通过** —— `lib/index.js`、`lib/invariant.js`、`lib/client.js`、`lib/eval*.js`、`lib/types/**` |
| `pnpm run verify:self-contained` | **通过** |
| `pnpm run check:lockfile` | **通过** |
| `pnpm run check:readmes` | **通过**（5 份 README，24 段，23 个配置键） |

`test/desktop-port.spec.ts` 新增 15 个用例：两条路径的内联密钥脱敏、裸密钥局限、截断披露及其反例、prompt 规则、五个档位门禁用例（门开、档位压过 `enableByDefault`、**读失败即失败关闭**、`/auto-review on` 拒绝、无档位服务时回落）、三个依赖策略用例。

### 源码 ≡ 已验证产物

重新做源码级移植，最要紧的问题是：**源码是否真的复现了被验证过的行为**。答案是把分支构建出来，与已经线上实测过的 bundle 对拍。

构建产物带 `//#region` 横幅，标明每个片段来自哪个模块，所以每个 hunk 都能归属到源文件。把横幅里 pnpm 隔离布局的路径前缀归一化（扁平布局造成的唯一差别）之后，就能逐行比较：

- **对发布版 `0.12.17`**：40 个 hunk、+264/−22，跨 6 个源文件，**内联的 `zod` 里零 hunk**。
- **对线上已验证的 bundle**：22 个 hunk、+142/−74。**逐个审计过**：文档扩写、格式化（对象字面量换行、`sessionId` 在 schema 中的位置）、`PRESET_GATE` 的移位与导出、`MEMORY_RECENT_CAP` 常量、语义等价的 `init` 写法、以及有意为之的档位拒绝文案本地化（中文逐字节相同）。**没有发现任何非有意的行为差异。**

### 线上实测证据（在 bundle 级移植上采集；上面的对比证明本源码复现了它）

在参照的 `0.2.0-rc.2` 桌面 profile 上，选中 `review` 档位：

- 十余次升级请求由审查方裁决：除拒绝外全部是 `allowed-once`，且每次都给出具体理由。
- 两次真实拒绝，理由都正确：一次参数预览超过上限被以 TRUNCATED 标记为由拒绝（"*截断的证据不足以作为证据*"），而另一次完整、小、可逆的写入被放行，理由里**明确写出**其参数**没有**被截断。门禁在辨别，不是在盖章。
- 面板已在真实会话上确认：开关状态真实、累计计数真实、四条最近裁决、以及可用的批准重试。
- 转录脱敏（F3c）是从一个真实审查子代理的提示里读回来确认的：先前那条 5496 字符的调用渲染为 `--token [REDACTED]`，伪造令牌在全提示中**一次都没出现**。
- 会话日志卫生成立：**零**条真实 `autoReview/*` 事件被写入会话日志——这正是该宿主线上记录的降级行为。
- 针对 profile 的 13 项回滚/校验脚本 13/13 通过。

---

## 六、已知局限

- **风险阀门是死的。** `riskPolicy.maxAutoAllow` 是 `'high'`，而裁决 schema 里 `riskLevel` 可选，所以 `riskExceeds` 永远不可能为真。此处未改动，配置面沿用上游。
- **审查方预览上限 2000 字符**（`reasonMaxChars`）。F4 让截断变得可见且可拒绝，但上限本身未变。
- **转录里的工具**结果**文本未脱敏**（只脱敏工具调用参数）。结果是已经呈现过的内容，整体脱敏会破坏裁决所依赖的证据。
- **审查不是模型多样的。** `spawn` 去掉的是共享上下文，不是共享模型：同一路由上的审查方与请求方有同样的盲区。用 `reviewerModel` 把它指到别处。
- **面板的每会话计数在内存里**，harness 重启即归零。在审计信封可用的宿主上，由持久化折叠说话。
- **`eval` 面不为使用者安装**（见 3.2）。需要 `dsh-eval` 就从 `devDependencies` 装。
- **Windows + pnpm 隔离布局**需要扁平方案才能跑 `typecheck`/`test`（见第二节）。

---

## 七、升级与许可

本分支只跟一条运行时线。`@deepseek-ai/dsh` 前进时，要动的是 `engines.dsh`、`peerDependencies` 区间、`devDependencies`，以及 `pnpm-workspace.yaml` 里的 `overrides` 表——然后重跑第五节的整套门禁。五份 README 是上游的、描述的是上游的兼容性；本分支的事实来源是 `package.json#desktopBranch` 和本文档。

上游是 Apache-2.0。本分支保留 `LICENSE` 与原始 `author` 字段不变，在 `contributors` 里记录自己，并在此处与 `CHANGELOG.md` 里声明改动，符合许可证要求。本分支**与 PerryLink 无从属关系、也未获其背书**；README 里的徽章与链接仍指向上游项目——插件的文档、issue 与发布都在那里。
