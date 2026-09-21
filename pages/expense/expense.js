const repository = require('../../services/repository')
const { formatFen } = require('../../domain/money')
const { CATEGORY } = require('../../utils/view')

Page({
  data: { id: '', expense: null, deleting: false },
  onLoad(options) { this.setData({ id: options.id }) },
  onShow() { if (this.data.id) this.load() },
  async load() {
    try {
      const expense = await repository.getExpense(this.data.id)
      const names = Object.fromEntries(expense.members.map((member) => [member.id, member.displayName]))
      this.setData({ expense: {
        ...expense,
        amountText: formatFen(expense.amountFen),
        payerName: names[expense.payerMemberId],
        categoryLabel: (CATEGORY[expense.category] || CATEGORY.other).label,
        spentAtText: expense.spentAt.slice(0, 10),
        sharesView: Object.entries(expense.shares).map(([memberId, amountFen]) => ({ memberId, name: names[memberId], amountText: formatFen(amountFen) })),
        auditEvents: (expense.auditEvents || []).map((event) => ({ ...event, createdAtText: String(event.createdAt).replace('T', ' ').slice(0, 16) })),
      } })
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  edit() { wx.navigateTo({ url: `/pages/expense-form/expense-form?tripId=${this.data.expense.tripId}&expenseId=${this.data.id}` }) },
  async remove() {
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '删除这笔账单？', content: '删除后统计和结算会立即重新计算。', confirmColor: '#C24B3A', success: (result) => resolve(result.confirm) }))
    if (!confirmed) return
    this.setData({ deleting: true })
    try {
      await repository.deleteExpense({ expenseId: this.data.id, expectedRevision: this.data.expense.revision })
      wx.navigateBack()
    } catch (error) { this.setData({ deleting: false }); wx.showToast({ title: error.message, icon: 'none' }) }
  },
})
