const repository = require('../../services/repository')

Page({
  data: { inviteId: '', invite: null, displayName: '', avatarLocalPath: '', loading: true, submitting: false, error: '' },
  onLoad(options) {
    const inviteId = options.inviteId || ''
    this.setData({ inviteId, error: inviteId ? '' : '邀请链接不完整', loading: Boolean(inviteId) })
    if (inviteId) this.loadInvite(inviteId)
  },
  async loadInvite(inviteId) {
    try { this.setData({ invite: await repository.previewInvite(inviteId), loading: false }) }
    catch (error) { this.setData({ loading: false, error: error.message }) }
  },
  updateName(event) { this.setData({ displayName: event.detail.value }) },
  chooseAvatar(event) { this.setData({ avatarLocalPath: event.detail.avatarUrl }) },
  async join() {
    if (!this.data.displayName.trim()) return wx.showToast({ title: '请填写行程昵称', icon: 'none' })
    this.setData({ submitting: true })
    try {
      const avatarUrl = this.data.avatarLocalPath ? await repository.uploadAvatar(this.data.avatarLocalPath) : ''
      const result = await repository.joinTrip({ inviteId: this.data.inviteId, displayName: this.data.displayName.trim(), avatarUrl })
      wx.redirectTo({ url: `/pages/trip/trip?id=${result.tripId}` })
    } catch (error) { this.setData({ submitting: false, error: error.message }) }
  },
})
