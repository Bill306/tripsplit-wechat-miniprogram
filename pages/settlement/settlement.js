const repository = require('../../services/repository')
const { formatFen } = require('../../domain/money')

function decorate(settlement) {
  return {
    ...settlement,
    statusLabel: { preview: '预览', active: '确认中', completed: '已完成' }[settlement.status] || settlement.status,
    summary: settlement.summary.map((item) => ({ ...item, initial: item.displayName.slice(0, 1), netText: formatFen(Math.abs(item.netAmount)), netLabel: item.netAmount >= 0 ? '应收' : '应付', netClass: item.netAmount >= 0 ? 'amount-positive' : 'amount-negative' })),
    transfers: settlement.transfers.map((item) => ({ ...item, amountText: formatFen(item.amountFen), statusLabel: { pending: '待支付', paid: '待收款确认', received: '已收款' }[item.status] })),
  }
}

Page({
  data: { tripId: '', settlement: null, loading: true, busyId: '' },
  onLoad(options) { this.setData({ tripId: options.tripId }) },
  onShow() { if (this.data.tripId) this.load() },
  async load() {
    try { this.setData({ settlement: decorate(await repository.getSettlement(this.data.tripId)), loading: false }) }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  async start() {
    wx.showLoading({ title: '生成中' })
    try { this.setData({ settlement: decorate(await repository.startSettlement(this.data.tripId)) }) }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
    finally { wx.hideLoading() }
  },
  async updateStatus(event) {
    const { id, status } = event.currentTarget.dataset
    this.setData({ busyId: id })
    try {
      const settlement = await repository.updateTransferStatus({ settlementId: this.data.settlement.id, transferId: id, status })
      this.setData({ settlement: decorate(settlement), busyId: '' })
    } catch (error) { this.setData({ busyId: '' }); wx.showToast({ title: error.message, icon: 'none' }) }
  },
})
