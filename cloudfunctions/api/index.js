'use strict'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const command = db.command
const C = {
  users: 'users', trips: 'trips', members: 'members', expenses: 'expenses',
  expenseShares: 'expenseShares', settlements: 'settlements', transfers: 'settlementTransfers', audits: 'auditLogs', invites: 'invites',
}

class ApiError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details }
}

const iso = () => new Date().toISOString()
const randomId = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url')
const publicDoc = (doc) => doc && ({ ...doc, id: doc._id, _id: undefined, _openid: undefined })
const assert = (condition, code, message, details) => { if (!condition) throw new ApiError(code, message, details) }

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
  const summary = Object.fromEntries(members.map((member) => [member._id, { memberId: member._id, displayName: member.displayName, paidAmount: 0, owedAmount: 0, netAmount: 0 }]))
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

async function memberFor(openid, tripId, requiredRole) {
  const result = await db.collection(C.members).where({ tripId, userId: openid, status: 'active' }).limit(1).get()
  const member = result.data[0]
  assert(member, 'FORBIDDEN', '你不是该行程的活跃成员')
  if (requiredRole) assert(member.role === requiredRole, 'FORBIDDEN', '只有行程创建者可执行此操作')
  return member
}

async function ledger(tripId) {
  const [members, expenses, shares] = await Promise.all([
    allWhere(C.members, { tripId }),
    allWhere(C.expenses, { tripId, deletedAt: command.eq(null) }),
    allWhere(C.expenseShares, { tripId, deletedAt: command.eq(null) }),
  ])
  const liveExpenseIds = new Set(expenses.map((expense) => expense._id))
  const liveShares = shares.filter((share) => liveExpenseIds.has(share.expenseId))
  return { members, expenses, shares: liveShares, summary: summarize(members, expenses, liveShares) }
}

async function dashboard(openid, trip) {
  await memberFor(openid, trip._id)
  const data = await ledger(trip._id)
  const current = data.members.find((member) => member.userId === openid)
  const mine = data.summary.find((item) => current && item.memberId === current._id)
  return {
    ...publicDoc(trip),
    members: data.members.map(publicDoc), expenses: data.expenses.map(publicDoc).sort((a, b) => b.spentAt.localeCompare(a.spentAt)), summary: data.summary,
    totalAmountFen: data.expenses.reduce((sum, expense) => sum + expense.amountFen, 0), currentMemberId: current && current._id, currentMemberRole: current && current.role,
    myPaidAmountFen: mine ? mine.paidAmount : 0, myNetAmountFen: mine ? mine.netAmount : 0,
  }
}

async function bootstrap(openid) {
  const existing = await db.collection(C.users).where({ openid }).limit(1).get()
  if (!existing.data.length) await db.collection(C.users).add({ data: { openid, displayName: '微信用户', avatarUrl: '', createdAt: iso() } })
  return { userId: openid, mode: 'cloud' }
}

async function listTrips(openid) {
  const memberships = await allWhere(C.members, { userId: openid })
  if (!memberships.length) return []
  const result = await db.collection(C.trips).where({ _id: command.in(memberships.map((item) => item.tripId)) }).limit(20).get()
  return Promise.all(result.data.map((trip) => dashboard(openid, trip)))
}

async function createTrip(openid, input) {
  assert(typeof input.name === 'string' && input.name.trim() && input.name.trim().length <= 30, 'VALIDATION_ERROR', '请填写 1 至 30 字的行程名称')
  const companions = Array.isArray(input.companions) ? input.companions.map((name) => String(name).trim()).filter(Boolean).slice(0, 19) : []
  const transaction = await db.startTransaction()
  try {
    const createdAt = iso()
    const tripResult = await transaction.collection(C.trips).add({ data: { name: input.name.trim(), destination: String(input.destination || '').trim(), startDate: input.startDate || '', endDate: input.endDate || '', ownerUserId: openid, status: 'active', ledgerRevision: 0, activeSettlementId: null, latestSettlementId: null, createdAt, updatedAt: createdAt } })
    await transaction.collection(C.members).add({ data: { tripId: tripResult._id, userId: openid, displayName: String(input.ownerName || '微信用户').trim(), role: 'owner', status: 'active', createdAt } })
    for (let index = 0; index < companions.length; index += 1) await transaction.collection(C.members).add({ data: { tripId: tripResult._id, userId: null, displayName: companions[index], role: 'member', status: 'active', createdAt: new Date(Date.now() + index + 1).toISOString() } })
    await transaction.commit()
    return { id: tripResult._id }
  } catch (error) { await transaction.rollback(); throw error }
}

