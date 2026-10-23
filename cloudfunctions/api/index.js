'use strict'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const money = require('./currency')
const fxProvider = require('./fxProvider')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
// First-time idempotency records, invite memberships and FX quotes are absent
// by design. SDK 4.x otherwise throws before their read-then-create paths run.
const db = cloud.database({ throwOnNotFound: false })
const command = db.command
const C = {
  users: 'users', trips: 'trips', members: 'members', expenses: 'expenses',
  expenseShares: 'expenseShares', settlements: 'settlements', transfers: 'settlementTransfers', audits: 'auditLogs', invites: 'invites', fxQuotes: 'fxQuotes',
}

let schemaReadyPromise = null

async function ensureCollections() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = Promise.all(Object.values(C).map(async (name) => {
      try {
        await db.createCollection(name)
      } catch (createError) {
        try {
          await db.collection(name).limit(1).get()
        } catch (_) {
          throw createError
        }
      }
    })).catch((error) => {
      schemaReadyPromise = null
      throw error
    })
  }
  return schemaReadyPromise
}
const CATEGORIES = new Set(['food', 'transport', 'stay', 'ticket', 'shopping', 'other'])

class ApiError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details }
}

const iso = () => new Date().toISOString()
const randomId = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url')
const randomInviteCode = () => String(crypto.randomInt(100000, 1000000))
const joinedMemberId = (tripId, openid) => crypto.createHash('sha256').update(`${tripId}:${openid}`).digest('hex').slice(0, 32)
const expenseRequestId = (tripId, openid, requestId) => crypto.createHash('sha256').update(JSON.stringify([tripId, openid, requestId])).digest('hex').slice(0, 32)
const publicDoc = (doc) => doc && ({ ...doc, id: doc._id, _id: undefined, _openid: undefined })
const assert = (condition, code, message, details) => { if (!condition) throw new ApiError(code, message, details) }

async function allocateInviteCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const inviteCode = randomInviteCode()
    const existing = await db.collection(C.invites).where({ inviteCode, status: 'active' }).limit(1).get()
    if (!existing.data.length) return inviteCode
  }
  throw new ApiError('INVITE_CODE_UNAVAILABLE', '暂时无法生成匹配码，请重试')
}

async function ensureInviteCode(invite) {
  if (/^\d{6}$/.test(String(invite.inviteCode || ''))) return invite.inviteCode
  const inviteCode = await allocateInviteCode()
  await db.collection(C.invites).doc(invite._id).update({ data: { inviteCode } })
  invite.inviteCode = inviteCode
  return inviteCode
}

function stableMembers(members) {
  return [...members].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a._id).localeCompare(String(b._id)))
}

function splitAmount(amountFen, members, splitMode, units = {}) {
  assert(Number.isSafeInteger(amountFen) && amountFen > 0 && amountFen <= 99999999, 'VALIDATION_ERROR', '金额不合法')
  assert(members.length > 0, 'VALIDATION_ERROR', '至少选择一名参与人')
  const ordered = stableMembers(members)
  let totalUnits = ordered.length
  if (splitMode === 'units') {
    ordered.forEach((member) => assert(Number.isInteger(units[member._id]) && units[member._id] >= 1 && units[member._id] <= 999, 'VALIDATION_ERROR', '份数必须是 1 至 999 的整数'))
    totalUnits = ordered.reduce((sum, member) => sum + units[member._id], 0)
  }
  const shares = ordered.map((member) => ({
    memberId: member._id,
    shareUnits: splitMode === 'units' ? units[member._id] : 1,
    amountFen: Math.floor(amountFen * (splitMode === 'units' ? units[member._id] : 1) / totalUnits),
  }))
  let remainder = amountFen - shares.reduce((sum, share) => sum + share.amountFen, 0)
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) shares[index].amountFen += 1
  return shares
}

function summarize(members, expenses, shares) {
  const summary = Object.fromEntries(members.map((member) => [member._id, { memberId: member._id, displayName: member.displayName, avatarUrl: member.avatarUrl || '', paidAmount: 0, owedAmount: 0, netAmount: 0 }]))
  expenses.forEach((expense) => { assert(summary[expense.payerMemberId], 'DATA_INTEGRITY', '付款人不存在'); summary[expense.payerMemberId].paidAmount += expense.amountFen })
  shares.forEach((share) => { assert(summary[share.memberId], 'DATA_INTEGRITY', '分摊成员不存在'); summary[share.memberId].owedAmount += share.amountFen })
  const result = Object.values(summary).map((item) => ({ ...item, netAmount: item.paidAmount - item.owedAmount }))
  assert(result.reduce((sum, item) => sum + item.netAmount, 0) === 0, 'DATA_INTEGRITY', '账本不平衡')
  return result
}

function settle(summary) {
  const debtors = summary.filter((item) => item.netAmount < 0).map((item) => ({ ...item, remaining: -item.netAmount })).sort((a, b) => b.remaining - a.remaining || a.memberId.localeCompare(b.memberId))
  const creditors = summary.filter((item) => item.netAmount > 0).map((item) => ({ ...item, remaining: item.netAmount })).sort((a, b) => b.remaining - a.remaining || a.memberId.localeCompare(b.memberId))
  const transfers = []
  let d = 0; let c = 0
  while (d < debtors.length && c < creditors.length) {
    const amountFen = Math.min(debtors[d].remaining, creditors[c].remaining)
    transfers.push({ fromMemberId: debtors[d].memberId, toMemberId: creditors[c].memberId, amountFen, status: 'pending' })
    debtors[d].remaining -= amountFen; creditors[c].remaining -= amountFen
    if (!debtors[d].remaining) d += 1
    if (!creditors[c].remaining) c += 1
  }
  return transfers
}

async function allWhere(collection, where, pageSize = 100) {
  const rows = []
  for (let skip = 0; ; skip += pageSize) {
    const page = await db.collection(collection).where(where).skip(skip).limit(pageSize).get()
    rows.push(...page.data)
    if (page.data.length < pageSize) return rows
  }
}

async function memberFor(openid, tripId, requiredRole, allowInactive = false) {
  const where = { tripId, userId: openid }
  if (!allowInactive) where.status = 'active'
  const result = await db.collection(C.members).where(where).limit(1).get()
  const member = result.data[0]
  assert(member, 'FORBIDDEN', allowInactive ? '你不是该行程成员' : '你不是该行程的活跃成员')
  if (requiredRole) assert(member.role === requiredRole, 'FORBIDDEN', '只有行程创建者可执行此操作')
  return member
}

