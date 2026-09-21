'use strict'

function call(action, payload = {}) {
  return wx.cloud.callFunction({ name: 'api', data: { action, payload } }).then(({ result }) => {
    if (!result || result.ok !== true) {
      const error = new Error((result && result.error && result.error.message) || '云端请求失败')
      error.code = result && result.error && result.error.code
      error.details = result && result.error && result.error.details
      throw error
    }
    return result.data
  })
}

module.exports = {
  bootstrap: () => call('bootstrap'),
  listTrips: () => call('trip.list'),
  getTrip: (tripId) => call('trip.get', { tripId }),
  createTrip: (input) => call('trip.create', input),
  updateTrip: (input) => call('trip.update', input),
  archiveTrip: (tripId) => call('trip.archive', { tripId }),
  restoreTrip: (tripId) => call('trip.restore', { tripId }),
  createOfflineMember: (tripId, input) => call('member.addOffline', { tripId, ...input }),
  updateOfflineMember: (input) => call('member.updateOffline', input),
  deactivateMember: (memberId) => call('member.deactivate', { memberId }),
  createExpense: (input) => call('expense.create', input),
  getExpense: (expenseId) => call('expense.get', { expenseId }),
  updateExpense: (input) => call('expense.update', input),
  deleteExpense: (input) => call('expense.delete', input),
  previewSettlement: (tripId) => call('settlement.preview', { tripId }),
  getSettlement: (tripId) => call('settlement.get', { tripId }),
  startSettlement: (tripId) => call('settlement.start', { tripId }),
  updateTransferStatus: (input) => call('settlement.transfer.update', input),
  createInvite: (tripId) => call('invite.create', { tripId }),
  joinTrip: (input) => call('invite.join', input),
}
