'use strict'

const { summarizeLedger } = require('../domain/ledger')
const { splitEqual, splitByUnits } = require('../domain/split')
const { buildSettlementTransfers } = require('../domain/settlement')
const money = require('../domain/currency')

const STORAGE_KEY = 'tripsplit.demo.v1'
const CURRENT_USER_ID = 'demo-user'
const now = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const load = () => {
  const state = wx.getStorageSync(STORAGE_KEY) || {}
  return {
    trips: [], members: [], expenses: [], settlements: [], audits: [],
    ...state,
    audits: state.audits || [],
    profile: { userId: CURRENT_USER_ID, displayName: '', avatarUrl: '', profileComplete: false, ...(state.profile || {}) },
  }
}
const save = (state) => wx.setStorageSync(STORAGE_KEY, state)
const clone = (value) => JSON.parse(JSON.stringify(value))
const allTripMembers = (state, tripId) => state.members.filter((member) => member.tripId === tripId)
const tripMembers = (state, tripId) => state.members.filter((member) => member.tripId === tripId && member.status === 'active')
const tripExpenses = (state, tripId) => state.expenses.filter((expense) => expense.tripId === tripId && !expense.deletedAt)
const getCurrentMember = (state, tripId) => state.members.find((member) => member.tripId === tripId && member.userId === CURRENT_USER_ID)
const completedSettlements = (state, tripId) => state.settlements.filter((item) => item.tripId === tripId && item.status === 'completed')
const isSettledExpense = (state, expense) => completedSettlements(state, expense.tripId).some((settlement) => Number.isInteger(expense.createdLedgerRevision)
  ? expense.createdLedgerRevision <= settlement.ledgerRevision
  : expense.createdAt <= settlement.createdAt)

function buildDashboard(state, trip) {
  const members = allTripMembers(state, trip.id)
  const expenses = tripExpenses(state, trip.id)
  const memberAvatars = Object.fromEntries(members.map((member) => [member.id, member.avatarUrl || '']))
  const summary = summarizeLedger(members, expenses, completedSettlements(state, trip.id)).map((item) => ({ ...item, avatarUrl: memberAvatars[item.memberId] || '' }))
  const currentMember = getCurrentMember(state, trip.id)
  const mine = summary.find((item) => currentMember && item.memberId === currentMember.id)
  return {
    ...clone(trip), baseCurrency: trip.baseCurrency || 'CNY',
    members: clone(members),
    expenses: clone(expenses).sort((a, b) => b.spentAt.localeCompare(a.spentAt)),
    summary,
    totalAmountFen: expenses.reduce((sum, expense) => sum + expense.amountFen, 0),
    currentMemberId: currentMember && currentMember.id,
    myPaidAmountFen: mine ? mine.paidAmount : 0,
    myOwedAmountFen: mine ? mine.owedAmount : 0,
    myNetAmountFen: mine ? mine.netAmount : 0,
    currentMemberRole: currentMember && currentMember.role,
    currentMemberStatus: currentMember && currentMember.status,
  }
}

function prepareLedgerWrite(state, trip) {
  if (!['active', 'needs_settlement', 'settled', 'settling'].includes(trip.status)) throw new Error('当前结算状态不允许改账')
  if (trip.status !== 'settling') return
  const settlement = state.settlements.find((item) => item.id === trip.activeSettlementId && item.status === 'active')
  if (!settlement) throw new Error('进行中的结算不存在')
  if (settlement.transfers.some((item) => item.status !== 'pending')) throw new Error('已有转账被标记支付，暂不能改账')
  settlement.status = 'invalidated'
  settlement.invalidatedAt = now()
}

function addAudit(state, tripId, entityType, entityId, action, summary) {
  state.audits.push({ id: id('audit'), tripId, entityType, entityId, action, actorUserId: CURRENT_USER_ID, actorName: 'Bill', summary, createdAt: now() })
}

function validateExpenseFields(input) {
  if (!['food', 'transport', 'stay', 'ticket', 'shopping', 'other'].includes(input.category || 'other')) throw new Error('账单分类不合法')
  if (String(input.note || '').length > 100) throw new Error('备注最多 100 字')
  if (typeof input.spentAt !== 'string' || !Number.isFinite(Date.parse(input.spentAt))) throw new Error('消费时间不合法')
}

async function bootstrap() {
  const state = load()
  save(state)
  return { mode: 'demo', ...clone(state.profile) }
}

