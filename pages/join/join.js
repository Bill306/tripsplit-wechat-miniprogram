const repository = require('../../services/repository')

Page({
  data: { inviteId: '', displayName: '', submitting: false, error: '' },
  onLoad(options) { this.setData({ inviteId: options.inviteId || '', error: options.inviteId ? '' : '邀请链接不完整' }) },
  updateName(event) { this.setData({ displayName: event.detail.value }) },
  async join() {
    if (!this.data.displayName.trim()) return wx.showToast({ title: '请填写行程昵称', icon: 'none' })
    this.setData({ submitting: true })
    try {
      const result = await repository.joinTrip({ inviteId: this.data.inviteId, displayName: this.data.displayName.trim() })
      wx.redirectTo({ url: `/pages/trip/trip?id=${result.tripId}` })
    } catch (error) { this.setData({ submitting: false, error: error.message }) }
  },
})
