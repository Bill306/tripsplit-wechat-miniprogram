const repository = require('../../services/repository')
const { parseInviteCode } = require('../../domain/entry')

Page({
  data: { inviteId: '', invite: null, displayName: '', avatarUrl: '', loading: true, submitting: false, error: '' },
  onLoad(options) { this.initialize(options) },
  goHome() { getApp().globalData.launchInviteCode = ''; wx.reLaunch({ url: '/pages/index/index' }) },
  async initialize(options = {}) {
    this.setData({ invite: null, loading: true, error: '' })
    let inviteId = options.inviteId || ''
    let launchScene = ''
    try { launchScene = (wx.getLaunchOptionsSync().query || {}).scene || '' } catch (_) {}
    const rawCode = options.code || options.scene || launchScene || getApp().globalData.launchInviteCode || ''
    if (!inviteId && rawCode) {
      try {
        getApp().globalData.launchInviteCode = ''
        const sceneCode = parseInviteCode(rawCode)
        const resolved = await repository.resolveInviteCode(sceneCode)
        inviteId = resolved.inviteId
      } catch (error) {
        return this.setData({ loading: false, error: error.message })
      }
    }
    this.setData({ inviteId, error: inviteId ? '' : '邀请链接不完整', loading: Boolean(inviteId) })
    if (!inviteId) return
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
    if (this.data.loading || this.data.submitting || !this.data.invite) return
    if (!this.data.displayName.trim()) return wx.showToast({ title: '请填写行程昵称', icon: 'none' })
    this.setData({ submitting: true })
    try {
      const result = await repository.joinTrip({ inviteId: this.data.inviteId, displayName: this.data.displayName.trim(), avatarUrl: this.data.avatarUrl })
      wx.reLaunch({ url: `/pages/trip/trip?id=${result.tripId}` })
    } catch (error) { this.setData({ submitting: false, error: error.message }) }
  },
})