async function updateProfile(input) {
  const state = load()
  const displayName = String(input.displayName || '').trim()
  const avatarUrl = String(input.avatarUrl || '')
  if (!displayName || displayName.length > 30) throw new Error('昵称需为 1 至 30 字')
  if (!avatarUrl) throw new Error('请选择微信头像')
  state.profile = { userId: CURRENT_USER_ID, displayName, avatarUrl, profileComplete: true, updatedAt: now() }
  state.members.filter((member) => member.userId === CURRENT_USER_ID).forEach((member) => {
    member.displayName = displayName
    member.avatarUrl = avatarUrl
    member.updatedAt = state.profile.updatedAt
  })
  save(state)
  return clone(state.profile)
}

async function listTrips() {
  const state = load()
  return state.trips.map((trip) => buildDashboard(state, trip))
}

async function getTrip(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip) throw new Error('行程不存在')
  return buildDashboard(state, trip)
}

async function createTrip(input) {
  const baseCurrency = money.currency(input.baseCurrency || 'CNY').code
  const state = load()
  if (!input.name || !input.name.trim() || input.name.trim().length > 30) throw new Error('请填写 1 至 30 字的行程名称')
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw new Error('结束日期不能早于开始日期')
  const ownerName = String(input.ownerName || state.profile.displayName || '微信用户').trim()
  if (!ownerName || ownerName.length > 30) throw new Error('行程昵称需为 1 至 30 字')
  const createdAt = now()
  const tripId = id('trip')
  const trip = { id: tripId, baseCurrency, name: input.name.trim(), destination: (input.destination || '').trim(), startDate: input.startDate || '', endDate: input.endDate || '', ownerUserId: CURRENT_USER_ID, status: 'active', ledgerRevision: 0, createdAt, updatedAt: createdAt }
  state.trips.push(trip)
  state.members.push({ id: id('member'), tripId, userId: CURRENT_USER_ID, displayName: ownerName, avatarUrl: input.avatarUrl || state.profile.avatarUrl || '', role: 'owner', status: 'active', createdAt })
  ;(input.companions || []).filter(Boolean).forEach((displayName, index) => {
    state.members.push({ id: id('member'), tripId, userId: null, displayName, role: 'member', status: 'active', createdAt: new Date(Date.now() + index + 1).toISOString() })
  })
  save(state)
  return clone(trip)
}

async function updateTrip(input) {
  const state = load()
  const trip = state.trips.find((item) => item.id === input.tripId)
  if (!trip) throw new Error('行程不存在')
  if (input.baseCurrency && input.baseCurrency !== (trip.baseCurrency || 'CNY')) throw new Error('行程结算币种创建后不可修改')
  prepareLedgerWrite(state, trip)
  if (tripExpenses(state, input.tripId).length >= 5000) throw new Error('单个行程最多 5,000 笔有效账单')
  const name = String(input.name || '').trim()
  if (!name || name.length > 30) throw new Error('请填写 1 至 30 字的行程名称')
  Object.assign(trip, { name, destination: String(input.destination || '').trim(), startDate: input.startDate || '', endDate: input.endDate || '', updatedAt: now() })
  save(state)
  return clone(trip)
}

async function archiveTrip(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip) throw new Error('行程不存在')
  if (trip.status === 'archived') throw new Error('行程已归档')
  if (trip.status === 'settling') throw new Error('结算进行中，不能归档')
  trip.statusBeforeArchive = trip.status
  trip.status = 'archived'
  trip.updatedAt = now()
  save(state)
  return clone(trip)
}

async function restoreTrip(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip || trip.status !== 'archived') throw new Error('行程未归档')
  trip.status = trip.statusBeforeArchive || 'active'
  delete trip.statusBeforeArchive
  trip.updatedAt = now()
  save(state)
  return clone(trip)
}

