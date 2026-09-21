# 微信云开发配置清单

TripSplit 的多人模式依赖微信云开发。以下配置必须在同一个 AppID `wx7318f729fe3a3146` 下完成。

## 1. 环境与集合

创建一个云开发环境，并建立这些集合：

- `users`
- `trips`
- `members`
- `expenses`
- `expenseShares`
- `settlements`
- `settlementTransfers`
- `auditLogs`
- `invites`

所有集合的客户端权限设为“所有用户不可读写”。小程序只调用 `api` 云函数，云函数以服务端身份访问数据库。

## 2. 组合索引

在云数据库控制台建立以下组合索引。未注明排序方向的字段使用升序即可。

| 集合 | 字段 |
| --- | --- |
| `members` | `tripId`, `userId`, `status` |
| `members` | `tripId`, `status` |
| `expenses` | `tripId`, `deletedAt` |
| `expenses` | `tripId`, `createdByUserId`, `clientRequestId` |
| `expenses` | `tripId`, `payerMemberId`, `deletedAt` |
| `expenseShares` | `tripId`, `deletedAt` |
| `expenseShares` | `expenseId`, `deletedAt` |
| `expenseShares` | `tripId`, `memberId`, `deletedAt` |
| `settlements` | `tripId`, `ledgerRevision`, `status` |
| `settlementTransfers` | `settlementId`, `status` |

`inviteId`、`tripId`、`entityId` 等单字段查询使用集合默认单字段索引。

## 3. 云函数

1. 将云环境 ID 写入 `config/cloud.js`。
2. 在微信开发者工具中右键 `cloudfunctions/api`。
3. 选择“上传并部署：云端安装依赖”。
4. 部署后调用 `bootstrap`，确认返回 `{ mode: "cloud" }`。

云函数依赖已由 `cloudfunctions/api/package-lock.json` 固定。依赖风险说明见 `SECURITY.md`。

## 4. 验收

严格执行 `TEST_PLAN.md` 的双账号流程。验收前确认首页不再显示“本机演示模式”，并核对：

- A 创建行程，B 通过分享链接加入。
- A/B 各自记账后，另一端下拉刷新可见一致结果。
- 只有付款方能标记已支付，只有收款方能确认收款。
- 撤销邀请后旧链接失效。
- 云数据库客户端直接写入被拒绝。
