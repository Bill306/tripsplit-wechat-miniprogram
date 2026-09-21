# TripSplit 微信小程序

旅行中随手记，结束时不用算。

TripSplit 是一个多人共享旅行账本。成员可以各自记账，查看垫付、应承担和净额，并在行程结束时生成清晰的转账方案。

## 当前功能

- 创建行程和同行成员
- 全员均分、部分人分摊、按份数分摊
- 整数分计算与稳定尾差分配
- 成员垫付、承担、应收/应付统计
- 减少转账次数的结算方案
- `pending → paid → received` 双向确认
- 本地草稿和账单创建幂等
- 微信云函数、成员权限校验和邀请加入链路

## 本地运行

1. 用微信开发者工具打开项目根目录。
2. 未填写 `config/cloud.js` 的 `envId` 时，小程序显式运行在本机演示模式。
3. 演示数据保存在开发者工具的小程序本地存储中。

```bash
npm test
```

## 云开发部署

1. 在微信开发者工具中为 AppID `wx7318f729fe3a3146` 创建云开发环境。
2. 将环境 ID 写入 `config/cloud.js`。
3. 在 `cloudfunctions/api` 上选择“上传并部署：云端安装依赖”。
4. 将云数据库客户端写权限设为禁止；所有写入都经过 `api` 云函数。
5. 用两个微信账号执行 `docs/TEST_PLAN.md` 的真实多人 E2E。

云端使用以下集合：

`users`、`trips`、`members`、`expenses`、`expenseShares`、`settlements`、`settlementTransfers`、`auditLogs`、`invites`。

## 文档

- `docs/PRD.md`
- `docs/TECHNICAL_DESIGN.md`
- `docs/UI_SPEC.md`
- `docs/TEST_PLAN.md`

## 隐私

`project.private.config.json`、本机缓存、CSV 用户数据和云环境密钥不会提交到 Git。
