const repository = require('../../services/repository')

Page({
  data: { id: '', trip: null, name: '', destination: '', startDate: '', endDate: '', ownerName: '', profileAvatarUrl: '', companionsText: '', submitting: false },
  async onLoad(options) {
    if (!options.id) {
      try {
        const profile = await repository.bootstrap()
        if (!profile.profileComplete) {
          const redirect = encodeURIComponent('/pages/trip-form/trip-form')
          return wx.redirectTo({ url: `/pages/profile/profile?redirect=${redirect}` })
        }
        this.setData({ ownerName: profile.displayName, profileAvatarUrl: profile.avatarUrl })
      } catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
      return
    }
    try {
      const trip = await repository.getTrip(options.id)
      this.setData({ id: trip.id, trip, name: trip.name, destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate })
      wx.setNavigationBarTitle({ title: '行程设置' })
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  updateField(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  async submit() {
    if (!this.data.name.trim()) return wx.showToast({ title: '请填写行程名称', icon: 'none' })
    if (this.data.endDate && this.data.startDate && this.data.endDate < this.data.startDate) return wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' })
    this.setData({ submitting: true })
    try {
      const input = {
        name: this.data.name,
        destination: this.data.destination,
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        ownerName: this.data.ownerName,
        avatarUrl: this.data.profileAvatarUrl,
        companions: this.data.companionsText.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean),
      }
      if (this.data.id) {
        await repository.updateTrip({ ...input, tripId: this.data.id })
        wx.navigateBack()
      } else {
        const trip = await repository.createTrip(input)
        wx.redirectTo({ url: `/pages/trip/trip?id=${trip.id}` })
      }
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      this.setData({ submitting: false })
    }
  },
  async archive() {
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '归档这次行程？', content: '归档后账本只读，以后仍可恢复。', success: (result) => resolve(result.confirm) }))
    if (!confirmed) return
    try { await repository.archiveTrip(this.data.id); wx.navigateBack() }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
})
