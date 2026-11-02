const repository = require('../../services/repository')
const { parseInviteCode } = require('../../domain/entry')

Page({
  data: { inviteId: '', invite: null, displayName: '', avatarUrl: '', loading: true, submitting: false, error: '', profileReady: false, profileLoading: false, profileError: '', identityExpanded: false },
  onLoad(options) { this.initialize(options) },
  goHome() { getApp().globalData.launchInviteCode = ''; wx.reLaunch({ url: '/pages/index/index' }) },
  async initialize(options = {}) {
    this.setData({ invite: null, loading: true, error: '', profileReady: false, profileError: '', identityExpanded: false })
    let inviteId = options.inviteId || ''
    let launchScene = ''
    try { launchScene = (wx.getLaunchOptionsSync().query || {}).scene || '' } catch (_) {}
    const rawCode = options.code || options.scene || launchScene || getApp().globalData.launchInviteCode || ''
    getApp().globalData.launchInviteCode = ''
    if (!inviteId && rawCode) {
      try {
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
      this.setData({ invite: await repository.previewInvite(inviteId), loading: false })
    } catch (error) { return this.setData({ loading: false, error: error.message }) }
    await this.loadIdentity()
  },
  async loadIdentity() {
    if (this.data.profileLoading) return
    this.setData({ profileLoading: true, profileError: '' })
    try {
      const profile = await repository.bootstrap()
      this.profile = profile
      getApp().globalData.profile = profile
      this.setData({ displayName: profile.displayName || '', avatarUrl: profile.avatarUrl || '', profileReady: true })
    } catch (error) { this.setData({ profileError: error.message }) }
    finally { this.setData({ profileLoading: false }) }
  },
  updateName(event) { this.setData({ displayName: event.detail.value }) },
  async join() {
    if (this.data.loading || this.data.submitting || !this.data.invite || !this.data.profileReady) return
    const displayName = this.data.displayName.trim()
    if (!displayName) {
      if (!this.data.identityExpanded) return this.setData({ identityExpanded: true })
      return wx.showToast({ title: '请填写昵称', icon: 'none' })
    }
    this.setData({ submitting: true, error: '' })
    try {
      if (!this.profile.profileComplete || displayName !== this.profile.displayName) {
        this.profile = await repository.updateProfile({ displayName, avatarUrl: this.data.avatarUrl })
        getApp().globalData.profile = this.profile
      }
      const result = await repository.joinTrip({ inviteId: this.data.inviteId, displayName, avatarUrl: this.data.avatarUrl })
      wx.reLaunch({ url: `/pages/trip/trip?id=${result.tripId}` })
    } catch (error) { this.setData({ submitting: false, error: error.message }) }
  },
})