async function ledger(tripId) {
  const [members, expenses, shares, completed] = await Promise.all([
    allWhere(C.members, { tripId }),
    allWhere(C.expenses, { tripId, deletedAt: command.eq(null) }),
    allWhere(C.expenseShares, { tripId, deletedAt: command.eq(null) }),
    allWhere(C.settlements, { tripId, status: 'completed' }),
  ])
  const liveExpenseIds = new Set(expenses.map((expense) => expense._id))
  const liveShares = shares.filter((share) => liveExpenseIds.has(share.expenseId))
  const settledAmounts = {}
  for (const settlement of completed) {
    for (const balance of settlement.memberBalances) settledAmounts[balance.memberId] = (settledAmounts[balance.memberId] || 0) + balance.netAmount
  }
  const summary = summarize(members, expenses, liveShares).map((item) => ({
    ...item, ledgerNetAmount: item.netAmount, settledNetAmount: settledAmounts[item.memberId] || 0,
    netAmount: item.netAmount - (settledAmounts[item.memberId] || 0),
  }))
  assert(summary.reduce((sum, item) => sum + item.netAmount, 0) === 0, 'DATA_INTEGRITY', '结算余额不平衡')
  return { members, expenses, shares: liveShares, summary }
}

async function isSettledExpense(expense) {
  const completed = await allWhere(C.settlements, { tripId: expense.tripId, status: 'completed' })
  return completed.some((settlement) => Number.isInteger(expense.createdLedgerRevision)
    ? expense.createdLedgerRevision <= settlement.ledgerRevision
    : expense.createdAt <= settlement.createdAt)
}

async function dashboard(openid, trip) {
  const current = await memberFor(openid, trip._id, null, true)
  const data = await ledger(trip._id)
  const mine = data.summary.find((item) => current && item.memberId === current._id)
  return {
    ...publicDoc(trip), baseCurrency: trip.baseCurrency || 'CNY',
    members: data.members.map(publicDoc), expenses: data.expenses.map(publicDoc).sort((a, b) => b.spentAt.localeCompare(a.spentAt)), summary: data.summary,
    totalAmountFen: data.expenses.reduce((sum, expense) => sum + expense.amountFen, 0), currentMemberId: current && current._id, currentMemberRole: current && current.role, currentMemberStatus: current && current.status,
    myPaidAmountFen: mine ? mine.paidAmount : 0, myOwedAmountFen: mine ? mine.owedAmount : 0, myNetAmountFen: mine ? mine.netAmount : 0,
  }
}

async function bootstrap(openid) {
  await ensureCollections()
  const existing = await db.collection(C.users).where({ openid }).limit(1).get()
  let profile = existing.data[0]
  if (!profile) {
    const createdAt = iso()
    const result = await db.collection(C.users).add({ data: { openid, displayName: '', avatarUrl: '', createdAt } })
    profile = { _id: result._id, openid, displayName: '', avatarUrl: '', createdAt }
  }
  return { userId: openid, mode: 'cloud', displayName: profile.displayName || '', avatarUrl: profile.avatarUrl || '', profileComplete: Boolean(profile.displayName && profile.avatarUrl) }
}

async function updateProfile(openid, input) {
  const displayName = String(input.displayName || '').trim()
  const avatarUrl = String(input.avatarUrl || '')
  assert(displayName && displayName.length <= 30, 'VALIDATION_ERROR', '昵称需为 1 至 30 字')
  assert(avatarUrl.startsWith('cloud://') && avatarUrl.length <= 500, 'VALIDATION_ERROR', '请选择有效的微信头像')
  const existing = await db.collection(C.users).where({ openid }).limit(1).get()
  const updatedAt = iso()
  if (existing.data[0]) await db.collection(C.users).doc(existing.data[0]._id).update({ data: { displayName, avatarUrl, updatedAt } })
  else await db.collection(C.users).add({ data: { openid, displayName, avatarUrl, createdAt: updatedAt, updatedAt } })
  const memberships = await allWhere(C.members, { userId: openid })
  for (const member of memberships) await db.collection(C.members).doc(member._id).update({ data: { displayName, avatarUrl, updatedAt } })
  return { userId: openid, mode: 'cloud', displayName, avatarUrl, profileComplete: true, updatedAt }
}

async function listTrips(openid) {
  const memberships = await allWhere(C.members, { userId: openid })
  if (!memberships.length) return []
  const tripIds = [...new Set(memberships.map((item) => item.tripId))]
  const trips = []
  for (let index = 0; index < tripIds.length; index += 10) {
    const result = await db.collection(C.trips).where({ _id: command.in(tripIds.slice(index, index + 10)) }).limit(10).get()
    trips.push(...result.data)
  }
  return Promise.all(trips.map((trip) => dashboard(openid, trip)))
}

async function createTrip(openid, input) {
  const baseCurrency = input.baseCurrency || 'CNY'
  assert(money.CURRENCIES.some((item) => item.code === baseCurrency), 'VALIDATION_ERROR', '暂不支持该币种')
  assert(typeof input.name === 'string' && input.name.trim() && input.name.trim().length <= 30, 'VALIDATION_ERROR', '请填写 1 至 30 字的行程名称')
  assert(!input.startDate || /^\d{4}-\d{2}-\d{2}$/.test(input.startDate), 'VALIDATION_ERROR', '开始日期不合法')
  assert(!input.endDate || /^\d{4}-\d{2}-\d{2}$/.test(input.endDate), 'VALIDATION_ERROR', '结束日期不合法')
  assert(!input.startDate || !input.endDate || input.endDate >= input.startDate, 'VALIDATION_ERROR', '结束日期不能早于开始日期')
  const profileResult = await db.collection(C.users).where({ openid }).limit(1).get()
  const profile = profileResult.data[0] || {}
  const ownerName = String(input.ownerName || profile.displayName || '微信用户').trim()
  const avatarUrl = String(input.avatarUrl || profile.avatarUrl || '')
  assert(ownerName && ownerName.length <= 30, 'VALIDATION_ERROR', '行程昵称需为 1 至 30 字')
  assert(!avatarUrl || (avatarUrl.startsWith('cloud://') && avatarUrl.length <= 500), 'VALIDATION_ERROR', '头像地址不合法')
  const companions = Array.isArray(input.companions) ? input.companions.map((name) => String(name).trim()).filter(Boolean).slice(0, 19) : []
  assert(companions.every((name) => name.length <= 30), 'VALIDATION_ERROR', '成员名称最多 30 字')
  const transaction = await db.startTransaction()
  try {
    const createdAt = iso()
    const tripResult = await transaction.collection(C.trips).add({ data: { name: input.name.trim(), baseCurrency, destination: String(input.destination || '').trim(), startDate: input.startDate || '', endDate: input.endDate || '', ownerUserId: openid, status: 'active', ledgerRevision: 0, activeSettlementId: null, latestSettlementId: null, createdAt, updatedAt: createdAt } })
    await transaction.collection(C.members).add({ data: { tripId: tripResult._id, userId: openid, displayName: ownerName, avatarUrl, role: 'owner', status: 'active', createdAt } })
    for (let index = 0; index < companions.length; index += 1) await transaction.collection(C.members).add({ data: { tripId: tripResult._id, userId: null, displayName: companions[index], role: 'member', status: 'active', createdAt: new Date(Date.now() + index + 1).toISOString() } })
    await transaction.commit()
    return { id: tripResult._id }
  } catch (error) { await transaction.rollback(); throw error }
}

