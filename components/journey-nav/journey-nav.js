Component({
  properties: { label: String, home: { type: Boolean, value: true } },
  methods: { goHome() { wx.reLaunch({ url: '/pages/index/index' }) } },
})
