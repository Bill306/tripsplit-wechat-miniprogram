const repository = require('../../services/repository')

Page({
  data: { inviteId: '', invite: null, displayName: '', avatarUrl: '', loading: true, submitting: false, error: '' },
  async onLoad(options) {
    const inviteId = options.inviteId || ''
    this.setData({ inviteId, error: inviteId ? '' : '邀请链接不完整', loading: Boolean(inviteId) })
    try {
      const profile = await repository.bootstrap()
      if (!profile.profileComplete) {
        const redirect = encodeURIComponent(`/pages/join/join?inviteId=${inviteId}`)
        return wx.redirectTo({ url: `/pages/profile/profile?redirect=${redirect}` })
      }
      this.setData({ displayName: profile.displayName, avatarUrl: profile.avatarUrl })
    } catch (error) { return this.setData({ loading: false, error: error.message }) }
    if (inviteId) this.loadInvite(inviteId)
  },
  async loadInvite(inviteId) {
    try { this.setData({ invite: await repository.previewInvite(inviteId), loading: false }) }
    catch (error) { this.setData({ loading: false, error: error.message }) }
  },
  async join() {
    if (!this.data.displayName.trim()) return wx.showToast({ title: '请填写行程昵称', icon: 'none' })
    this.setData({ submitting: true })
    try {
      const result = await repository.joinTrip({ inviteId: this.data.inviteId, displayName: this.data.displayName.trim(), avatarUrl: this.data.avatarUrl })
      wx.redirectTo({ url: `/pages/trip/trip?id=${result.tripId}` })
    } catch (error) { this.setData({ submitting: false, error: error.message }) }
  },
})