async function updateTrip(openid, input) {
  await memberFor(openid, input.tripId, 'owner')
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
  const name = String(input.displayName || '').trim()
  assert(name && name.length <= 30, 'VALIDATION_ERROR', '成员名称需为 1 至 30 字')
  await db.collection(C.members).doc(target._id).update({ data: { displayName: name } })
  await db.collection(C.audits).add({ data: { tripId: target.tripId, entityType: 'member', entityId: target._id, action: 'offline_member_renamed', actorUserId: openid, summary: `成员改名：${target.displayName} -> ${name}`, createdAt: iso() } })
  return { ...publicDoc(target), displayName: name }
}

async function deactivateMember(openid, input) {
  const target = (await db.collection(C.members).doc(input.memberId).get()).data
  assert(target && target.role !== 'owner', 'NOT_FOUND', '成员不存在或不可停用')
  await memberFor(openid, target.tripId, 'owner')
  await db.collection(C.members).doc(target._id).update({ data: { status: 'inactive', deactivatedAt: iso() } })
  await db.collection(C.audits).add({ data: { tripId: target.tripId, entityType: 'member', entityId: target._id, action: 'member_deactivated', actorUserId: openid, summary: `停用成员 ${target.displayName}`, createdAt: iso() } })
  return { ...publicDoc(target), status: 'inactive' }
}

async function createExpense(openid, input) {
  const actor = await memberFor(openid, input.tripId)
  assert(typeof input.clientRequestId === 'string' && input.clientRequestId.length >= 8, 'VALIDATION_ERROR', '请求标识不合法')
  const duplicate = await db.collection(C.expenses).where({ tripId: input.tripId, createdByUserId: openid, clientRequestId: input.clientRequestId }).limit(1).get()
  if (duplicate.data.length) return publicDoc(duplicate.data[0])
  const trip = (await db.collection(C.trips).doc(input.tripId).get()).data
  assert(['active', 'needs_settlement', 'settled'].includes(trip.status), 'SETTLEMENT_LOCKED', '当前结算状态不允许改账')
  const members = await allWhere(C.members, { tripId: input.tripId, status: 'active' })
  const memberIds = new Set(members.map((member) => member._id))
  assert(memberIds.has(input.payerMemberId), 'VALIDATION_ERROR', '付款人不合法')
  const selected = members.filter((member) => input.participantMemberIds.includes(member._id))
  assert(selected.length === input.participantMemberIds.length, 'VALIDATION_ERROR', '参与人不合法')
  const shares = splitAmount(input.amountFen, selected, input.splitMode, input.units || {})
  const transaction = await db.startTransaction()
  try {
    const latestTrip = (await transaction.collection(C.trips).doc(input.tripId).get()).data
    assert(['active', 'needs_settlement', 'settled'].includes(latestTrip.status), 'SETTLEMENT_LOCKED', '当前结算状态不允许改账')
    const createdAt = iso()
    const expenseResult = await transaction.collection(C.expenses).add({ data: { tripId: input.tripId, payerMemberId: input.payerMemberId, amountFen: input.amountFen, category: input.category || 'other', note: String(input.note || '').slice(0, 100), spentAt: input.spentAt || createdAt, splitMode: input.splitMode || 'equal', revision: 1, clientRequestId: input.clientRequestId, createdByUserId: openid, updatedByUserId: openid, deletedAt: null, createdAt, updatedAt: createdAt } })
    for (const share of shares) await transaction.collection(C.expenseShares).add({ data: { ...share, tripId: input.tripId, expenseId: expenseResult._id, deletedAt: null } })
    await transaction.collection(C.trips).doc(input.tripId).update({ data: { ledgerRevision: command.inc(1), status: 'needs_settlement', activeSettlementId: null, updatedAt: createdAt } })
    await transaction.collection(C.audits).add({ data: { tripId: input.tripId, entityType: 'expense', entityId: expenseResult._id, action: 'created', actorUserId: openid, summary: `新增账单 ${input.amountFen} 分`, createdAt } })
    await transaction.commit()
    return { id: expenseResult._id, createdByMemberId: actor._id }
  } catch (error) { await transaction.rollback(); throw error }
}