async function updateTrip(openid, input) {
  await memberFor(openid, input.tripId, 'owner')
  const existingTrip = (await db.collection(C.trips).doc(input.tripId).get()).data
  assert(existingTrip && existingTrip.status !== 'archived', 'FORBIDDEN', '已归档行程为只读')
  assert(!input.baseCurrency || input.baseCurrency === (existingTrip.baseCurrency || 'CNY'), 'VALIDATION_ERROR', '行程结算币种创建后不可修改')
  const name = String(input.name || '').trim()
  assert(name && name.length <= 30, 'VALIDATION_ERROR', '请填写 1 至 30 字的行程名称')
  assert(!input.startDate || !input.endDate || input.endDate >= input.startDate, 'VALIDATION_ERROR', '结束日期不能早于开始日期')
  const updatedAt = iso()
  await db.collection(C.trips).doc(input.tripId).update({ data: { name, destination: String(input.destination || '').trim(), startDate: input.startDate || '', endDate: input.endDate || '', updatedAt } })
  await db.collection(C.audits).add({ data: { tripId: input.tripId, entityType: 'trip', entityId: input.tripId, action: 'updated', actorUserId: openid, summary: '修改行程设置', createdAt: updatedAt } })
  return publicDoc((await db.collection(C.trips).doc(input.tripId).get()).data)
}