async function createExpense(input) {
  const state = load()
  const duplicate = state.expenses.find((expense) => expense.tripId === input.tripId && expense.createdByUserId === CURRENT_USER_ID && expense.clientRequestId === input.clientRequestId)
  if (duplicate) return clone(duplicate)
  const trip = state.trips.find((item) => item.id === input.tripId)
  if (!trip) throw new Error('行程不存在')
  validateExpenseFields(input)
  const monetary = money.normalizeFx(input, trip.baseCurrency || 'CNY')
  input = { ...input, amountFen: monetary.amountFen }
  const members = tripMembers(state, input.tripId)
  const selected = members.filter((member) => input.participantMemberIds.includes(member.id))
  if (selected.length !== input.participantMemberIds.length) throw new Error('参与人不合法')
  const shares = input.splitMode === 'units'
    ? splitByUnits(input.amountFen, selected.map((member) => ({ ...member, units: input.units[member.id] })))
    : splitEqual(input.amountFen, selected)
  prepareLedgerWrite(state, trip)
  if (tripExpenses(state, input.tripId).length >= 5000) throw new Error('单个行程最多 5,000 笔有效账单')
  const createdAt = now()
  const expense = { ...monetary, id: id('expense'), tripId: input.tripId, payerMemberId: input.payerMemberId, category: input.category, note: input.note || '', spentAt: input.spentAt || createdAt, splitMode: input.splitMode, shares, shareUnits: input.splitMode === 'units' ? { ...input.units } : {}, revision: 1, clientRequestId: input.clientRequestId, createdByUserId: CURRENT_USER_ID, createdAt, updatedAt: createdAt }
  expense.createdLedgerRevision = trip.ledgerRevision + 1
  state.expenses.push(expense)
  trip.ledgerRevision += 1
  trip.status = 'needs_settlement'
  trip.activeSettlementId = null
  trip.updatedAt = createdAt
  addAudit(state, trip.id, 'expense', expense.id, 'created', `新增账单 ${money.amountText(input.amountFen, monetary.baseCurrency)}（${monetary.fx.source}）`)
  save(state)
  return clone(expense)
}

async function getExpense(expenseId) {
  const state = load()
  const expense = state.expenses.find((item) => item.id === expenseId && !item.deletedAt)
  if (!expense) throw new Error('账单不存在')
  const members = allTripMembers(state, expense.tripId)
  const auditEvents = state.audits.filter((audit) => audit.entityType === 'expense' && audit.entityId === expense.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const current = getCurrentMember(state, expense.tripId)
  return { ...clone(expense), members: clone(members), auditEvents: clone(auditEvents), canEdit: current && current.status === 'active' && (current.role === 'owner' || expense.createdByUserId === CURRENT_USER_ID) && !isSettledExpense(state, expense) }
}

async function updateExpense(input) {
  const state = load()
  const expense = state.expenses.find((item) => item.id === input.expenseId && !item.deletedAt)
  if (!expense) throw new Error('账单不存在')
  if (expense.revision !== input.expectedRevision) {
    const error = new Error('账单已被修改，请刷新后重试')
    error.code = 'REVISION_CONFLICT'
    throw error
  }
  validateExpenseFields(input)
  const trip = state.trips.find((item) => item.id === expense.tripId)
  if (trip.status === 'settled' || isSettledExpense(state, expense)) throw new Error('已结算账单不可修改，请新增调整账单')
  if (!input.fx && expense.originalCurrency && expense.originalCurrency !== 'CNY') throw new Error('请更新小程序后编辑外币账单')
  const monetary = money.normalizeFx(input, trip.baseCurrency || 'CNY')
  input = { ...input, amountFen: monetary.amountFen }
  prepareLedgerWrite(state, trip)
  const historicalMemberIds = new Set([expense.payerMemberId, ...Object.keys(expense.shares)])
  const members = allTripMembers(state, expense.tripId).filter((member) => member.status === 'active' || historicalMemberIds.has(member.id))
  const selected = members.filter((member) => input.participantMemberIds.includes(member.id))
  if (selected.length !== input.participantMemberIds.length) throw new Error('参与人不合法')
  if (!members.some((member) => member.id === input.payerMemberId)) throw new Error('付款人不合法')
  const shares = input.splitMode === 'units'
    ? splitByUnits(input.amountFen, selected.map((member) => ({ ...member, units: input.units[member.id] })))
    : splitEqual(input.amountFen, selected)
  Object.assign(expense, { ...monetary, payerMemberId: input.payerMemberId, category: input.category, note: input.note || '', spentAt: input.spentAt, splitMode: input.splitMode, shares, shareUnits: input.splitMode === 'units' ? { ...input.units } : {}, revision: expense.revision + 1, updatedAt: now() })
  trip.ledgerRevision += 1
  trip.status = 'needs_settlement'
  trip.activeSettlementId = null
  trip.updatedAt = now()
  addAudit(state, trip.id, 'expense', expense.id, 'updated', `修改账单为 ${money.amountText(input.amountFen, monetary.baseCurrency)}（${monetary.fx.source}）`)
  save(state)
  return clone(expense)
}

async function deleteExpense(input) {
  const state = load()
  const expense = state.expenses.find((item) => item.id === input.expenseId && !item.deletedAt)
  if (!expense) throw new Error('账单不存在')
  if (expense.revision !== input.expectedRevision) throw new Error('账单已被修改，请刷新后重试')
  const trip = state.trips.find((item) => item.id === expense.tripId)
  if (trip.status === 'settled' || isSettledExpense(state, expense)) throw new Error('已结算账单不可删除，请新增调整账单')
  prepareLedgerWrite(state, trip)
  expense.deletedAt = now()
  expense.revision += 1
  trip.ledgerRevision += 1
  trip.status = 'needs_settlement'
  trip.activeSettlementId = null
  trip.updatedAt = now()
  addAudit(state, trip.id, 'expense', expense.id, 'deleted', `删除账单 ${money.amountText(expense.amountFen, expense.baseCurrency || 'CNY')}`)
  save(state)
  return { deleted: true }
}

async function createOfflineMember(tripId, input) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip) throw new Error('行程不存在')
  const name = String(input.displayName || '').trim()
  if (!name || name.length > 30) throw new Error('成员名称需为 1 至 30 字')
  if (allTripMembers(state, tripId).filter((item) => item.status === 'active').length >= 20) throw new Error('每个行程最多 20 名成员')
  const member = { id: id('member'), tripId, userId: null, displayName: name, role: 'member', status: 'active', createdAt: now() }
  state.members.push(member)
  save(state)
  return clone(member)
}

