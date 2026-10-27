const repository = require('../../services/repository')
const { amountText } = require('../../domain/currency')
const { CATEGORY } = require('../../utils/view')

Page({
  data: { id: '', expense: null, deleting: false, loading: true, error: '' },
  onLoad(options = {}) { this.setData({ id: options.id || '', ...(!options.id ? { loading: false, error: '账单链接不完整，请返回首页重新打开' } : {}) }) },
  onShow() { if (this.data.id) this.load() },
  async load() {
    if (!this.data.id) return
    this.setData({ loading: true, error: '' })
    try {
      const expense = await repository.getExpense(this.data.id)
      const trip = await repository.getTrip(expense.tripId)
      expense.canEdit = expense.canEdit && trip.status !== 'archived'
      const baseCurrency = expense.baseCurrency || 'CNY'
      const formatFen = (value) => amountText(value, baseCurrency)
      const names = Object.fromEntries(expense.members.map((member) => [member.id, member.displayName]))
      this.setData({ expense: {
        ...expense,
        amountText: formatFen(expense.amountFen),
        originalAmountText: expense.originalCurrency && expense.originalCurrency !== baseCurrency ? amountText(expense.originalAmountMinor, expense.originalCurrency) : '',
        fxDescription: expense.fx && expense.fx.mode !== 'same' ? (expense.fx.mode === 'actual' ? '按手动填写的实际扣款金额记账' : `1 ${expense.originalCurrency} = ${expense.fx.rate} ${baseCurrency}`) : '',
        payerName: names[expense.payerMemberId],
        categoryLabel: (CATEGORY[expense.category] || CATEGORY.other).label,
        spentAtText: expense.spentAt.slice(0, 10),
        sharesView: Object.entries(expense.shares).map(([memberId, amountFen]) => ({ memberId, name: names[memberId], amountText: formatFen(amountFen) })),
        auditEvents: (expense.auditEvents || []).map((event) => ({ ...event, createdAtText: String(event.createdAt).replace('T', ' ').slice(0, 16) })),
      } })
    } catch (error) { this.setData({ error: error.message }) }
    finally { this.setData({ loading: false }) }
  },
  edit() { if (this.data.expense && this.data.expense.canEdit) wx.navigateTo({ url: `/pages/expense-form/expense-form?tripId=${this.data.expense.tripId}&expenseId=${this.data.id}` }) },
  async remove() {
    if (this.data.deleting || !this.data.expense || !this.data.expense.canEdit) return
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '删除这笔账单？', content: '删除后统计和结算会立即重新计算。', confirmColor: '#C24B3A', success: (result) => resolve(result.confirm) }))
    if (!confirmed) return
    this.setData({ deleting: true })
    try {
      await repository.deleteExpense({ expenseId: this.data.id, expectedRevision: this.data.expense.revision })
      wx.navigateBack()
    } catch (error) { this.setData({ deleting: false }); wx.showToast({ title: error.message, icon: 'none' }) }
  },
})
