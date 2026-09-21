const repository = require('../../services/repository')
const { decorateDashboard } = require('../../utils/view')

Page({
  data: { loading: true, trips: [], error: '', mode: repository.mode },
  onShow() { this.loadTrips() },
  async loadTrips() {
    this.setData({ loading: true, error: '' })
    try {
      const trips = (await repository.listTrips()).map(decorateDashboard)
      this.setData({ trips, loading: false })
    } catch (error) {
      this.setData({ loading: false, error: error.message })
    }
  },
  createTrip() { wx.navigateTo({ url: '/pages/trip-form/trip-form' }) },
  openTrip(event) { wx.navigateTo({ url: `/pages/trip/trip?id=${event.currentTarget.dataset.id}` }) },
})