async function updateOfflineMember(input) {
  const state = load()
  const member = state.members.find((item) => item.id === input.memberId && item.userId === null)
  if (!member) throw new Error('离线成员不存在')
  const name = String(input.displayName || '').trim()
  if (!name || name.length > 30) throw new Error('成员名称需为 1 至 30 字')
  member.displayName = name
  save(state)
  return clone(member)
}

async function deactivateMember(memberId) {
  const state = load()
  const member = state.members.find((item) => item.id === memberId && item.role !== 'owner')
  if (!member) throw new Error('成员不存在或不可停用')
  member.status = 'inactive'
  save(state)
  return clone(member)
}

async function removeMember(memberId) {
  const state = load()
  const memberIndex = state.members.findIndex((item) => item.id === memberId && item.role !== 'owner')
  if (memberIndex < 0) throw new Error('成员不存在或不可移除')
  const member = state.members[memberIndex]
  const hasExpense = tripExpenses(state, member.tripId).some((expense) => expense.payerMemberId === member.id || Object.prototype.hasOwnProperty.call(expense.shares, member.id))
  if (hasExpense) throw new Error('该成员已有账单，只能停用')
  state.members.splice(memberIndex, 1)
  addAudit(state, member.tripId, 'member', member.id, 'member_removed', `移除成员 ${member.displayName}`)
  save(state)
  return { removed: true }
}

async function transferOwner(input) {
  const state = load()
  const current = getCurrentMember(state, input.tripId)
  const target = state.members.find((item) => item.id === input.memberId && item.tripId === input.tripId)
  if (!current || current.role !== 'owner' || !target || !target.userId || target.status !== 'active') throw new Error('只能转让给活跃微信成员')
  current.role = 'member'
  target.role = 'owner'
  const trip = state.trips.find((item) => item.id === input.tripId)
  trip.ownerUserId = target.userId
  addAudit(state, input.tripId, 'trip', input.tripId, 'owner_transferred', `创建者转让给 ${target.displayName}`)
  save(state)
  return { ownerMemberId: target.id }
}

async function uploadAvatar(tempFilePath) { return tempFilePath }

async function updateMyAvatar(tripId, tempFilePath) {
  const state = load()
  const member = getCurrentMember(state, tripId)
  if (!member || member.status !== 'active') throw new Error('你不是该行程的活跃成员')
  member.avatarUrl = tempFilePath
  state.profile.avatarUrl = tempFilePath
  state.profile.profileComplete = Boolean(state.profile.displayName && tempFilePath)
  addAudit(state, tripId, 'member', member.id, 'avatar_updated', '更新个人头像')
  save(state)
  return clone(member)
}

