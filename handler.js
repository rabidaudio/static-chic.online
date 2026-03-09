const serverless = require('serverless-http')

const { server } = require('./src/server')

exports.handler = serverless(server)
