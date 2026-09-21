'use strict'

const demoRepository = require('./demoRepository')
const cloudRepository = require('./cloudRepository')
const { envId } = require('../config/cloud')

const selected = envId ? cloudRepository : demoRepository
module.exports = { ...selected, mode: envId ? 'cloud' : 'demo', envId }
