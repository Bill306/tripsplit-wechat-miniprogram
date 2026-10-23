'use strict'

const { amountText } = require('../domain/currency')

const CATEGORY = {
  food: { label: '餐饮', icon: '🍜' },
  transport: { label: '交通', icon: '🚕' },
  stay: { label: '住宿', icon: '🏨' },
  ticket: { label: '门票', icon: '🎫' },
  shopping: { label: '购物', icon: '🛒' },
  other: { label: '其他', icon: '🧾' },
}

const STATUS = { active: '进行中', needs_settlement: '待结算', settling: '结算中', settled: '已结算', archived: '已归档' }

function decorateDashboard(trip) {
  const baseCurrency = trip.baseCurrency || 'CNY'
  const formatFen = (value) => amountText(value, baseCurrency)
  const memberNames = Object.fromEntries(trip.members.map((member) => [member.id, member.displayName]))
  return {
    ...trip, baseCurrency,
    statusLabel: STATUS[trip.status] || trip.status,
    totalAmount: formatFen(trip.totalAmountFen),
    myPaidAmount: formatFen(trip.myPaidAmountFen),
    myOwedAmount: formatFen(trip.myOwedAmountFen || 0),
    myNetAmount: formatFen(Math.abs(trip.myNetAmountFen)),
    myNetLabel: trip.myNetAmountFen >= 0 ? '我应收' : '我应付',
    myNetClass: trip.myNetAmountFen >= 0 ? 'amount-positive' : 'amount-negative',
    summary: trip.summary.map((item) => ({ ...item, initial: item.displayName.slice(0, 1), netAmountText: formatFen(Math.abs(item.netAmount)), netLabel: item.netAmount >= 0 ? '应收' : '应付', netClass: item.netAmount >= 0 ? 'amount-positive' : 'amount-negative' })),
    expenses: trip.expenses.map((expense) => ({ ...expense, originalAmountText: expense.originalCurrency && expense.originalCurrency !== baseCurrency ? amountText(expense.originalAmountMinor, expense.originalCurrency) : '', amountText: formatFen(expense.amountFen), categoryLabel: (CATEGORY[expense.category] || CATEGORY.other).label, categoryIcon: (CATEGORY[expense.category] || CATEGORY.other).icon, payerName: memberNames[expense.payerMemberId] || '未知', spentAtText: String(expense.spentAt).slice(0, 10) })),
  }
}

module.exports = { CATEGORY, STATUS, decorateDashboard }
