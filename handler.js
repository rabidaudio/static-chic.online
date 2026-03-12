const serverless = require('serverless-http')

const { app } = require('./src/server')

exports.handler = serverless(app)
