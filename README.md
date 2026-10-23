# 喵喵旅账微信小程序

旅行中随手记，结束时不用算。

喵喵旅账是一个多人共享旅行账本。成员可以各自记账，查看垫付、应承担和净额，并在行程结束时生成清晰的转账方案。

## 当前功能

- 创建行程和同行成员
- 全员均分、部分人分摊、按份数分摊
- 整数最小货币单位计算与稳定尾差分配
- 12 种货币：行程结算币种、原币金额、自动参考汇率 / 手动汇率 / 实际扣款
- 自动汇率使用 Frankfurter / ECB 每日参考数据；账单保存后冻结，不随行情变化
- 成员垫付、承担、应收/应付统计
- 减少转账次数的结算方案
- `pending → paid → received` 双向确认
- 未付款结算自动失效并重算；已付款后锁定账本
- 账单变更记录、成员停用/移除、创建者转让
- 7 天邀请、加入预览和邀请撤销
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

1. 在微信开发者工具中为 AppID `wxfe93f715e384ba46` 创建云开发环境。
2. 将环境 ID 写入 `config/cloud.js`。
3. 在 `cloudfunctions/api` 上选择“上传并部署：云端安装依赖”。
4. 将云数据库客户端写权限设为禁止；所有写入都经过 `api` 云函数。
5. 用两个微信账号执行 `docs/TEST_PLAN.md` 的真实多人 E2E。

云端使用以下集合：

`users`、`trips`、`members`、`expenses`、`expenseShares`、`settlements`、`settlementTransfers`、`auditLogs`、`invites`、`fxQuotes`。

`fxQuotes` 与其他集合一样禁止客户端直接读写。自动汇率只由云函数查询，不传送账单、成员或身份信息；本地演示模式支持手动汇率与实际扣款，不联网取价。接口不可用时明确提示，不按 1:1 静默换算。详情见多币种设计文档。

## 文档

- `docs/PRD.md`
- `docs/TECHNICAL_DESIGN.md`
- `docs/UI_SPEC.md`
- `docs/TEST_PLAN.md`
- `docs/CLOUD_SETUP.md`
- `docs/SECURITY.md`
- `docs/MULTICURRENCY_DESIGN.md`

## 隐私

`project.private.config.json`、本机缓存、CSV 用户数据和云环境密钥不会提交到 Git。
