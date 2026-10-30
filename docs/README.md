# Documentation / 文档导航

[English home](../README.md) · [中文首页](../README_CN.md)

Start with the README to install and pair. Choose a guide below for detailed usage. Each topic has an English and Chinese edition.

先在 README 完成安装与配对，再按任务查看专题文档。各专题提供中英文版本。

| Topic / 主题 | English | 中文 |
| --- | --- | --- |
| All commands, tab groups, input, DOM, capture, CDP / 命令与页面操作 | [Commands](commands.md) | [命令参考](commands_CN.md) |
| Live viewers, input and streaming / 实时远控 | [Tab sharing](tab-sharing.md) | [实时远控](tab-sharing_CN.md) |
| Pairing, multi-browser, remote setup, permissions, errors / 部署与排错 | [Deployment](deployment.md) | [部署与排错](deployment_CN.md) |
| Architecture, tests, CI, npm and store releases / 开发与发布 | [Development](development.md) | [开发与发布](development_CN.md) |

## Repository references / 仓库参考

- [Privacy policy / 隐私政策](../PRIVACY.md)
- [Contributor and agent instructions / 开发约定](../CLAUDE.md)
- [Browser control skill / 浏览器控制技能](../skills/browser-bridge-cli/SKILL.md)
- [Workflow skill generator / 工作流技能生成器](../skills/browser-bridge-cli-skill-generator/SKILL.md)
- [Linux.do reader example / Linux.do 阅读技能示例](../skills/linuxdo-comment-reader/SKILL.md)

## Documentation layout / 维护约定

- README: installation, feature overview and guide links. / 首页只保留安装、功能总览与文档入口。
- Topic guides: runnable examples and behavior limits. / 专题负责可执行示例与行为边界。
- CLI `--help`: complete option names and defaults. / 完整参数名与默认值以 CLI 帮助为准。
- Skills: self-contained agent workflows; contributor instructions: repository rules. / 技能保持可独立安装，开发约定集中在 CLAUDE.md。
- Keep paired English/Chinese guides and relative links in sync when changing features. / 功能变化时同步中英文专题及相对链接。
