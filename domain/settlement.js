'use strict'

const { assertBalanced } = require('./ledger')

function buildSettlementTransfers(summary) {
  assertBalanced(summary)
  const debtors = summary
    .filter((item) => item.netAmount < 0)
    .map((item) => ({ ...item, remaining: -item.netAmount }))
    .sort((a, b) => b.remaining - a.remaining || String(a.memberId).localeCompare(String(b.memberId)))
  const creditors = summary
    .filter((item) => item.netAmount > 0)
    .map((item) => ({ ...item, remaining: item.netAmount }))
    .sort((a, b) => b.remaining - a.remaining || String(a.memberId).localeCompare(String(b.memberId)))

  const transfers = []
  let debtorIndex = 0
  let creditorIndex = 0
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex]
    const creditor = creditors[creditorIndex]
    const amountFen = Math.min(debtor.remaining, creditor.remaining)
    if (amountFen > 0) {
      transfers.push({
        fromMemberId: debtor.memberId,
        toMemberId: creditor.memberId,
        amountFen,
        status: 'pending',
      })
    }
    debtor.remaining -= amountFen
    creditor.remaining -= amountFen
    if (debtor.remaining === 0) debtorIndex += 1
    if (creditor.remaining === 0) creditorIndex += 1
  }

  if (debtors.some((item) => item.remaining) || creditors.some((item) => item.remaining)) {
    throw new Error('结算方案无法归零')
  }
  return transfers
}

module.exports = {
  buildSettlementTransfers,
}