async function archiveTrip(openid, tripId) {
  await memberFor(openid, tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  assert(trip.status !== 'archived', 'VALIDATION_ERROR', '行程已归档')
  assert(trip.status !== 'settling', 'SETTLEMENT_LOCKED', '结算进行中，不能归档')
  const updatedAt = iso()
  await db.collection(C.trips).doc(tripId).update({ data: { statusBeforeArchive: trip.status, status: 'archived', updatedAt } })
  await db.collection(C.audits).add({ data: { tripId, entityType: 'trip', entityId: tripId, action: 'archived', actorUserId: openid, summary: '归档行程', createdAt: updatedAt } })
  return { ...publicDoc(trip), status: 'archived', statusBeforeArchive: trip.status, updatedAt }
}

async function restoreTrip(openid, tripId) {
  await memberFor(openid, tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  assert(trip.status === 'archived', 'VALIDATION_ERROR', '行程未归档')
  const status = trip.statusBeforeArchive || 'active'
  const updatedAt = iso()
  await db.collection(C.trips).doc(tripId).update({ data: { status, statusBeforeArchive: command.remove(), updatedAt } })
  await db.collection(C.audits).add({ data: { tripId, entityType: 'trip', entityId: tripId, action: 'restored', actorUserId: openid, summary: '恢复行程', createdAt: updatedAt } })
  return { ...publicDoc(trip), status, statusBeforeArchive: undefined, updatedAt }
}

async function createOfflineMember(openid, input) {
  await memberFor(openid, input.tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(input.tripId).get()).data
  assert(trip && trip.status !== 'archived', 'FORBIDDEN', '已归档行程为只读')
  const name = String(input.displayName || '').trim()
  assert(name && name.length <= 30, 'VALIDATION_ERROR', '成员名称需为 1 至 30 字')
  const active = await allWhere(C.members, { tripId: input.tripId, status: 'active' })
  assert(active.length < 20, 'VALIDATION_ERROR', '每个行程最多 20 名成员')
  const createdAt = iso()
  const result = await db.collection(C.members).add({ data: { tripId: input.tripId, userId: null, displayName: name, role: 'member', status: 'active', createdAt } })
  await db.collection(C.audits).add({ data: { tripId: input.tripId, entityType: 'member', entityId: result._id, action: 'offline_member_added', actorUserId: openid, summary: `添加离线成员 ${name}`, createdAt } })
  return { id: result._id, tripId: input.tripId, userId: null, displayName: name, role: 'member', status: 'active', createdAt }
}

async function updateOfflineMember(openid, input) {
  const target = (await db.collection(C.members).doc(input.memberId).get()).data
  assert(target && target.userId === null, 'NOT_FOUND', '离线成员不存在')
  await memberFor(openid, target.tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(target.tripId).get()).data
  assert(trip && trip.status !== 'archived', 'FORBIDDEN', '已归档行程为只读')
  const name = String(input.displayName || '').trim()
  assert(name && name.length <= 30, 'VALIDATION_ERROR', '成员名称需为 1 至 30 字')
  await db.collection(C.members).doc(target._id).update({ data: { displayName: name } })
  await db.collection(C.audits).add({ data: { tripId: target.tripId, entityType: 'member', entityId: target._id, action: 'offline_member_renamed', actorUserId: openid, summary: `成员改名：${target.displayName} -> ${name}`, createdAt: iso() } })
  return { ...publicDoc(target), displayName: name }
}

async function updateMyAvatar(openid, input) {
  const member = await memberFor(openid, input.tripId)
  const avatarUrl = String(input.avatarUrl || '')
  assert(avatarUrl.startsWith('cloud://') && avatarUrl.length <= 500, 'VALIDATION_ERROR', '头像地址不合法')
  const updatedAt = iso()
  await db.collection(C.members).doc(member._id).update({ data: { avatarUrl, updatedAt } })
  await db.collection(C.audits).add({ data: { tripId: input.tripId, entityType: 'member', entityId: member._id, action: 'avatar_updated', actorUserId: openid, summary: '更新个人头像', createdAt: updatedAt } })
  return { ...publicDoc(member), avatarUrl, updatedAt }
}

async function deactivateMember(openid, input) {
  const target = (await db.collection(C.members).doc(input.memberId).get()).data
  assert(target && target.role !== 'owner', 'NOT_FOUND', '成员不存在或不可停用')
  await memberFor(openid, target.tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(target.tripId).get()).data
  assert(trip && trip.status !== 'archived', 'FORBIDDEN', '已归档行程为只读')
  await db.collection(C.members).doc(target._id).update({ data: { status: 'inactive', deactivatedAt: iso() } })
  await db.collection(C.audits).add({ data: { tripId: target.tripId, entityType: 'member', entityId: target._id, action: 'member_deactivated', actorUserId: openid, summary: `停用成员 ${target.displayName}`, createdAt: iso() } })
  return { ...publicDoc(target), status: 'inactive' }
}

async function removeMember(openid, input) {
  const target = (await db.collection(C.members).doc(input.memberId).get()).data
  assert(target && target.role !== 'owner', 'NOT_FOUND', '成员不存在或不可移除')
  await memberFor(openid, target.tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(target.tripId).get()).data
  assert(trip && trip.status !== 'archived', 'FORBIDDEN', '已归档行程为只读')
  const [paid, shared] = await Promise.all([
    db.collection(C.expenses).where({ tripId: target.tripId, payerMemberId: target._id, deletedAt: command.eq(null) }).limit(1).get(),
    db.collection(C.expenseShares).where({ tripId: target.tripId, memberId: target._id, deletedAt: command.eq(null) }).limit(1).get(),
  ])
  assert(!paid.data.length && !shared.data.length, 'MEMBER_HAS_EXPENSES', '该成员已有账单，只能停用')
  const removedAt = iso()
  const transaction = await db.startTransaction()
  try {
    await transaction.collection(C.members).doc(target._id).remove()
    await transaction.collection(C.audits).add({ data: { tripId: target.tripId, entityType: 'member', entityId: target._id, action: 'member_removed', actorUserId: openid, summary: `移除成员 ${target.displayName}`, createdAt: removedAt } })
    await transaction.commit()
    return { removed: true }
  } catch (error) { await transaction.rollback(); throw error }
}

async function transferOwner(openid, input) {
  const current = await memberFor(openid, input.tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(input.tripId).get()).data
  assert(trip && trip.status !== 'archived', 'FORBIDDEN', '已归档行程为只读')
  const target = (await db.collection(C.members).doc(input.memberId).get()).data
  assert(target && target.tripId === input.tripId && target.status === 'active' && target.userId && target.role !== 'owner', 'VALIDATION_ERROR', '只能转让给活跃微信成员')
  const transaction = await db.startTransaction()
  try {
    const latestCurrent = (await transaction.collection(C.members).doc(current._id).get()).data
    const latestTarget = (await transaction.collection(C.members).doc(target._id).get()).data
    assert(latestCurrent.role === 'owner' && latestTarget.status === 'active' && latestTarget.userId, 'REVISION_CONFLICT', '成员状态已变化，请刷新后重试')
    const changedAt = iso()
    await transaction.collection(C.members).doc(current._id).update({ data: { role: 'member' } })
    await transaction.collection(C.members).doc(target._id).update({ data: { role: 'owner' } })
    await transaction.collection(C.trips).doc(input.tripId).update({ data: { ownerUserId: latestTarget.userId, updatedAt: changedAt } })
    await transaction.collection(C.audits).add({ data: { tripId: input.tripId, entityType: 'trip', entityId: input.tripId, action: 'owner_transferred', actorUserId: openid, summary: `创建者转让给 ${latestTarget.displayName}`, createdAt: changedAt } })
    await transaction.commit()
    return { ownerMemberId: latestTarget._id }
  } catch (error) { await transaction.rollback(); throw error }
}

async function transferIdsFor(settlementId) {
  if (!settlementId) return []
  // A settlement's transfer set is immutable; only their statuses change.
  return (await allWhere(C.transfers, { settlementId })).map((item) => item._id)
}

async function readTransfers(transaction, ids) {
  const transfers = []
  for (const id of ids) {
    const item = (await transaction.collection(C.transfers).doc(id).get()).data
    assert(item, 'DATA_INTEGRITY', '结算转账记录不完整')
    transfers.push(item)
  }
  return transfers
}

async function assertLedgerWriteAllowed(transaction, trip, expectedTrip, transferIds) {
  assert(trip.ledgerRevision === expectedTrip.ledgerRevision && trip.activeSettlementId === expectedTrip.activeSettlementId && trip.status === expectedTrip.status, 'LEDGER_CHANGED', '账本或结算已变化，请刷新后重试')
  assert(['active', 'needs_settlement', 'settled', 'settling'].includes(trip.status), 'SETTLEMENT_LOCKED', '当前结算状态不允许改账')
  if (trip.status !== 'settling') return
  assert(trip.activeSettlementId, 'DATA_INTEGRITY', '进行中的结算不存在')
  const transfers = await readTransfers(transaction, transferIds)
  assert(transfers.length > 0 && transfers.every((item) => item.settlementId === trip.activeSettlementId), 'DATA_INTEGRITY', '结算转账记录不完整')
  assert(transfers.every((item) => item.status === 'pending'), 'SETTLEMENT_LOCKED', '已有转账被标记支付，暂不能改账')
  await transaction.collection(C.settlements).doc(trip.activeSettlementId).update({ data: { status: 'invalidated', invalidatedAt: iso(), invalidatedReason: 'ledger_changed' } })
}

function validateExpenseFields(input) {
  assert(CATEGORIES.has(input.category || 'other'), 'VALIDATION_ERROR', '账单分类不合法')
  assert(String(input.note || '').length <= 100, 'VALIDATION_ERROR', '备注最多 100 字')
  assert(typeof input.spentAt === 'string' && Number.isFinite(Date.parse(input.spentAt)), 'VALIDATION_ERROR', '消费时间不合法')
}

const fxCache = new Map()
async function fxQuote(openid, input) {
  await memberFor(openid, input.tripId)
  const trip = (await db.collection(C.trips).doc(input.tripId).get()).data
  assert(trip && trip.status !== 'archived', 'FORBIDDEN', '已归档行程为只读')
  const base = input.currency
  const quote = trip.baseCurrency || 'CNY'
  try { fxProvider.validateRequest(base, quote, input.date) }
  catch (error) { throw new ApiError('VALIDATION_ERROR', error.message) }
  const cacheKey = JSON.stringify([base, quote, input.date])
  const cached = fxCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 3600000) return cached.data
  let data
  try { data = await fxProvider.fetchRate(base, quote, input.date) }
  catch (error) { throw new ApiError('FX_UNAVAILABLE', `${error.message}；可改为手动汇率或实际扣款`) }
  await ensureCollections()
  const id = crypto.createHash('sha256').update(JSON.stringify([data.base, data.quote, data.requestedDate, data.rateDate, data.rate, data.provider])).digest('hex').slice(0, 32)
  const existing = (await db.collection(C.fxQuotes).doc(id).get()).data
  if (existing) data = publicDoc(existing)
  else {
    await db.collection(C.fxQuotes).doc(id).set({ data })
    data = { ...data, id }
  }
  if (fxCache.size >= 100) fxCache.delete(fxCache.keys().next().value)
  fxCache.set(cacheKey, { data, at: Date.now() })
  return data
}

async function expenseMoney(input, trip, previous) {
  assert(input.fx || !previous || !previous.originalCurrency || previous.originalCurrency === 'CNY', 'VALIDATION_ERROR', '请更新小程序后编辑外币账单')
  let quote = null
  if (input.fx && input.fx.mode === 'auto' && input.originalCurrency !== (trip.baseCurrency || 'CNY')) {
    assert(typeof input.fx.quoteId === 'string' && /^[a-f0-9]{32}$/.test(input.fx.quoteId), 'VALIDATION_ERROR', '请先获取参考汇率')
    quote = publicDoc((await db.collection(C.fxQuotes).doc(input.fx.quoteId).get()).data)
  }
  try { return money.normalizeFx(input, trip.baseCurrency || 'CNY', quote) }
  catch (error) { throw new ApiError('VALIDATION_ERROR', error.message) }
}

async function createExpense(openid, input) {
  const actor = await memberFor(openid, input.tripId)
  assert(typeof input.clientRequestId === 'string' && input.clientRequestId.length >= 8, 'VALIDATION_ERROR', '请求标识不合法')
  assert(Array.isArray(input.participantMemberIds) && input.participantMemberIds.length > 0, 'VALIDATION_ERROR', '至少选择一名参与人')
  assert(['equal', 'units'].includes(input.splitMode), 'VALIDATION_ERROR', '分摊方式不合法')
  validateExpenseFields(input)
  const duplicate = await db.collection(C.expenses).where({ tripId: input.tripId, createdByUserId: openid, clientRequestId: input.clientRequestId }).limit(1).get()
  if (duplicate.data.length) return publicDoc(duplicate.data[0])
  const trip = (await db.collection(C.trips).doc(input.tripId).get()).data
  assert(['active', 'needs_settlement', 'settled', 'settling'].includes(trip.status), 'SETTLEMENT_LOCKED', '当前结算状态不允许改账')
  const monetary = await expenseMoney(input, trip)
  input = { ...input, amountFen: monetary.amountFen }
  const expenseCount = await db.collection(C.expenses).where({ tripId: input.tripId, deletedAt: command.eq(null) }).count()
  assert(expenseCount.total < 5000, 'VALIDATION_ERROR', '单个行程最多 5,000 笔有效账单')
  const members = await allWhere(C.members, { tripId: input.tripId, status: 'active' })
  const memberIds = new Set(members.map((member) => member._id))
  assert(memberIds.has(input.payerMemberId), 'VALIDATION_ERROR', '付款人不合法')
  const selected = members.filter((member) => input.participantMemberIds.includes(member._id))
  assert(selected.length === input.participantMemberIds.length, 'VALIDATION_ERROR', '参与人不合法')
  const shares = splitAmount(input.amountFen, selected, input.splitMode, input.units || {})
  const transferIds = await transferIdsFor(trip.activeSettlementId)
  const expenseId = expenseRequestId(input.tripId, openid, input.clientRequestId)
  const transaction = await db.startTransaction()
  try {
    const latestDuplicate = await transaction.collection(C.expenses).doc(expenseId).get()
    if (latestDuplicate.data) {
      await transaction.commit()
      return publicDoc(latestDuplicate.data)
    }
    const latestTrip = (await transaction.collection(C.trips).doc(input.tripId).get()).data
    await assertLedgerWriteAllowed(transaction, latestTrip, trip, transferIds)
    const createdAt = iso()
    const expenseResult = { _id: expenseId }
    await transaction.collection(C.expenses).doc(expenseId).set({ data: { ...monetary, tripId: input.tripId, payerMemberId: input.payerMemberId, category: input.category || 'other', note: String(input.note || '').slice(0, 100), spentAt: input.spentAt || createdAt, splitMode: input.splitMode || 'equal', revision: 1, createdLedgerRevision: latestTrip.ledgerRevision + 1, clientRequestId: input.clientRequestId, createdByUserId: openid, updatedByUserId: openid, deletedAt: null, createdAt, updatedAt: createdAt } })
    for (const share of shares) await transaction.collection(C.expenseShares).add({ data: { ...share, tripId: input.tripId, expenseId: expenseResult._id, deletedAt: null } })
    await transaction.collection(C.trips).doc(input.tripId).update({ data: { ledgerRevision: command.inc(1), status: 'needs_settlement', activeSettlementId: null, updatedAt: createdAt } })
    await transaction.collection(C.audits).add({ data: { tripId: input.tripId, entityType: 'expense', entityId: expenseResult._id, action: 'created', actorUserId: openid, summary: `新增账单 ${money.amountText(input.amountFen, monetary.baseCurrency)}（${monetary.fx.source}）`, createdAt } })
    await transaction.commit()
    return { id: expenseResult._id, createdByMemberId: actor._id }
  } catch (error) { await transaction.rollback(); throw error }
}

async function getExpense(openid, expenseId) {
  const expenseResult = await db.collection(C.expenses).doc(expenseId).get()
  const expense = expenseResult.data
  assert(expense && !expense.deletedAt, 'NOT_FOUND', '账单不存在')
  const actor = await memberFor(openid, expense.tripId, null, true)
  const [shares, members, auditRows] = await Promise.all([
    allWhere(C.expenseShares, { expenseId, deletedAt: command.eq(null) }),
    allWhere(C.members, { tripId: expense.tripId }),
    allWhere(C.audits, { entityId: expenseId }),
  ])
  const actorNames = Object.fromEntries(members.filter((member) => member.userId).map((member) => [member.userId, member.displayName]))
  const audits = auditRows.filter((audit) => audit.entityType === 'expense').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
  return {
    ...publicDoc(expense),
    members: members.map(publicDoc),
    shares: Object.fromEntries(shares.map((share) => [share.memberId, share.amountFen])),
    shareUnits: Object.fromEntries(shares.map((share) => [share.memberId, share.shareUnits])),
    auditEvents: audits.map((audit) => ({ ...publicDoc(audit), actorName: actorNames[audit.actorUserId] || '行程成员' })),
    canEdit: actor.status === 'active' && (actor.role === 'owner' || expense.createdByUserId === openid) && !await isSettledExpense(expense),
  }
}

async function updateExpense(openid, input) {
  const expenseResult = await db.collection(C.expenses).doc(input.expenseId).get()
  const expense = expenseResult.data
  assert(expense && !expense.deletedAt, 'NOT_FOUND', '账单不存在')
  const actor = await memberFor(openid, expense.tripId)
  assert(actor.role === 'owner' || expense.createdByUserId === openid, 'FORBIDDEN', '你无权编辑这笔账单')
  assert(expense.revision === input.expectedRevision, 'REVISION_CONFLICT', '账单已被修改，请刷新后重试', publicDoc(expense))
  assert(Array.isArray(input.participantMemberIds) && input.participantMemberIds.length > 0, 'VALIDATION_ERROR', '至少选择一名参与人')
  assert(['equal', 'units'].includes(input.splitMode), 'VALIDATION_ERROR', '分摊方式不合法')
  validateExpenseFields(input)
  const trip = (await db.collection(C.trips).doc(expense.tripId).get()).data
  assert(['active', 'needs_settlement', 'settling'].includes(trip.status), 'SETTLEMENT_LOCKED', '当前结算状态不允许改账')
  assert(!await isSettledExpense(expense), 'SETTLEMENT_LOCKED', '已结算账单不可修改，请新增调整账单')
  const monetary = await expenseMoney(input, trip, expense)
  input = { ...input, amountFen: monetary.amountFen }
  const oldShares = await allWhere(C.expenseShares, { expenseId: expense._id, deletedAt: command.eq(null) })
  const historicalMemberIds = new Set([expense.payerMemberId, ...oldShares.map((share) => share.memberId)])
  const members = await allWhere(C.members, { tripId: expense.tripId })
  const eligibleMembers = members.filter((member) => member.status === 'active' || historicalMemberIds.has(member._id))
  const selected = eligibleMembers.filter((member) => input.participantMemberIds.includes(member._id))
  assert(selected.length === input.participantMemberIds.length, 'VALIDATION_ERROR', '参与人不合法')
  assert(eligibleMembers.some((member) => member._id === input.payerMemberId), 'VALIDATION_ERROR', '付款人不合法')
  const shares = splitAmount(input.amountFen, selected, input.splitMode, input.units || {})
  const transferIds = await transferIdsFor(trip.activeSettlementId)
  const transaction = await db.startTransaction()
  try {
    const latest = (await transaction.collection(C.expenses).doc(expense._id).get()).data
    assert(latest.revision === input.expectedRevision && !latest.deletedAt, 'REVISION_CONFLICT', '账单已被修改，请刷新后重试')
    const latestTrip = (await transaction.collection(C.trips).doc(expense.tripId).get()).data
    await assertLedgerWriteAllowed(transaction, latestTrip, trip, transferIds)
    const updatedAt = iso()
    await transaction.collection(C.expenses).doc(expense._id).update({ data: { ...monetary, payerMemberId: input.payerMemberId, category: input.category || 'other', note: String(input.note || '').slice(0, 100), spentAt: input.spentAt, splitMode: input.splitMode || 'equal', revision: command.inc(1), updatedByUserId: openid, updatedAt } })
    for (const share of oldShares) await transaction.collection(C.expenseShares).doc(share._id).update({ data: { deletedAt: updatedAt } })
    for (const share of shares) await transaction.collection(C.expenseShares).add({ data: { ...share, tripId: expense.tripId, expenseId: expense._id, deletedAt: null } })
    await transaction.collection(C.trips).doc(expense.tripId).update({ data: { ledgerRevision: command.inc(1), status: 'needs_settlement', activeSettlementId: null, updatedAt } })
    await transaction.collection(C.audits).add({ data: { tripId: expense.tripId, entityType: 'expense', entityId: expense._id, action: 'updated', actorUserId: openid, summary: `修改账单：${money.amountText(expense.amountFen, monetary.baseCurrency)} → ${money.amountText(input.amountFen, monetary.baseCurrency)}（${monetary.fx.source}）`, beforeMoney: { baseCurrency: expense.baseCurrency || 'CNY', originalCurrency: expense.originalCurrency || 'CNY', originalAmountMinor: expense.originalAmountMinor || expense.amountFen, fx: expense.fx || null }, afterMoney: monetary, createdAt: updatedAt } })
    await transaction.commit()
    return getExpense(openid, expense._id)
  } catch (error) { await transaction.rollback(); throw error }
}

async function deleteExpense(openid, input) {
  const expenseResult = await db.collection(C.expenses).doc(input.expenseId).get()
  const expense = expenseResult.data
  assert(expense && !expense.deletedAt, 'NOT_FOUND', '账单不存在')
  const actor = await memberFor(openid, expense.tripId)
  assert(actor.role === 'owner' || expense.createdByUserId === openid, 'FORBIDDEN', '你无权删除这笔账单')
  assert(expense.revision === input.expectedRevision, 'REVISION_CONFLICT', '账单已被修改，请刷新后重试')
  const trip = (await db.collection(C.trips).doc(expense.tripId).get()).data
  assert(['active', 'needs_settlement', 'settling'].includes(trip.status), 'SETTLEMENT_LOCKED', '当前结算状态不允许删除账单')
  assert(!await isSettledExpense(expense), 'SETTLEMENT_LOCKED', '已结算账单不可删除，请新增调整账单')
  const transferIds = await transferIdsFor(trip.activeSettlementId)
  const transaction = await db.startTransaction()
  try {
    const latest = (await transaction.collection(C.expenses).doc(expense._id).get()).data
    assert(latest.revision === input.expectedRevision && !latest.deletedAt, 'REVISION_CONFLICT', '账单已被修改，请刷新后重试')
    const latestTrip = (await transaction.collection(C.trips).doc(expense.tripId).get()).data
    await assertLedgerWriteAllowed(transaction, latestTrip, trip, transferIds)
    const deletedAt = iso()
    await transaction.collection(C.expenses).doc(expense._id).update({ data: { deletedAt, revision: command.inc(1), updatedByUserId: openid, updatedAt: deletedAt } })
    await transaction.collection(C.trips).doc(expense.tripId).update({ data: { ledgerRevision: command.inc(1), status: 'needs_settlement', activeSettlementId: null, updatedAt: deletedAt } })
    await transaction.collection(C.audits).add({ data: { tripId: expense.tripId, entityType: 'expense', entityId: expense._id, action: 'deleted', actorUserId: openid, summary: `删除账单 ${money.amountText(expense.amountFen, expense.baseCurrency || 'CNY')}`, createdAt: deletedAt } })
    await transaction.commit()
    return { deleted: true }
  } catch (error) { await transaction.rollback(); throw error }
}

async function settlementPreview(openid, tripId) {
  const current = await memberFor(openid, tripId, null, true)
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  const data = await ledger(tripId)
  const names = Object.fromEntries(data.members.map((member) => [member._id, member.displayName]))
  return { status: 'preview', baseCurrency: trip.baseCurrency || 'CNY', ledgerRevision: trip.ledgerRevision, summary: data.summary, currentMemberId: current._id, currentMemberRole: current.role, currentMemberStatus: current.status, transfers: settle(data.summary).map((item, index) => ({ ...item, id: `preview_${index}`, fromName: names[item.fromMemberId], toName: names[item.toMemberId] })) }
}

async function settlementGet(openid, tripId) {
  const current = await memberFor(openid, tripId, null, true)
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  if (!trip.latestSettlementId) return settlementPreview(openid, tripId)
  const settlement = (await db.collection(C.settlements).doc(trip.latestSettlementId).get()).data
  if (!settlement || settlement.status === 'invalidated' || settlement.ledgerRevision !== trip.ledgerRevision) return settlementPreview(openid, tripId)
  const [transfers, members] = await Promise.all([allWhere(C.transfers, { settlementId: settlement._id }), allWhere(C.members, { tripId })])
  const names = Object.fromEntries(members.map((member) => [member._id, member.displayName]))
  return { ...publicDoc(settlement), baseCurrency: trip.baseCurrency || 'CNY', summary: settlement.memberBalances, currentMemberId: current._id, currentMemberRole: current.role, currentMemberStatus: current.status, transfers: transfers.map((item) => ({ ...publicDoc(item), fromName: names[item.fromMemberId], toName: names[item.toMemberId] })) }
}

async function settlementStart(openid, tripId) {
  await memberFor(openid, tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  const existing = await db.collection(C.settlements).where({ tripId, ledgerRevision: trip.ledgerRevision, status: 'active' }).limit(1).get()
  if (existing.data.length) return settlementGet(openid, tripId)
  assert(['active', 'needs_settlement'].includes(trip.status), 'SETTLEMENT_LOCKED', '当前行程状态不允许发起结算')
  const preview = await settlementPreview(openid, tripId)
  const snapshot = await ledger(tripId)
  const transaction = await db.startTransaction()
  try {
    const latestTrip = (await transaction.collection(C.trips).doc(tripId).get()).data
    assert(latestTrip.ledgerRevision === trip.ledgerRevision, 'LEDGER_CHANGED', '账本已变化，请刷新后重试')
    if (latestTrip.activeSettlementId) {
      await transaction.commit()
      return settlementGet(openid, tripId)
    }
    assert(['active', 'needs_settlement'].includes(latestTrip.status), 'SETTLEMENT_LOCKED', '当前行程状态不允许发起结算')
    const createdAt = iso()
    const status = preview.transfers.length ? 'active' : 'completed'
    const expenseVersions = snapshot.expenses.map((expense) => ({ id: expense._id, revision: expense.revision })).sort((a, b) => a.id.localeCompare(b.id))
    const digest = crypto.createHash('sha256').update(JSON.stringify(expenseVersions)).digest('hex')
    const settlementResult = await transaction.collection(C.settlements).add({ data: { tripId, baseCurrency: trip.baseCurrency || 'CNY', version: trip.ledgerRevision, ledgerRevision: trip.ledgerRevision, memberBalances: preview.summary, expenseVersionDigest: digest, snapshotExpenseCount: expenseVersions.length, status, createdByUserId: openid, createdAt } })
    for (const transfer of preview.transfers) await transaction.collection(C.transfers).add({ data: { ...transfer, id: undefined, fromName: undefined, toName: undefined, settlementId: settlementResult._id, paidAt: null, receivedAt: null } })
    await transaction.collection(C.trips).doc(tripId).update({ data: { activeSettlementId: status === 'active' ? settlementResult._id : null, latestSettlementId: settlementResult._id, status: status === 'active' ? 'settling' : 'settled', updatedAt: createdAt } })
    await transaction.commit()
    return settlementGet(openid, tripId)
  } catch (error) { await transaction.rollback(); throw error }
}

async function transferUpdate(openid, input) {
  const settlement = (await db.collection(C.settlements).doc(input.settlementId).get()).data
  assert(settlement && settlement.status === 'active', 'SETTLEMENT_LOCKED', '结算方案已不可操作')
  const member = await memberFor(openid, settlement.tripId)
  const transfer = (await db.collection(C.transfers).doc(input.transferId).get()).data
  assert(transfer && transfer.settlementId === settlement._id, 'NOT_FOUND', '转账项不存在')
  const trip = (await db.collection(C.trips).doc(settlement.tripId).get()).data
  assert(trip.activeSettlementId === settlement._id, 'SETTLEMENT_LOCKED', '该结算方案已失效')
  if (input.status === 'paid') assert(transfer.status === 'pending' && member._id === transfer.fromMemberId, 'FORBIDDEN', '只有付款方可标记已支付')
  else if (input.status === 'received') assert(transfer.status === 'paid' && member._id === transfer.toMemberId, 'FORBIDDEN', '只有收款方可确认已收款')
  else if (input.status === 'pending') assert(transfer.status === 'paid' && (member._id === transfer.fromMemberId || member.role === 'owner'), 'FORBIDDEN', '只有付款方或创建者可撤销已支付')
  else assert(false, 'VALIDATION_ERROR', '状态转换不合法')
  const transferIds = await transferIdsFor(settlement._id)
  const transaction = await db.startTransaction()
  try {
    const latestSettlement = (await transaction.collection(C.settlements).doc(settlement._id).get()).data
    const latestTrip = (await transaction.collection(C.trips).doc(settlement.tripId).get()).data
    assert(latestSettlement.status === 'active' && latestTrip.activeSettlementId === settlement._id, 'SETTLEMENT_LOCKED', '该结算方案已失效')
    const latest = (await transaction.collection(C.transfers).doc(input.transferId).get()).data
    assert(latest.status === transfer.status, 'REVISION_CONFLICT', '转账状态已变化')
    const latestTransfers = input.status === 'received' ? await readTransfers(transaction, transferIds) : []
    const changedAt = iso()
    const transferPatch = input.status === 'paid'
      ? { status: 'paid', paidAt: changedAt }
      : input.status === 'received'
        ? { status: 'received', receivedAt: changedAt }
        : { status: 'pending', paidAt: null }
    await transaction.collection(C.transfers).doc(input.transferId).update({ data: transferPatch })
    await transaction.collection(C.audits).add({ data: { tripId: settlement.tripId, entityType: 'settlementTransfer', entityId: input.transferId, action: `transfer_${input.status}`, actorUserId: openid, summary: `转账状态 ${transfer.status} -> ${input.status}`, createdAt: changedAt } })
    if (input.status === 'received') {
      assert(latestTransfers.some((item) => item._id === input.transferId), 'DATA_INTEGRITY', '结算转账记录不完整')
      const onlyCurrentRemains = latestTransfers.every((item) => item._id === input.transferId || item.status === 'received')
      if (onlyCurrentRemains) {
        await transaction.collection(C.settlements).doc(settlement._id).update({ data: { status: 'completed', completedAt: iso() } })
        await transaction.collection(C.trips).doc(settlement.tripId).update({ data: { status: 'settled', activeSettlementId: null, updatedAt: iso() } })
      }
    }
    await transaction.commit()
    return settlementGet(openid, settlement.tripId)
  } catch (error) { await transaction.rollback(); throw error }
}

async function inviteCreate(openid, tripId) {
  await memberFor(openid, tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  assert(trip && trip.status !== 'archived', 'FORBIDDEN', '已归档行程为只读')
  const inviteId = randomId()
  const inviteCode = await allocateInviteCode()
  await db.collection(C.invites).add({ data: { inviteId, inviteCode, tripId, status: 'active', useCount: 0, maxUses: 20, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), createdByUserId: openid, createdAt: iso() } })
  return { inviteId, inviteCode, path: `/pages/join/join?inviteId=${inviteId}` }
}

async function inviteGetActive(openid, tripId) {
  await memberFor(openid, tripId, 'owner')
  const invites = await allWhere(C.invites, { tripId })
  const invite = invites.filter((item) => item.status === 'active' && item.expiresAt > iso() && item.useCount < item.maxUses).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!invite) return null
  const inviteCode = await ensureInviteCode(invite)
  return { inviteId: invite.inviteId, inviteCode, path: `/pages/join/join?inviteId=${invite.inviteId}`, expiresAt: invite.expiresAt, useCount: invite.useCount }
}

async function inviteResolveCode(openid, rawCode) {
  const inviteCode = String(rawCode || '').replace(/\D/g, '')
  assert(/^\d{6}$/.test(inviteCode), 'VALIDATION_ERROR', '请输入 6 位匹配码')
  const result = await db.collection(C.invites).where({ inviteCode, status: 'active' }).limit(1).get()
  const invite = result.data[0]
  assert(invite && invite.expiresAt > iso() && invite.useCount < invite.maxUses, 'INVITE_INVALID', '匹配码不正确或已失效')
  const trip = (await db.collection(C.trips).doc(invite.tripId).get()).data
  assert(trip && trip.status !== 'archived', 'INVITE_INVALID', '该行程暂不可加入')
  return { inviteId: invite.inviteId, inviteCode, tripId: invite.tripId, path: `/pages/join/join?inviteId=${invite.inviteId}` }
}

async function inviteGetQr(openid, input) {
  const result = await db.collection(C.invites).where({ inviteId: input.inviteId }).limit(1).get()
  const invite = result.data[0]
  assert(invite && invite.status === 'active' && invite.expiresAt > iso() && invite.useCount < invite.maxUses, 'INVITE_INVALID', '邀请已失效')
  await memberFor(openid, invite.tripId, 'owner')
  const inviteCode = await ensureInviteCode(invite)
  const envVersion = ['develop', 'trial', 'release'].includes(input.envVersion) ? input.envVersion : 'release'
  const qr = await cloud.openapi.wxacode.getUnlimited({
    scene: inviteCode,
    page: 'pages/join/join',
    checkPath: false,
    envVersion,
    width: 430,
  })
  assert(qr && qr.buffer, 'QR_GENERATION_FAILED', '小程序码生成失败')
  const uploaded = await cloud.uploadFile({ cloudPath: `invite-codes/${invite._id}-${envVersion}.png`, fileContent: qr.buffer })
  const urls = await cloud.getTempFileURL({ fileList: [uploaded.fileID] })
  const file = urls.fileList && urls.fileList[0]
  return { inviteCode, fileID: uploaded.fileID, tempFileURL: file && file.tempFileURL ? file.tempFileURL : '' }
}

async function inviteRevoke(openid, inviteId) {
  const result = await db.collection(C.invites).where({ inviteId }).limit(1).get()
  const invite = result.data[0]
  assert(invite && invite.status === 'active', 'INVITE_INVALID', '邀请已失效')
  await memberFor(openid, invite.tripId, 'owner')
  await db.collection(C.invites).doc(invite._id).update({ data: { status: 'revoked', revokedAt: iso() } })
  return { revoked: true }
}

async function invitePreview(openid, inviteId) {
  const inviteResult = await db.collection(C.invites).where({ inviteId }).limit(1).get()
  const invite = inviteResult.data[0]
  assert(invite && invite.status === 'active' && invite.expiresAt > iso() && invite.useCount < invite.maxUses, 'INVITE_INVALID', '邀请已失效')
  const [tripResult, ownerResult, activeMembers] = await Promise.all([
    db.collection(C.trips).doc(invite.tripId).get(),
    db.collection(C.members).where({ tripId: invite.tripId, role: 'owner', status: 'active' }).limit(1).get(),
    allWhere(C.members, { tripId: invite.tripId, status: 'active' }),
  ])
  const trip = tripResult.data
  assert(trip && trip.status !== 'archived', 'INVITE_INVALID', '该行程暂不可加入')
  return { tripId: trip._id, tripName: trip.name, destination: trip.destination || '', ownerName: ownerResult.data[0] ? ownerResult.data[0].displayName : '行程创建者', memberCount: activeMembers.length }
}

async function inviteJoin(openid, input) {
  const inviteResult = await db.collection(C.invites).where({ inviteId: input.inviteId }).limit(1).get()
  const invite = inviteResult.data[0]
  assert(invite && invite.status === 'active' && invite.expiresAt > iso() && invite.useCount < invite.maxUses, 'INVITE_INVALID', '邀请已失效')
  const existing = await db.collection(C.members).where({ tripId: invite.tripId, userId: openid }).limit(1).get()
  if (existing.data.length) return { tripId: invite.tripId, memberId: existing.data[0]._id }
  const activeMembers = await db.collection(C.members).where({ tripId: invite.tripId, status: 'active' }).limit(20).get()
  assert(activeMembers.data.length < 20, 'VALIDATION_ERROR', '行程成员已满')
  const profileResult = await db.collection(C.users).where({ openid }).limit(1).get()
  const profile = profileResult.data[0] || {}
  const displayName = String(input.displayName || profile.displayName || '').trim()
  const avatarUrl = String(input.avatarUrl || profile.avatarUrl || '')
  assert(displayName && displayName.length <= 30, 'VALIDATION_ERROR', '昵称需为 1 至 30 字')
  assert(!avatarUrl || (avatarUrl.startsWith('cloud://') && avatarUrl.length <= 500), 'VALIDATION_ERROR', '头像地址不合法')
  const memberId = joinedMemberId(invite.tripId, openid)
  const transaction = await db.startTransaction()
  try {
    const latestInvite = (await transaction.collection(C.invites).doc(invite._id).get()).data
    assert(latestInvite && latestInvite.status === 'active' && latestInvite.expiresAt > iso() && latestInvite.useCount < latestInvite.maxUses, 'INVITE_INVALID', '邀请已失效')
    const latestTrip = (await transaction.collection(C.trips).doc(invite.tripId).get()).data
    assert(latestTrip && latestTrip.status !== 'archived', 'INVITE_INVALID', '该行程暂不可加入')
    const latestExisting = (await transaction.collection(C.members).doc(memberId).get()).data
    if (latestExisting) {
      await transaction.commit()
      return { tripId: invite.tripId, memberId }
    }
    await transaction.collection(C.members).doc(memberId).set({ data: { tripId: invite.tripId, userId: openid, displayName, avatarUrl, role: 'member', status: 'active', createdAt: iso() } })
    await transaction.collection(C.invites).doc(invite._id).update({ data: { useCount: command.inc(1) } })
    await transaction.commit()
    return { tripId: invite.tripId, memberId }
  } catch (error) { await transaction.rollback(); throw error }
}

const actions = {
  'fx.quote': fxQuote,
  bootstrap,
  'user.updateProfile': updateProfile,
  'trip.list': listTrips,
  'trip.get': (openid, payload) => db.collection(C.trips).doc(payload.tripId).get().then((result) => dashboard(openid, result.data)),
  'trip.create': createTrip,
  'trip.update': updateTrip,
  'trip.archive': (openid, payload) => archiveTrip(openid, payload.tripId),
  'trip.restore': (openid, payload) => restoreTrip(openid, payload.tripId),
  'member.addOffline': createOfflineMember,
  'member.updateOffline': updateOfflineMember,
  'member.updateMyAvatar': updateMyAvatar,
  'member.deactivate': deactivateMember,
  'member.remove': removeMember,
  'member.transferOwner': transferOwner,
  'expense.create': createExpense,
  'expense.get': (openid, payload) => getExpense(openid, payload.expenseId),
  'expense.update': updateExpense,
  'expense.delete': deleteExpense,
  'settlement.preview': (openid, payload) => settlementPreview(openid, payload.tripId),
  'settlement.get': (openid, payload) => settlementGet(openid, payload.tripId),
  'settlement.start': (openid, payload) => settlementStart(openid, payload.tripId),
  'settlement.transfer.update': transferUpdate,
  'invite.create': (openid, payload) => inviteCreate(openid, payload.tripId),
  'invite.getActive': (openid, payload) => inviteGetActive(openid, payload.tripId),
  'invite.resolveCode': (openid, payload) => inviteResolveCode(openid, payload.inviteCode),
  'invite.getQr': inviteGetQr,
  'invite.revoke': (openid, payload) => inviteRevoke(openid, payload.inviteId),
  'invite.preview': (openid, payload) => invitePreview(openid, payload.inviteId),
  'invite.join': inviteJoin,
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  try {
    assert(openid, 'UNAUTHENTICATED', '无法识别微信用户')
    const handler = actions[event.action]
    assert(handler, 'NOT_FOUND', '未知操作')
    return { ok: true, data: await handler(openid, event.payload || {}) }
  } catch (error) {
    console.error('[喵喵旅账 API]', event.action, error.code || error.message)
    return { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.code ? error.message : '服务暂时不可用', details: error.details } }
  }
}
