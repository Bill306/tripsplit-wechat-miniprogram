const repository = require('../../services/repository')
const { amountText } = require('../../domain/currency')

function decorate(settlement, demoMode) {
  const formatFen = (value) => amountText(value, settlement.baseCurrency || 'CNY')
  const mine = settlement.transfers.filter((item) => item.fromMemberId === settlement.currentMemberId || item.toMemberId === settlement.currentMemberId)
  const unpaid = mine.filter((item) => item.fromMemberId === settlement.currentMemberId && item.status === 'pending').reduce((sum, item) => sum + item.amountFen, 0)
  const unreceived = mine.filter((item) => item.toMemberId === settlement.currentMemberId && item.status !== 'received').reduce((sum, item) => sum + item.amountFen, 0)
  const awaiting = mine.some((item) => item.fromMemberId === settlement.currentMemberId && item.status === 'paid')
  const toConfirm = mine.some((item) => item.toMemberId === settlement.currentMemberId && item.status === 'paid')
  return {
    ...settlement,
    myPayText: formatFen(unpaid),
    myReceiveText: formatFen(unreceived),
    receivedCount: settlement.transfers.filter((item) => item.status === 'received').length,
    nextAction: settlement.status === 'preview' ? (settlement.currentMemberRole === 'owner' ? '确认账单无误后，点击「开始结算」。' : '等待创建者开始结算。')
      : settlement.status === 'completed' ? '大家都已确认收款。'
        : toConfirm ? '有朋友标记了已转账，请查到账后点击「确认已到账」。'
          : unpaid ? '先到微信聊天或银行完成转账，再回来标记「我已转账」。'
            : awaiting ? '等待对方确认收款。'
              : unreceived ? '等待朋友转账，到账后记得确认。' : '你目前没有需要处理的转账。',
    statusLabel: { preview: '预览', active: '确认中', completed: '已完成' }[settlement.status] || settlement.status,
    summary: settlement.summary.map((item) => ({ ...item, initial: item.displayName.slice(0, 1), netText: formatFen(Math.abs(item.netAmount)), netLabel: item.netAmount >= 0 ? '应收' : '应付', netClass: item.netAmount >= 0 ? 'amount-positive' : 'amount-negative' })),
    transfers: settlement.transfers.map((item) => ({
      ...item,
      amountText: formatFen(item.amountFen),
      statusLabel: { pending: '待转账', paid: '已标记付款，待收款人确认', received: '已确认收款' }[item.status],
      isMine: item.fromMemberId === settlement.currentMemberId || item.toMemberId === settlement.currentMemberId,
      fromLabel: item.fromMemberId === settlement.currentMemberId ? `${item.fromName}（我）` : item.fromName,
      toLabel: item.toMemberId === settlement.currentMemberId ? `${item.toName}（我）` : item.toName,
      canMarkPaid: demoMode || settlement.currentMemberId === item.fromMemberId,
      canConfirmReceived: demoMode || settlement.currentMemberId === item.toMemberId,
      canResetPaid: demoMode || settlement.currentMemberId === item.fromMemberId || settlement.currentMemberRole === 'owner',
    })),
  }
}

Page({
  data: { tripId: '', settlement: null, loading: true, error: '', canStart: false, starting: false, busyId: '', demoMode: repository.mode === 'demo' },
  onLoad(options = {}) { this.setData({ tripId: options.tripId || '', ...(!options.tripId ? { loading: false, error: '行程链接不完整，请返回首页重新打开' } : {}) }) },
  onShow() { if (this.data.tripId) this.load() },
  async load() {
    if (!this.data.tripId) return
    this.setData({ loading: true, error: '' })
    try {
      const [result, trip] = await Promise.all([repository.getSettlement(this.data.tripId), repository.getTrip(this.data.tripId)])
      const settlement = decorate(result, this.data.demoMode)
      const canStart = settlement.status === 'preview' && trip.currentMemberRole === 'owner' && trip.currentMemberStatus === 'active' && ['active', 'needs_settlement'].includes(trip.status)
      if (trip.status === 'archived') settlement.nextAction = '行程已归档，可以查看结算记录。恢复行程后可继续操作。'
      this.setData({ settlement, canStart, loading: false })
    }
    catch (error) { this.setData({ loading: false, error: error.message }) }
  },
  async start() {
    if (this.data.starting || !this.data.canStart) return
    this.setData({ starting: true })
    wx.showLoading({ title: '生成中' })
    try { this.setData({ settlement: decorate(await repository.startSettlement(this.data.tripId), this.data.demoMode), canStart: false }) }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
    finally { wx.hideLoading(); this.setData({ starting: false }) }
  },
  openTrip() { wx.redirectTo({ url: `/pages/trip/trip?id=${this.data.tripId}` }) },
  async updateStatus(event) {
    if (this.data.busyId) return
    const { id, status } = event.currentTarget.dataset
    const transfer = this.data.settlement && this.data.settlement.transfers.find((item) => item.id === id)
    if (!transfer || this.data.settlement.status !== 'active') return
    const allowed = status === 'paid' ? transfer.status === 'pending' && transfer.canMarkPaid
      : status === 'received' ? transfer.status === 'paid' && transfer.canConfirmReceived
        : status === 'pending' && transfer.status === 'paid' && transfer.canResetPaid
    if (!allowed) return
    this.setData({ busyId: id })
    try {
      const confirmed = await new Promise((resolve) => wx.showModal({
        title: status === 'paid' ? '已在微信或银行完成转账？' : status === 'received' ? '确认这笔钱已经到账？' : '撤销付款标记？',
        content: `${transfer.fromName} → ${transfer.toName} ${transfer.amountText}。${status === 'paid' ? '请确认已经转账。这里仅更新记录，不会扣款。' : status === 'received' ? '请核对微信或银行的到账记录，确认后这笔款项就结清了。' : '撤销后会显示为待转账，已转出的款项不会退回。'}`,
        confirmText: status === 'paid' ? '已转账' : status === 'received' ? '已到账' : '撤销标记',
        success: (result) => resolve(result.confirm), fail: () => resolve(false),
      }))
      if (!confirmed) return
      const settlement = await repository.updateTransferStatus({ settlementId: this.data.settlement.id, transferId: id, status })
      this.setData({ settlement: decorate(settlement, this.data.demoMode), busyId: '' })
    } catch (error) { this.setData({ busyId: '' }); wx.showToast({ title: error.message, icon: 'none' }) }
    finally { this.setData({ busyId: '' }) }
  },
})
