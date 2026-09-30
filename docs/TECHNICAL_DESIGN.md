# 喵喵旅账 MVP 技术设计

日期：2026-09-21
状态：Approved for implementation
依据：`docs/PRD.md`

## 1. 目标

交付一个真实可多人使用的微信小程序 MVP：行程成员共享同一本账，使用整数分记账和分摊，生成可确认的结算方案。

## 2. 架构

```text
微信小程序页面
  │
  ├─ view-model：表单、加载态、错误恢复
  │
  ├─ services/repository.js：统一数据访问接口
  │      ├─ cloudRepository：真实多人协作
  │      └─ demoRepository：未配置云环境时的本地 UI 验证
  │
  ├─ domain：金额、分摊、统计、结算纯函数
  │
  └─ wx.cloud.callFunction
          │
          ├─ login / trip / invite / expense / settlement
          └─ 云数据库（客户端禁止直接写）
```

核心原则：

- 金额全程用整数分，不使用浮点数存储或结算。
- 分摊、统计和结算保持无副作用，可在 Node 中单元测试。
- 所有授权、去重、版本冲突和结算状态转换在云函数中校验。
- 页面不依赖具体存储实现，本地演示与云端共用同一接口。
- 演示模式会显示明确标识，不得冒充多人云端验收。

## 3. 页面与路由

| 路由 | 职责 |
| --- | --- |
| `pages/index/index` | 行程分组列表、创建入口 |
| `pages/trip-form/trip-form` | 创建或编辑行程 |
| `pages/trip/trip` | 总览、成员净额、账单列表、主操作 |
| `pages/expense-form/expense-form` | 新增或编辑账单、本地草稿 |
| `pages/expense/expense` | 账单详情、分摊、审计摘要 |
| `pages/settlement/settlement` | 成员余额、转账清单、双向确认 |

## 4. 模块边界

```text
domain/money.js
  parseYuanToFen()  formatFen()

domain/split.js
  splitEqual()  splitByUnits()
        │
        └─ 稳定尾差顺序：createdAt -> memberId

domain/ledger.js
  summarizeLedger()
        │
        └─ assertBalanced()

domain/settlement.js
  buildSettlementTransfers()
```

`services/repository.js` 对页面暴露：

- `bootstrap()`
- `listTrips()` / `getTrip(tripId)` / `createTrip(input)`
- `createOfflineMember(tripId, input)` / `removeMember(memberId)` / `transferOwner(input)`
- `listExpenses(tripId)` / `getExpense(expenseId)`
- `createExpense(input)` / `updateExpense(input)` / `deleteExpense(input)`
- `previewSettlement(tripId)` / `startSettlement(tripId)`
- `updateTransferStatus(input)`
- `createInvite(tripId)` / `getActiveInvite(tripId)` / `revokeInvite(inviteId)` / `joinTrip(input)`

## 5. 云函数边界

为降低冷启动和重复代码，MVP 采用单一 `api` 云函数加明确 action 路由，而不是每个按钮一个函数。

```text
api(event, wxContext)
  ├─ 识别 openid
  ├─ 校验 action 与输入
  ├─ 读取行程成员关系
  ├─ 执行领域操作，必要时开启事务
  ├─ 写入 AuditLog
  └─ 返回 { ok, data, error }
```

服务端 action：`bootstrap`、行程管理、成员管理与创建者转让、邀请预览/撤销/加入、账单增改删、结算预览/发起/转账确认。所有写操作均在 action 内再次校验 `OPENID` 对应成员与角色。

## 6. 一致性与状态机

```text
账本： active/settled
  │ 允许的账单写入
  ▼
needs_settlement
  │ owner 发起快照
  ▼
settling ── pending -> paid -> received
  │                    │
  │ 无付款时改账       └─ 全部 received（单事务）
  ▼                    ▼
needs_settlement          settled
```

- `Expense.clientRequestId` 保证创建幂等。
- `Expense.revision` + `expectedRevision` 阻止静默覆盖。
- 账单写入与 `Trip.ledgerRevision` 递增同事务。
- 结算写入前再次断言 `ledgerRevision` 未变。
- 最后一笔收款确认与 Trip/Settlement 完成同事务。
- 活跃结算仍全部为 `pending` 时，改账会在同一事务中把旧方案标记为 `invalidated`；出现 `paid` 或 `received` 后拒绝改账。

## 7. 错误模型

| 代码 | 用户体验 |
| --- | --- |
| `NETWORK_ERROR` | 保留草稿，显示重试 |
| `VALIDATION_ERROR` | 聚焦到对应表单项 |
| `FORBIDDEN` | 刷新数据后显示无权限 |
| `REVISION_CONFLICT` | 显示最新账单，让用户重新编辑 |
| `LEDGER_CHANGED` | 刷新结算预览后重试 |
| `SETTLEMENT_LOCKED` | 说明已有付款，禁止改账 |

## 8. 安全与隐私

- 云函数只信任 `wxContext.OPENID`，不信任客户端 userId。
- 所有 tripId 资源读写前检查 Member 关系。
- 邀请只携带高熵 inviteId，不携带权限。
- 不记录完整账单到日志；不强制获取手机号。
- 数据库客户端写规则默认拒绝。

## 9. 交付顺序

1. 领域纯函数与单元测试。
2. 演示仓储与全页面可用流程。
3. 云函数、云数据库索引与权限规则。
4. 开发者工具单人验收。
5. 两个真实微信账号多人验收。
6. GitHub 私有仓库与可复现部署说明。

## 10. 明确不在 MVP 内

- 微信支付自动转账：开放能力和合规复杂，首版只确认状态。
- OCR、多币种、报表与导出：不阻断“共享记账→结算”主链路。
- 后台实时推送：MVP 在写入、`onShow` 和下拉时同步。
