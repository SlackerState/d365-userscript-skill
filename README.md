# d365-userscript

一个 [Claude Code](https://claude.com/claude-code) skill，记录制作 D365（Dynamics 365 / Dataverse）页面用户脚本的完整方法：只读调查、写脚本、在真实页面验证、发布在线更新。

## 内容

| 文件 | 说明 |
|---|---|
| `SKILL.md` | 主流程 |
| `references/recon.md` | 调查实体、视图、按钮源码的代码片段，以及把脚本注入页面测试的办法 |
| `references/pitfalls.md` | 开发中实际遇到的问题和做法 |
| `references/domain-template.md` | 记录组织内已查实结构的模板 |
| `assets/template.user.js` | 新脚本模板：批量读取、分类预览、确认后写入、出错即停 |

## 安装

```bash
git clone git@github.com:SlackerState/d365-userscript-skill.git /tmp/d365-userscript-skill
```

```bash
cp -R /tmp/d365-userscript-skill/d365-userscript ~/.claude/skills/
```

之后在 Claude Code 里提出 D365 脚本相关的需求时，它会自动启用，也可以用 `/d365-userscript` 直接调用。

## 注意

脚本操作的是真实业务数据。模板默认第一次只处理一张单，并在写入前逐张确认，建议保留这些保护。
