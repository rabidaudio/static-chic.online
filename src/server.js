const Koa = require('koa')
const Router = require('@koa/router')

const { configure: configureLogger, getLogger } = require('./logger')
configureLogger({ level: 'verbose', pretty: false })
const logger = getLogger()

const auth = require('./auth')
const { AuthorizationError } = auth
const app = require('./app')

const server = new Koa()
const router = new Router()

// log
server.use(async (ctx, next) => {
  const { method, url } = ctx
  logger.http(`${method} ${url}`)
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  logger.http(`${method} ${url} ${ctx.status} [${ms}ms]`)
})

// server errors
server.use(async (ctx, next) => {
  try {
    return await next()
  } catch (err) {
    const errorData = {
      message: 'Server Error'
    }
    if (process.env.NODE_ENV === 'dev') {
      errorData.details = err.message
      errorData.stack = err.stack.split('\n')
    }

    if (err instanceof AuthorizationError) {
      console.error('authorization error', err)
      ctx.status = 401
      errorData.message = `Authorization Failed: ${err.message}`
    } else {
      // other error
      logger.error('unhandled server error', err)
      ctx.status = 500
    }
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
      distroId: process.env.DISTRIBUTION_ID,
      connectionGroupId: process.env.CONNECTION_GROUP_ID
    }
  }
})

router.post('/signup', async (ctx) => {
  const { authReqId, expiresAt, state, authorizationUrl } = await auth.initiateSignup()
  ctx.body = {
    status: 'OK',
    data: { authReqId, expiresAt, state, authorizationUrl }
  }
})

router.get('/signup/:authReqId', async (ctx) => {
  const { authReqId, expiresAt, state, accessToken, authorizationUrl } = await auth.getSignupState(ctx.params.authReqId)
  ctx.body = {
    status: 'OK',
    data: { authReqId, expiresAt, state, accessToken, authorizationUrl }
  }
})

router.get('/oauth/github/callback', async (ctx) => {
  try {
    const { userId, username, createdAt } = await auth.handleAuthCallback(ctx.query.code, ctx.query.state)
    logger.info('user registered', { userId, username, createdAt })
    ctx.body = 'Authorization complete! You can now close this window.'
  } catch (err) {
    if (err instanceof AuthorizationError) {
      ctx.status = 401
      let body = 'Authorization failed. Please try again.'
      if (process.env.NODE_ENV === 'dev') body += `\n\n${err.message}\n${err.stack}`
      ctx.body = body
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

module.exports = { server }
