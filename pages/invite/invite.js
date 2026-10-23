const repository = require('../../services/repository')

Page({
  data: { tripId: '', trip: null, invite: null, loading: true, busy: false, qrLoading: false, qrUrl: '', error: '', canInvite: false },
  onLoad(options) { this.setData({ tripId: options.tripId || '' }); this.load() },
  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const trip = await repository.getTrip(this.data.tripId)
      const canInvite = trip.currentMemberRole === 'owner' && trip.currentMemberStatus === 'active' && trip.status !== 'archived'
      const invite = canInvite ? await repository.getActiveInvite(this.data.tripId) : null
      this.setData({ trip, canInvite, invite, loading: false, qrUrl: '' })
      if (invite) wx.showShareMenu({ menus: ['shareAppMessage'] })
      else wx.hideShareMenu()
    } catch (error) { this.setData({ loading: false, error: error.message }); wx.hideShareMenu() }
  },
  async create() {
    if (!this.data.canInvite || this.data.busy) return
    this.setData({ busy: true, error: '' })
    try {
      const invite = await repository.createInvite(this.data.tripId)
      this.setData({ invite, qrUrl: '' })
      wx.showShareMenu({ menus: ['shareAppMessage'] })
    } catch (error) { this.setData({ error: error.message }) }
    finally { this.setData({ busy: false }) }
  },
  onShareAppMessage() {
    return { title: this.data.trip ? `加入 ${this.data.trip.name}，一起记账` : '喵喵旅账', path: this.data.invite ? this.data.invite.path : '/pages/index/index' }
  },
  copyCode() {
    if (this.data.invite) wx.setClipboardData({ data: this.data.invite.inviteCode })
  },
  async revoke() {
    if (!this.data.invite || !this.data.canInvite || this.data.busy || this.data.qrLoading) return
    this.setData({ busy: true })
    try {
      const confirmed = await new Promise((resolve) => wx.showModal({ title: '撤销当前邀请？', content: '已分享的链接、二维码和匹配码将失效，已加入的成员不受影响。', success: (result) => resolve(result.confirm), fail: () => resolve(false) }))
      if (!confirmed) return
      await repository.revokeInvite(this.data.invite.inviteId)
      this.setData({ invite: null, qrUrl: '', error: '' })
      wx.hideShareMenu()
    } catch (error) { this.setData({ error: error.message }) }
    finally { this.setData({ busy: false }) }
  },
  async showQr() {
    if (!this.data.invite || this.data.qrLoading) return
    if (this.data.qrUrl) return wx.previewImage({ urls: [this.data.qrUrl] })
    this.setData({ qrLoading: true, error: '' })
    try {
      let envVersion = 'release'
      try { envVersion = wx.getAccountInfoSync().miniProgram.envVersion || 'release' } catch (_) {}
      const qr = await repository.getInviteQr(this.data.invite.inviteId, envVersion)
      const qrUrl = qr.tempFileURL || qr.fileID
      if (!qrUrl) throw new Error('二维码暂未生成，请重试或使用匹配码加入')
      this.setData({ qrUrl })
    } catch (error) { this.setData({ error: error.message }) }
    finally { this.setData({ qrLoading: false }) }
  },
  openTrip() { wx.redirectTo({ url: `/pages/trip/trip?id=${this.data.tripId}` }) },
})
