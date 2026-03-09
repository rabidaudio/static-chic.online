const Koa = require('koa')
const Router = require('@koa/router')

const { configure: configureLogger, getLogger } = require('./logger')
configureLogger({ level: 'verbose', pretty: false })
const logger = getLogger()

const app = require('./app')

const server = new Koa()
const router = new Router()

// log
server.use(async (ctx, next) => {
  const { method, url } = ctx
  logger.http({ method, url })
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  logger.http({ method, url, status: ctx.status, ms })
})

// server errors
server.use(async (ctx, next) => {
  try {
    return await next()
  } catch (err) {
    logger.error(err)
    const errorData = {
      message: 'Server Error'
    }
    if (process.env.NODE_ENV === 'dev') {
      errorData.message = err.message
    }
    ctx.status = 500
    ctx.body = {
      status: 'ERROR',
      error: errorData
    }
  }
})

router.get('/', async (ctx) => {
  ctx.body = {
    status: 'OK',
    data: {
      app: process.env.APP_ID,
      env: process.env.NODE_ENV,
      distro: process.env.DISTRIBUTION_DOMAIN,
      distro_id: process.env.DISTRIBUTION_ID,
      connection_group_id: process.env.CONNECTION_GROUP_ID
    }
  }
})

router.get('/sites/:siteId/deployments', async (ctx) => {
  const deployments = await app.listDeployments(ctx.params.siteId)
  ctx.body = {
    status: 'OK',
    data: deployments,
    pagination: { count: deployments.length }
  }
})

router.post('/sites/:siteId/deployments', async (ctx) => {
  // TODO: authentication
  const siteId = ctx.params.siteId
  const contentTarball = ReadableStream.from(ctx.req)
  const deployment = await app.createDeployment({ siteId, contentTarball })
  ctx.body = { status: 'OK', data: deployment }
})

router.get('/sites/:siteId/deployments/:deploymentId', async (ctx) => {
  const siteId = ctx.params.siteId
  const deploymentId = ctx.params.deploymentId
  const deployment = await app.getDeployment({ siteId, deploymentId })
  ctx.body = { status: 'OK', data: deployment }
})

router.post('/sites/:siteId/deployments/:deploymentId/promote', async (ctx) => {
  const siteId = ctx.params.siteId
  const deploymentId = ctx.params.deploymentId
  const site = await app.promoteDeployment({ siteId, deploymentId })
  const { currentDeployment, deployedAt } = site
  ctx.body = { status: 'OK', data: { siteId, currentDeployment, deployedAt } }
})

router.delete('/sites/:siteId', async (ctx) => {
  const siteId = ctx.params.siteId

  await app.deleteSite(siteId)
  ctx.body = { status: 'OK', data: { siteId } }
})

server.use(router.routes()).use(router.allowedMethods())

// fallthrough
server.use((ctx) => {
  ctx.status = 404
  ctx.body = {
    status: 'ERROR',
    error: { message: 'Not Found' }
  }
})

exports.server = server
