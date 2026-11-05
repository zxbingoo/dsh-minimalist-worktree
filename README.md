# dsh-minimalist-worktree

为 DeepSeek Harness 的**新会话**增加两个紧凑选择器，参考 Paseo 的交互：

- **本地 / 新建 worktree**
- **起始分支**，支持搜索本地和已存在的远程跟踪分支

不增加管理页面。仅在会话尚未发送消息且工作区属于 Git 仓库时显示，支持中文、英文及 DSH 主题。非 Git 工作区默认使用本地目录，不展示这两个下拉框；检测完成前也不闪现选择器。权限或 Git 读取错误不会被误判为“非 Git”。

## 使用

1. 在新会话选择 Git 工作目录。
2. 默认「本地」：沿用当前目录，不切换源仓库分支。
3. 选择「新建 worktree」，再选择起始分支，等待选择保存完成后发送消息。
4. 宿主会在首个模型步骤之前创建独立分支和检出目录，并将本会话切换过去。

默认位置为仓库根目录下的 `.agents/worktrees/worktree-<uuid>`，分支同名。起始提交在保存选择时固定；不会自动 fetch。未提交改动保留在源目录，不复制到新 worktree；不会安装依赖或初始化子模块。

创建遵守会话原有的文件和沙箱策略，复用 DSH 自带的安全 worktree 服务，不修改源仓库的 HEAD。创建失败会中止模型步骤，不会自动重试、删除文件或退回本地运行。失败或中断可能留下检出目录/分支，请检查后自行处理；重新开始新会话再选择。

工作目录改变后需要重新选择。现有、派生或已经开始的会话不能补选，以免改变正在执行的任务。

## 安装与构建

当前适配 **DSH 0.2.1-rc.5**。目录安装通过 DSH Plugin Manager 完成，不需要修改用户配置文件：

```json
{ "action": "install_bundle", "target": "/absolute/path/to/dsh-minimalist-worktree" }
```

本地开发使用 Node 24+：

```sh
pnpm install --ignore-scripts
node build.mjs
node --test test/*.test.mjs
```

`client.js` 是生成的浏览器模块；修改 `src/client.js` 或语言资源后需重新构建。更改已安装插件代码后可能需要重启 DSH 才加载新的模块，不能仅凭同名插槽推断代码已更新。

## 结构与验证范围

- `index.js`：Host 服务、严格 RPC、生命周期和代理工具
- `core.js`：按会话串行的持久选择、固定提交、一次性准备
- `git.js`：受限时长/输出、无 shell 的只读 Git 元数据查询
- `src/client.js`：新会话的两个选择器
- `test/`：状态机单元测试及真实临时 Git 仓库测试

UI 和代理的 `dsh_worktree` 工具共享同一 `operate` 操作，动作只有 `inspect` 和 `select`；指定其他会话时目标必须是打开且未开始的会话。操作失败会返回原因，`select` 不会立即分配 worktree。

测试不会操作用户仓库。自动测试不等同于已在真实页面完成点击、浅深色或图标渲染验收；实际安装/页面验证结果以交付说明为准。

## 许可

MIT。随包 SVG 图标为本项目原创，可按相同许可使用。与 Paseo 无代码或资源依赖关系。