async function getExpense(openid, expenseId) {
  const expenseResult = await db.collection(C.expenses).doc(expenseId).get()
  const expense = expenseResult.data
  assert(expense && !expense.deletedAt, 'NOT_FOUND', '账单不存在')
  await memberFor(openid, expense.tripId)
  const [shares, members] = await Promise.all([
    allWhere(C.expenseShares, { expenseId, deletedAt: command.eq(null) }),
    allWhere(C.members, { tripId: expense.tripId }),
  ])
  return {
    ...publicDoc(expense),
    members: members.map(publicDoc),
    shares: Object.fromEntries(shares.map((share) => [share.memberId, share.amountFen])),
    shareUnits: Object.fromEntries(shares.map((share) => [share.memberId, share.shareUnits])),
  }
}

async function updateExpense(openid, input) {
  const expenseResult = await db.collection(C.expenses).doc(input.expenseId).get()
  const expense = expenseResult.data
  assert(expense && !expense.deletedAt, 'NOT_FOUND', '账单不存在')
  const actor = await memberFor(openid, expense.tripId)
  assert(actor.role === 'owner' || expense.createdByUserId === openid, 'FORBIDDEN', '你无权编辑这笔账单')
  assert(expense.revision === input.expectedRevision, 'REVISION_CONFLICT', '账单已被修改，请刷新后重试', publicDoc(expense))
  const trip = (await db.collection(C.trips).doc(expense.tripId).get()).data
  assert(['active', 'needs_settlement'].includes(trip.status), 'SETTLEMENT_LOCKED', '当前结算状态不允许改账')
  const members = await allWhere(C.members, { tripId: expense.tripId, status: 'active' })
  const selected = members.filter((member) => input.participantMemberIds.includes(member._id))
  assert(selected.length === input.participantMemberIds.length, 'VALIDATION_ERROR', '参与人不合法')
  assert(members.some((member) => member._id === input.payerMemberId), 'VALIDATION_ERROR', '付款人不合法')
  const shares = splitAmount(input.amountFen, selected, input.splitMode, input.units || {})
  const oldShares = await allWhere(C.expenseShares, { expenseId: expense._id, deletedAt: command.eq(null) })
  const transaction = await db.startTransaction()
  try {
    const latest = (await transaction.collection(C.expenses).doc(expense._id).get()).data
    assert(latest.revision === input.expectedRevision && !latest.deletedAt, 'REVISION_CONFLICT', '账单已被修改，请刷新后重试')
    const updatedAt = iso()
    await transaction.collection(C.expenses).doc(expense._id).update({ data: { payerMemberId: input.payerMemberId, amountFen: input.amountFen, category: input.category || 'other', note: String(input.note || '').slice(0, 100), spentAt: input.spentAt, splitMode: input.splitMode || 'equal', revision: command.inc(1), updatedByUserId: openid, updatedAt } })
    for (const share of oldShares) await transaction.collection(C.expenseShares).doc(share._id).update({ data: { deletedAt: updatedAt } })
    for (const share of shares) await transaction.collection(C.expenseShares).add({ data: { ...share, tripId: expense.tripId, expenseId: expense._id, deletedAt: null } })
    await transaction.collection(C.trips).doc(expense.tripId).update({ data: { ledgerRevision: command.inc(1), status: 'needs_settlement', activeSettlementId: null, updatedAt } })
    await transaction.collection(C.audits).add({ data: { tripId: expense.tripId, entityType: 'expense', entityId: expense._id, action: 'updated', actorUserId: openid, summary: `修改账单：${expense.amountFen} 分 -> ${input.amountFen} 分`, createdAt: updatedAt } })
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
  assert(['active', 'needs_settlement'].includes(trip.status), 'SETTLEMENT_LOCKED', '当前结算状态不允许删除账单')
  const transaction = await db.startTransaction()
  try {
    const latest = (await transaction.collection(C.expenses).doc(expense._id).get()).data
    assert(latest.revision === input.expectedRevision && !latest.deletedAt, 'REVISION_CONFLICT', '账单已被修改，请刷新后重试')
    const deletedAt = iso()
    await transaction.collection(C.expenses).doc(expense._id).update({ data: { deletedAt, revision: command.inc(1), updatedByUserId: openid, updatedAt: deletedAt } })
    await transaction.collection(C.trips).doc(expense.tripId).update({ data: { ledgerRevision: command.inc(1), status: 'needs_settlement', activeSettlementId: null, updatedAt: deletedAt } })
    await transaction.collection(C.audits).add({ data: { tripId: expense.tripId, entityType: 'expense', entityId: expense._id, action: 'deleted', actorUserId: openid, summary: `删除账单 ${expense.amountFen} 分`, createdAt: deletedAt } })
    await transaction.commit()
    return { deleted: true }
  } catch (error) { await transaction.rollback(); throw error }
}

async function settlementPreview(openid, tripId) {
  const current = await memberFor(openid, tripId)
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  const data = await ledger(tripId)
  const names = Object.fromEntries(data.members.map((member) => [member._id, member.displayName]))
  return { status: 'preview', ledgerRevision: trip.ledgerRevision, summary: data.summary, currentMemberId: current._id, currentMemberRole: current.role, transfers: settle(data.summary).map((item, index) => ({ ...item, id: `preview_${index}`, fromName: names[item.fromMemberId], toName: names[item.toMemberId] })) }
}

async function settlementGet(openid, tripId) {
  const current = await memberFor(openid, tripId)
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  if (!trip.latestSettlementId) return settlementPreview(openid, tripId)
  const settlement = (await db.collection(C.settlements).doc(trip.latestSettlementId).get()).data
  const [transfers, members] = await Promise.all([allWhere(C.transfers, { settlementId: settlement._id }), allWhere(C.members, { tripId })])
  const names = Object.fromEntries(members.map((member) => [member._id, member.displayName]))
  return { ...publicDoc(settlement), currentMemberId: current._id, currentMemberRole: current.role, transfers: transfers.map((item) => ({ ...publicDoc(item), fromName: names[item.fromMemberId], toName: names[item.toMemberId] })) }
}

async function settlementStart(openid, tripId) {
  await memberFor(openid, tripId, 'owner')
  const trip = (await db.collection(C.trips).doc(tripId).get()).data
  const existing = await db.collection(C.settlements).where({ tripId, ledgerRevision: trip.ledgerRevision, status: 'active' }).limit(1).get()
  if (existing.data.length) return settlementGet(openid, tripId)
  const preview = await settlementPreview(openid, tripId)
  const transaction = await db.startTransaction()
  try {
    const latestTrip = (await transaction.collection(C.trips).doc(tripId).get()).data
    assert(latestTrip.ledgerRevision === trip.ledgerRevision, 'LEDGER_CHANGED', '账本已变化，请刷新后重试')
    const createdAt = iso()
    const status = preview.transfers.length ? 'active' : 'completed'
    const digest = crypto.createHash('sha256').update(JSON.stringify(preview.summary)).digest('hex')
    const settlementResult = await transaction.collection(C.settlements).add({ data: { tripId, version: trip.ledgerRevision, ledgerRevision: trip.ledgerRevision, memberBalances: preview.summary, expenseVersionDigest: digest, snapshotExpenseCount: (await allWhere(C.expenses, { tripId, deletedAt: command.eq(null) })).length, status, createdByUserId: openid, createdAt } })
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
  if (input.status === 'paid') assert(transfer.status === 'pending' && member._id === transfer.fromMemberId, 'FORBIDDEN', '只有付款方可标记已支付')
  else if (input.status === 'received') assert(transfer.status === 'paid' && member._id === transfer.toMemberId, 'FORBIDDEN', '只有收款方可确认已收款')
  else if (input.status === 'pending') assert(transfer.status === 'paid' && (member._id === transfer.fromMemberId || member.role === 'owner'), 'FORBIDDEN', '只有付款方或创建者可撤销已支付')
  else assert(false, 'VALIDATION_ERROR', '状态转换不合法')
  const transaction = await db.startTransaction()
  try {
    const latest = (await transaction.collection(C.transfers).doc(input.transferId).get()).data
    assert(latest.status === transfer.status, 'REVISION_CONFLICT', '转账状态已变化')
    const changedAt = iso()
    const transferPatch = input.status === 'paid'
      ? { status: 'paid', paidAt: changedAt }
      : input.status === 'received'
        ? { status: 'received', receivedAt: changedAt }
        : { status: 'pending', paidAt: null }
    await transaction.collection(C.transfers).doc(input.transferId).update({ data: transferPatch })
    await transaction.collection(C.audits).add({ data: { tripId: settlement.tripId, entityType: 'settlementTransfer', entityId: input.transferId, action: `transfer_${input.status}`, actorUserId: openid, summary: `转账状态 ${transfer.status} -> ${input.status}`, createdAt: changedAt } })
    if (input.status === 'received') {
      const remaining = await transaction.collection(C.transfers).where({ settlementId: settlement._id, status: command.neq('received') }).get()
      const onlyCurrentRemains = remaining.data.every((item) => item._id === input.transferId)
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
  const inviteId = randomId()
  await db.collection(C.invites).add({ data: { inviteId, tripId, status: 'active', useCount: 0, maxUses: 20, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), createdByUserId: openid, createdAt: iso() } })
  return { inviteId, path: `/pages/join/join?inviteId=${inviteId}` }
}

async function inviteJoin(openid, input) {
  const inviteResult = await db.collection(C.invites).where({ inviteId: input.inviteId, status: 'active' }).limit(1).get()
  const invite = inviteResult.data[0]
  assert(invite && invite.expiresAt > iso() && invite.useCount < invite.maxUses, 'INVITE_INVALID', '邀请已失效')
  const existing = await db.collection(C.members).where({ tripId: invite.tripId, userId: openid }).limit(1).get()
  if (existing.data.length) return { tripId: invite.tripId, memberId: existing.data[0]._id }
  const transaction = await db.startTransaction()
  try {
    const memberResult = await transaction.collection(C.members).add({ data: { tripId: invite.tripId, userId: openid, displayName: String(input.displayName || '微信成员').slice(0, 30), role: 'member', status: 'active', createdAt: iso() } })
    await transaction.collection(C.invites).doc(invite._id).update({ data: { useCount: command.inc(1) } })
    await transaction.commit()
    return { tripId: invite.tripId, memberId: memberResult._id }
  } catch (error) { await transaction.rollback(); throw error }
}

const actions = {
  bootstrap,
  'trip.list': listTrips,
  'trip.get': (openid, payload) => db.collection(C.trips).doc(payload.tripId).get().then((result) => dashboard(openid, result.data)),
  'trip.create': createTrip,
  'trip.update': updateTrip,
  'trip.archive': (openid, payload) => archiveTrip(openid, payload.tripId),
  'trip.restore': (openid, payload) => restoreTrip(openid, payload.tripId),
  'member.addOffline': createOfflineMember,
  'member.updateOffline': updateOfflineMember,
  'member.deactivate': deactivateMember,
  'expense.create': createExpense,
  'expense.get': (openid, payload) => getExpense(openid, payload.expenseId),
  'expense.update': updateExpense,
  'expense.delete': deleteExpense,
  'settlement.preview': (openid, payload) => settlementPreview(openid, payload.tripId),
  'settlement.get': (openid, payload) => settlementGet(openid, payload.tripId),
  'settlement.start': (openid, payload) => settlementStart(openid, payload.tripId),
  'settlement.transfer.update': transferUpdate,
  'invite.create': (openid, payload) => inviteCreate(openid, payload.tripId),
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
    console.error('[TripSplit API]', event.action, error.code || error.message)
    return { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.code ? error.message : '服务暂时不可用', details: error.details } }
  }
}
