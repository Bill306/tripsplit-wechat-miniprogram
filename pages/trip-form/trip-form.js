const repository = require('../../services/repository')

Page({
  data: { name: '', destination: '', startDate: '', endDate: '', ownerName: 'Bill', companionsText: '', submitting: false },
  updateField(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  async submit() {
    if (!this.data.name.trim()) return wx.showToast({ title: '请填写行程名称', icon: 'none' })
    if (this.data.endDate && this.data.startDate && this.data.endDate < this.data.startDate) return wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' })
    this.setData({ submitting: true })
    try {
      const trip = await repository.createTrip({
        name: this.data.name,
        destination: this.data.destination,
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        ownerName: this.data.ownerName,
        companions: this.data.companionsText.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean),
      })
      wx.redirectTo({ url: `/pages/trip/trip?id=${trip.id}` })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      this.setData({ submitting: false })
    }
  },
})
