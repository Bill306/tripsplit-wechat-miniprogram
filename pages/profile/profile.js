const repository = require('../../services/repository')

Page({
  data: {
    loading: true,
    submitting: false,
    editMode: false,
    redirect: '/pages/index/index',
    displayName: '',
    avatarUrl: '',
    hasNewAvatar: false,
    error: '',
  },
  async onLoad(options) {
    const editMode = options.edit === '1'
    const redirect = options.redirect ? decodeURIComponent(options.redirect) : '/pages/index/index'
    this.setData({ editMode, redirect })
    try {
      const profile = await repository.bootstrap()
      getApp().globalData.profile = profile
      if (profile.profileComplete && !editMode) return wx.reLaunch({ url: redirect })
      this.setData({ displayName: profile.displayName || '', avatarUrl: profile.avatarUrl || '', loading: false })
    } catch (error) {
      this.setData({ loading: false, error: error.message })
    }
  },
  chooseAvatar(event) {
    this.setData({ avatarUrl: event.detail.avatarUrl, hasNewAvatar: true })
  },
  updateName(event) {
    this.setData({ displayName: event.detail.value })
  },
  async submit() {
    const displayName = this.data.displayName.trim()
    if (!this.data.avatarUrl) return wx.showToast({ title: '请先选择微信头像', icon: 'none' })
    if (!displayName) return wx.showToast({ title: '请填写微信昵称', icon: 'none' })
    this.setData({ submitting: true, error: '' })
    try {
      const avatarUrl = this.data.hasNewAvatar ? await repository.uploadAvatar(this.data.avatarUrl) : this.data.avatarUrl
      const profile = await repository.updateProfile({ displayName, avatarUrl })
      getApp().globalData.profile = profile
      if (this.data.editMode && getCurrentPages().length > 1) wx.navigateBack()
      else wx.reLaunch({ url: this.data.redirect })
    } catch (error) {
      this.setData({ submitting: false, error: error.message })
    }
  },
})
