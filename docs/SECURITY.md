# 安全说明

## 当前边界

- 云数据库客户端写权限必须关闭；所有写操作仅通过 `api` 云函数。
- 云函数使用微信 `OPENID` 识别用户，并在服务端校验行程成员、创建者和账单操作权限。
- 金额只使用整数分计算；账单修改使用修订号防止旧页面覆盖新数据。
- 邀请有效期、次数上限、成员上限在事务内再次校验，避免并发超额加入。
- 用户数据文件、私有项目配置和云环境 ID 不提交到 Git。

## 依赖审计

云函数固定使用微信官方 npm 包 `wx-server-sdk@4.0.2`，并提交 lockfile。2026-09-21 使用官方 npm registry 执行审计时，报告 6 个传递依赖问题（1 个 moderate、5 个 high），来自 SDK 依赖树中的 `axios`、`lodash.set` 和 `lodash.unset`。npm 给出的自动修复会降级到 `2.5.3`，实测反而增加到 16 个问题（含 critical），因此不采用降级方案。

这些是上游 SDK 的残留风险，当前版本不能标记为“零漏洞”。本项目不接收用户提供的外部 URL，也不通过该 SDK 发起任意外部 HTTP 请求；云函数输入采用白名单动作、长度限制、成员权限和事务校验，以缩小暴露面。微信发布前应重新执行：

```bash
cd cloudfunctions/api
npm install --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org
npm audit --registry=https://registry.npmjs.org
```

若微信发布了修复版 SDK，应先在独立分支升级并完成双账号端到端回归，再部署生产环境。
