const repository = require('./services/repository')

App({
  async onLaunch() {
    try {
      if (repository.mode === 'cloud') {
        wx.cloud.init({ env: repository.envId, traceUser: true })
      }
      await repository.bootstrap()
      this.globalData.ready = true
    } catch (error) {
      this.globalData.bootstrapError = error.message
    }
  },
  globalData: {
    ready: false,
    bootstrapError: '',
    repository,
  },
})
