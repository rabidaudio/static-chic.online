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

server.use(require('@koa/bodyparser').bodyParser())

// log requests
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

// bearer token auth
server.use(async (ctx, next) => {
  const bearerToken = ctx.get('Authorization')
  if (bearerToken) {
    ctx.user = await auth.authorizeUser(bearerToken)
    // TODO: if refreshToken used, return an updated bearerToken
  }
  return await next()
})

const requireUserAuthMiddleware = async (ctx, next) => {
  if (!ctx.user) throw new AuthorizationError('Not authorized')
  return await next()
}

const findSiteMiddleware = async (ctx, next) => {
  const siteId = ctx.params.siteId
  // make sure the user owns the site first
  const userSites = await app.listSitesForUser(ctx.user.userId)
  const site = userSites.find(s => s.siteId === siteId)
  if (!site || site.userId !== ctx.user.userId) {
    ctx.status = 403
    ctx.body = { status: 'ERROR', error: { message: 'Forbidden' } }
    return
  }
  ctx.site = site
  return await next()
}

router.get('/', async (ctx) => {
  ctx.body = {
    status: 'OK',
    data: {
      app: process.env.APP_ID,
      env: process.env.NODE_ENV,
      distro: process.env.DISTRIBUTION_DOMAIN,
      distroId: process.env.DISTRIBUTION_ID,
      connectionGroupId: process.env.CONNECTION_GROUP_ID,
      userId: ctx.user && ctx.user.userId
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

router.post('/sites', requireUserAuthMiddleware, async (ctx) => {
  const { userId } = ctx.user
  const { name, customDomain } = ctx.request.body
  const site = await app.createSite({ name, userId, customDomain })
  ctx.body = { status: 'OK', data: site }
})

router.get('/sites', requireUserAuthMiddleware, async (ctx) => {
  const { userId } = ctx.user
  const sites = await app.listSitesForUser(userId)
  // TODO: pagination
  ctx.body = {
    status: 'OK',
    data: sites,
    pagination: { count: sites.length }
  }
})

router.get('/sites/:siteId', requireUserAuthMiddleware, findSiteMiddleware, async (ctx) => {
  ctx.body = { status: 'OK', data: ctx.site }
})

router.delete('/sites/:siteId', requireUserAuthMiddleware, findSiteMiddleware, async (ctx) => {
  const { siteId } = ctx.site
  await app.deleteSite(siteId)
  ctx.body = { status: 'OK', data: { siteId } }
})

// router.get('/sites/:siteId/deployments', requireUserAuthMiddleware, findSiteMiddleware, async (ctx) => {
//   const deployments = await app.listDeployments(ctx.params.siteId)
//   // TODO: pagination
//   ctx.body = {
//     status: 'OK',
//     data: deployments,
//     pagination: { count: deployments.length }
//   }
// })

// router.post('/sites/:siteId/deployments', async (ctx) => {
//   const siteId = ctx.params.siteId
//   const contentTarball = ReadableStream.from(ctx.req)
//   const deployment = await app.createDeployment({ siteId, contentTarball })
//   ctx.body = { status: 'OK', data: deployment }
// })

// router.get('/sites/:siteId/deployments/:deploymentId', async (ctx) => {
//   const siteId = ctx.params.siteId
//   const deploymentId = ctx.params.deploymentId
//   const deployment = await app.getDeployment({ siteId, deploymentId })
//   ctx.body = { status: 'OK', data: deployment }
// })

// router.post('/sites/:siteId/deployments/:deploymentId/promote', async (ctx) => {
//   const siteId = ctx.params.siteId
//   const deploymentId = ctx.params.deploymentId
//   const site = await app.promoteDeployment({ siteId, deploymentId })
//   const { currentDeployment, deployedAt } = site
//   ctx.body = { status: 'OK', data: { siteId, currentDeployment, deployedAt } }
// })

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
