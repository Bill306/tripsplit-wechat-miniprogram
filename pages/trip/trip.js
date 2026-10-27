const repository = require('../../services/repository')
const { decorateDashboard } = require('../../utils/view')

Page({
  data: { id: '', trip: null, loading: true, error: '', inviteId: '', inviteCode: '', invitePath: '', inviteQrUrl: '', qrLoading: false },
  onLoad(options = {}) { wx.hideShareMenu(); this.setData({ id: options.id || '', ...(!options.id ? { loading: false, error: '行程链接不完整，请返回首页重新打开' } : {}) }) },
  onShow() { if (this.data.id) this.loadTrip() },
  async onPullDownRefresh() { await this.loadTrip(); wx.stopPullDownRefresh() },
  async loadTrip() {
    if (!this.data.id) return
    try {
      const trip = decorateDashboard(await repository.getTrip(this.data.id))
      let invite = null
      if (trip.currentMemberRole === 'owner' && trip.currentMemberStatus === 'active' && trip.status !== 'archived') invite = await repository.getActiveInvite(this.data.id)
      this.setData({ trip, loading: false, error: '', inviteId: invite ? invite.inviteId : '', inviteCode: invite ? invite.inviteCode : '', invitePath: invite ? invite.path : '', inviteQrUrl: '' })
      if (invite) wx.showShareMenu({ menus: ['shareAppMessage'] })
      else wx.hideShareMenu()
      wx.setNavigationBarTitle({ title: trip.name })
    } catch (error) {
      wx.hideShareMenu()
      this.setData({ error: error.message, loading: false })
    }
  },
  addExpense() { wx.navigateTo({ url: `/pages/expense-form/expense-form?tripId=${this.data.id}` }) },
  openInvite() { wx.navigateTo({ url: `/pages/invite/invite?tripId=${this.data.id}` }) },
  editTrip() { wx.navigateTo({ url: `/pages/trip-form/trip-form?id=${this.data.id}` }) },
  openExpense(event) { wx.navigateTo({ url: `/pages/expense/expense?id=${event.currentTarget.dataset.id}` }) },
  openSettlement() { wx.navigateTo({ url: `/pages/settlement/settlement?tripId=${this.data.id}` }) },
  manageMembers() { wx.navigateTo({ url: `/pages/members/members?tripId=${this.data.id}` }) },
  async prepareInvite() {
    try {
      const invite = await repository.createInvite(this.data.id)
      this.setData({ inviteId: invite.inviteId, inviteCode: invite.inviteCode, invitePath: invite.path, inviteQrUrl: '' })
      wx.showShareMenu({ menus: ['shareAppMessage'] })
      wx.showToast({ title: '邀请已生成' })
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  onShareAppMessage() {
    return this.data.trip && this.data.invitePath ? { title: `加入 ${this.data.trip.name}，一起记账`, path: this.data.invitePath } : { title: '喵喵旅账', path: '/pages/index/index' }
  },
  copyInviteCode() {
    wx.setClipboardData({ data: this.data.inviteCode, success: () => wx.showToast({ title: '匹配码已复制' }) })
  },
  async showInviteQr() {
    if (this.data.inviteQrUrl) return wx.previewImage({ urls: [this.data.inviteQrUrl] })
    this.setData({ qrLoading: true })
    try {
      let envVersion = 'release'
      try { envVersion = wx.getAccountInfoSync().miniProgram.envVersion || 'release' } catch (_) {}
      const qr = await repository.getInviteQr(this.data.inviteId, envVersion)
      const inviteQrUrl = qr.tempFileURL || qr.fileID
      this.setData({ inviteQrUrl })
      wx.previewImage({ urls: [inviteQrUrl] })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    } finally {
      this.setData({ qrLoading: false })
    }
  },
  async revokeInvite() {
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '撤销当前邀请？', content: '已分享的链接将立即失效，可以再生成新邀请。', success: (result) => resolve(result.confirm) }))
    if (!confirmed) return
    try { await repository.revokeInvite(this.data.inviteId); this.setData({ inviteId: '', inviteCode: '', invitePath: '', inviteQrUrl: '' }); wx.hideShareMenu(); wx.showToast({ title: '邀请已撤销' }) }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  async restoreTrip() {
    try { await repository.restoreTrip(this.data.id); await this.loadTrip() }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
})
