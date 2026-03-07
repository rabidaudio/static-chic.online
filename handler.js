require('dotenv').config()

const express = require('express')
const serverless = require('serverless-http')

const app = require('./app')

const server = express()

server.use(express.json())

server.get('/sites/:siteId/deployments', async (req, res) => {
  const deployments = await app.listDeployments(req.params.siteId)
  res.json({ status: 'OK', data: deployments, pagination: { count: deployments.length } })
})

// server.get('/sites/:siteId/deployments/:deploymentId', async (req, res) => {})

server.post('/sites/:siteId/deployments', async (req, res) => {
  // TODO: authentication
  const siteId = req.params.siteId
  const deployment = await app.createDeployment({ siteId, contentTarball: ReadableStream.from(req) })
  res.json({ status: 'OK', data: deployment })
})

server.use((req, res, next) => {
  return res.status(404).json({
    status: 'ERROR',
    error: { message: 'Not Found' }
  })
})

server.use((err, req, res, next) => {
  console.error(err.stack)
  const errorData = {
    message: 'Server Error'
  }
  if (process.env.NODE_ENV === 'dev') {
    errorData.message = err.message
  }
  res.status(500).json({
    status: 'ERROR',
    error: errorData
  })
})

exports.handler = serverless(server)
