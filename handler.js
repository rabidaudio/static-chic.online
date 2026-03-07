const serverless = require('serverless-http')

const { server } = require('./server')

exports.handler = serverless(server)
