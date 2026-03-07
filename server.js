const Koa = require('koa')
const Router = require('@koa/router')

const app = require('./app')

const server = new Koa()
const router = new Router()

// log
server.use(async (ctx, next) => {
  console.log(`${ctx.method} ${ctx.url}`)
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  console.log(`[${ctx.status}] ${ctx.method} ${ctx.url} - ${ms}ms\n`)
})

// server errors
server.use(async (ctx, next) => {
  try {
    return await next()
  } catch (err) {
    console.error(err.stack)
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

// router.get('/sites/:siteId/deployments/:deploymentId', async (ctx) => {})

router.post('/sites/:siteId/deployments/:deploymentId/promote', async (ctx) => {
  const siteId = ctx.params.siteId
  const deploymentId = ctx.params.deploymentId
  const site = await app.promoteDeployment({ siteId, deploymentId })
  const { currentDeployment, deployedAt } = site
  ctx.body = { status: 'OK', data: { siteId, currentDeployment, deployedAt } }
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
