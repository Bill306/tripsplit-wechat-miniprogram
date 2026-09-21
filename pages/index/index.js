const repository = require('../../services/repository')
const { decorateDashboard } = require('../../utils/view')

Page({
  data: { loading: true, trips: [], groups: [], error: '', mode: repository.mode },
  onShow() { this.loadTrips() },
  async loadTrips() {
    this.setData({ loading: true, error: '' })
    try {
      const trips = (await repository.listTrips()).map(decorateDashboard)
      const definitions = [
        { key: 'active', title: '进行中', statuses: ['active'] },
        { key: 'pending', title: '待结算', statuses: ['needs_settlement', 'settling'] },
        { key: 'settled', title: '已结算', statuses: ['settled'] },
        { key: 'archived', title: '已归档', statuses: ['archived'] },
      ]
      const groups = definitions.map((group) => ({ ...group, trips: trips.filter((trip) => group.statuses.includes(trip.status)) })).filter((group) => group.trips.length)
      this.setData({ trips, groups, loading: false })
    } catch (error) {
      this.setData({ loading: false, error: error.message })
    }
  },
  createTrip() { wx.navigateTo({ url: '/pages/trip-form/trip-form' }) },
  openTrip(event) { wx.navigateTo({ url: `/pages/trip/trip?id=${event.currentTarget.dataset.id}` }) },
})