async function previewSettlement(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip) throw new Error('行程不存在')
  const members = allTripMembers(state, tripId)
  const memberAvatars = Object.fromEntries(members.map((member) => [member.id, member.avatarUrl || '']))
  const summary = summarizeLedger(members, tripExpenses(state, tripId), completedSettlements(state, tripId)).map((item) => ({ ...item, avatarUrl: memberAvatars[item.memberId] || '' }))
  const names = Object.fromEntries(members.map((member) => [member.id, member.displayName]))
  const current = getCurrentMember(state, tripId)
  return { status: 'preview', baseCurrency: trip.baseCurrency || 'CNY', ledgerRevision: trip.ledgerRevision, summary, currentMemberId: current && current.id, currentMemberRole: current && current.role, currentMemberStatus: current && current.status, transfers: buildSettlementTransfers(summary).map((transfer, index) => ({ ...transfer, id: `preview_${index}`, fromName: names[transfer.fromMemberId], toName: names[transfer.toMemberId] })) }
}

async function startSettlement(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip) throw new Error('行程不存在')
  const existing = state.settlements.find((item) => item.tripId === tripId && item.ledgerRevision === trip.ledgerRevision && item.status === 'active')
  if (existing) return clone(existing)
  if (!['active', 'needs_settlement'].includes(trip.status)) throw new Error('当前行程状态不允许发起结算')
  const preview = await previewSettlement(tripId)
  const settlement = { ...preview, id: id('settlement'), tripId, status: preview.transfers.length ? 'active' : 'completed', transfers: preview.transfers.map((transfer) => ({ ...transfer, id: id('transfer') })), createdAt: now() }
  state.settlements.push(settlement)
  trip.activeSettlementId = settlement.status === 'active' ? settlement.id : null
  trip.latestSettlementId = settlement.id
  trip.status = settlement.status === 'completed' ? 'settled' : 'settling'
  save(state)
  return clone(settlement)
}

async function getSettlement(tripId) {
  const state = load()
  const trip = state.trips.find((item) => item.id === tripId)
  if (!trip || !trip.latestSettlementId) return previewSettlement(tripId)
  const stored = state.settlements.find((item) => item.id === trip.latestSettlementId)
  if (!stored || stored.status === 'invalidated' || stored.ledgerRevision !== trip.ledgerRevision) return previewSettlement(tripId)
  const settlement = clone(stored)
  const current = getCurrentMember(state, tripId)
  return { ...settlement, currentMemberId: current && current.id, currentMemberRole: current && current.role, currentMemberStatus: current && current.status }
}

async function updateTransferStatus(input) {
  const state = load()
  const settlement = state.settlements.find((item) => item.id === input.settlementId)
  if (!settlement || settlement.status !== 'active') throw new Error('结算方案已不可操作')
  const transfer = settlement.transfers.find((item) => item.id === input.transferId)
  if (!transfer) throw new Error('转账项不存在')
  const transitions = { pending: ['paid'], paid: ['pending', 'received'], received: [] }
  if (!transitions[transfer.status].includes(input.status)) throw new Error('转账状态转换不合法')
  transfer.status = input.status
  if (settlement.transfers.every((item) => item.status === 'received')) {
    settlement.status = 'completed'
    const trip = state.trips.find((item) => item.id === settlement.tripId)
    trip.status = 'settled'
    trip.activeSettlementId = null
  }
  save(state)
  return clone(settlement)
}

async function createInvite() { throw new Error('多人邀请需先配置微信云开发') }
async function getActiveInvite() { return null }
async function revokeInvite() { throw new Error('多人邀请需先配置微信云开发') }
async function resolveInviteCode() { throw new Error('匹配码加入需先配置微信云开发') }
async function getInviteQr() { throw new Error('小程序码需先配置微信云开发') }
async function previewInvite() { throw new Error('多人邀请需先配置微信云开发') }
async function joinTrip() { throw new Error('多人邀请需先配置微信云开发') }

module.exports = { archiveTrip, bootstrap, createExpense, createInvite, createOfflineMember, createTrip, deactivateMember, deleteExpense, getActiveInvite, getExpense, getInviteQr, getSettlement, getTrip, joinTrip, listTrips, previewInvite, previewSettlement, removeMember, resolveInviteCode, restoreTrip, revokeInvite, startSettlement, transferOwner, updateExpense, updateMyAvatar, updateOfflineMember, updateProfile, updateTransferStatus, updateTrip, uploadAvatar }
module.exports.getFxQuote = async () => { throw new Error('演示模式请使用手动汇率或实际扣款；自动汇率需要云开发') }
