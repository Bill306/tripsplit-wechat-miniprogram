'use strict'

function summarizeLedger(members, expenses) {
  const summary = Object.fromEntries(
    members.map((member) => [member.id, {
      memberId: member.id,
      displayName: member.displayName,
      paidAmount: 0,
      owedAmount: 0,
      netAmount: 0,
    }]),
  )

  expenses.filter((expense) => !expense.deletedAt).forEach((expense) => {
    if (!summary[expense.payerMemberId]) {
      throw new Error(`付款人不在行程成员中: ${expense.payerMemberId}`)
    }
    summary[expense.payerMemberId].paidAmount += expense.amountFen
    Object.entries(expense.shares || {}).forEach(([memberId, amountFen]) => {
      if (!summary[memberId] || !Number.isSafeInteger(amountFen) || amountFen < 0) {
        throw new Error('账单分摊数据不合法')
      }
      summary[memberId].owedAmount += amountFen
    })
  })

  const result = Object.values(summary).map((item) => ({
    ...item,
    netAmount: item.paidAmount - item.owedAmount,
  }))
  assertBalanced(result)
  return result
}

function assertBalanced(summary) {
  const netTotal = summary.reduce((sum, item) => sum + item.netAmount, 0)
  if (netTotal !== 0) {
    throw new Error(`账本不平衡，净额合计为 ${netTotal} 分`)
  }
  return true
}

module.exports = {
  assertBalanced,
  summarizeLedger,
}
