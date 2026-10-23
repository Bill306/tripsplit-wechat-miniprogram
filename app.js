const repository = require('./services/repository')

function inviteCodeFromLaunch(options = {}) {
  const query = options.query || {}
  const raw = query.scene || query.inviteCode || ''
  try { return decodeURIComponent(raw).replace(/^code=/, '').replace(/\D/g, '').slice(0, 6) } catch (_) { return '' }
}

App({
  async onLaunch(options) {
    this.globalData.launchInviteCode = inviteCodeFromLaunch(options)
    try {
      if (repository.mode === 'cloud') {
        wx.cloud.init({ env: repository.envId, traceUser: true })
      }
      this.globalData.profile = await repository.bootstrap()
      this.globalData.ready = true
    } catch (error) {
      this.globalData.bootstrapError = error.message
    }
  },
  onShow(options) {
    const inviteCode = inviteCodeFromLaunch(options)
    if (inviteCode) this.globalData.launchInviteCode = inviteCode
  },
  globalData: {
    ready: false,
    bootstrapError: '',
    repository,
    profile: null,
    launchInviteCode: '',
  },
})
