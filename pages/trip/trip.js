const repository = require('../../services/repository')
const { decorateDashboard } = require('../../utils/view')

Page({
  data: { id: '', trip: null, loading: true, error: '', invitePath: '' },
  onLoad(options) { this.setData({ id: options.id }) },
  onShow() { if (this.data.id) this.loadTrip() },
  async onPullDownRefresh() { await this.loadTrip(); wx.stopPullDownRefresh() },
  async loadTrip() {
    try {
      const trip = decorateDashboard(await repository.getTrip(this.data.id))
      this.setData({ trip, loading: false, error: '' })
      wx.setNavigationBarTitle({ title: trip.name })
    } catch (error) {
      this.setData({ error: error.message, loading: false })
    }
  },
  addExpense() { wx.navigateTo({ url: `/pages/expense-form/expense-form?tripId=${this.data.id}` }) },
  openExpense(event) { wx.navigateTo({ url: `/pages/expense/expense?id=${event.currentTarget.dataset.id}` }) },
  openSettlement() { wx.navigateTo({ url: `/pages/settlement/settlement?tripId=${this.data.id}` }) },
  manageMembers() { wx.navigateTo({ url: `/pages/members/members?tripId=${this.data.id}` }) },
  async prepareInvite() {
    try {
      const invite = await repository.createInvite(this.data.id)
      this.setData({ invitePath: invite.path })
      wx.showToast({ title: '邀请已生成' })
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  onShareAppMessage() {
    return { title: `加入 ${this.data.trip.name}，一起记账`, path: this.data.invitePath || `/pages/trip/trip?id=${this.data.id}` }
  },
})
