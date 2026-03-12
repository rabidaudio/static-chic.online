const Koa = require('koa')
const Router = require('@koa/router')

const { configure: configureLogger, getLogger } = require('./logger')
configureLogger({ level: 'verbose', pretty: false })
const logger = getLogger()

const auth = require('./auth')
const { AuthorizationError } = auth
const app = require('./app')
const { DomainValidationFailedError } = app

const server = new Koa()
const router = new Router()

server.use(require('@koa/bodyparser').bodyParser())

// explicitly allow parameters to be returned
const serializeSite = (site, { showDeployKey } = {}) => {
  const {
    siteId, name, customDomain, userId,
    currentDeployment, deployedAt, createdAt, status,
    deployKey, deployCreatedAt, deployKeyLastUsedAt
  } = site
  return {
    siteId,
    name,
    customDomain,
    userId,
    currentDeployment,
    deployedAt,
    createdAt,
    status,
    deployCreatedAt,
    deployKeyLastUsedAt,
    deployKey: (showDeployKey ? deployKey : auth.obfuscateDeployKey(deployKey))
  }
}

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

// user auth `Authorization: Basic <base64(userId:accessToken)>`
server.use(async (ctx, next) => {
  const authToken = ctx.get('Authorization')
  if (auth.isBasicToken(authToken)) {
    ctx.user = await auth.authorizeUser(authToken)
    // TODO: if refreshToken used, return an updated bearerToken
  }
  return await next()
})

// deploy key auth `Authorization: Bearer <deployKey>`
server.use(async (ctx, next) => {
  const authToken = ctx.get('Authorization')
  if (auth.isBearerToken(authToken)) {
    ctx.site = await auth.authorizeDeployKey(authToken)
  }
  return await next()
})

const requireUserAuth = async (ctx, next) => {
  if (!ctx.user) throw new AuthorizationError('Not authorized')
  return await next()
}

const requireUserAuthOrDeployKey = async (ctx, next) => {
  if (!ctx.user && !ctx.site) throw new AuthorizationError('Not authorized')
  return await next()
}

const findSite = async (ctx, next) => {
  if (ctx.site) return await next() // already found from deploy key

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

// health check/environment info
router.get('/', async (ctx) => {
  const data = {
    app: process.env.APP_ID,
    env: process.env.NODE_ENV,
    distro: process.env.DISTRIBUTION_DOMAIN
  }
  // important for testing with local environments
  if (process.env.NODE_ENV === 'dev') {
    data.distroId = process.env.DISTRIBUTION_ID
    data.connectionGroupId = process.env.CONNECTION_GROUP_ID
  }
  if (ctx.user) data.userId = ctx.user.userId

  ctx.body = { status: 'OK', data }
})

router.post('/signup', async (ctx) => {
  const { authReqId, expiresAt, state, authorizationUrl } = await auth.initiateSignup()
  ctx.body = {
    status: 'OK',
    data: { authReqId, expiresAt, state, authorizationUrl }
  }
})

router.get('/signup/:authReqId', async (ctx) => {
  const { authReqId, expiresAt, state, userToken, authorizationUrl } = await auth.getSignupState(ctx.params.authReqId)
  ctx.body = {
    status: 'OK',
    data: { authReqId, expiresAt, state, userToken, authorizationUrl }
  }
})

router.get('/oauth/github/callback', async (ctx) => {
  ctx.set('Content-Type', 'text/html')
  try {
    const { userId, username, createdAt } = await auth.handleAuthCallback(ctx.query.code, ctx.query.state)
    logger.info('user registered', { userId, username, createdAt })
    ctx.body = `
      <!DOCTYPE html>
      <html>
        <head>
          <script type="text/javascript">window.close()</script>
        </head>
        <body>
          <p>Authorization complete! You can now close this window.</p>
        </body>
      </html>
    `
  } catch (err) {
    if (err instanceof AuthorizationError) {
      ctx.status = 401
      ctx.body = `
      <!DOCTYPE html>
      <html>
        <head></head>
        <body>
          <p>Authorization failed. Please try again.</p>` +
          (process.env.NODE_ENV === 'dev' ? `<p>${err.message}</p><pre>${err.stack}</pre>` : '') +
    `    </body>
      </html>
    `
    } else {
      throw err
    }
  }
})

router.post('/sites', requireUserAuth, async (ctx) => {
  const { userId } = ctx.user
  const { name, customDomain } = ctx.request.body
  const site = await app.createSite({ name, userId, customDomain })
  ctx.status = 201 // created
  ctx.body = { status: 'OK', data: serializeSite(site, { showDeployKey: true }) }
})

router.get('/sites', requireUserAuth, async (ctx) => {
  const { userId } = ctx.user
  const sites = await app.listSitesForUser(userId)
  // TODO: pagination
  ctx.body = {
    status: 'OK',
    data: sites.map(s => serializeSite(s)),
    pagination: { count: sites.length }
  }
})

router.get('/sites/:siteId', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const site = await app.getSite(ctx.params.siteId)
  ctx.body = { status: 'OK', data: serializeSite(site) }
})

const handleDomainValidationError = async (ctx, next) => {
  try {
    return await next()
  } catch (err) {
    if (err instanceof DomainValidationFailedError) {
      ctx.status = 400
      const { message, code, target, results } = err
      ctx.body = {
        status: 'ERROR',
        error: {
          message: 'Domain validation failed. You must set a CNAME DNS record pointing your custom domain to ' +
          `'${target}' before adding a custom domain. It may take a few minutes after creating the record ` +
          'before the change is detected.',
          reason: message,
          code,
          target,
          results
        }
      }
    } else {
      throw err
    }
  }
}

router.put('/sites/:siteId', requireUserAuth, findSite, handleDomainValidationError, async (ctx) => {
  const { customDomain } = ctx.request.body
  let site = ctx.site
  if (customDomain === undefined || (!customDomain && !site.customDomain) || customDomain === ctx.site.customDomain) {
    ctx.status = 202 // indicate that the custom domain didn't change so nothing happened
  } else {
    site = await app.setSiteCustomDomain(site, customDomain)
  }
  ctx.body = { status: 'OK', data: serializeSite(site) }
})

// To invalidate a deploy key, simply regenerate and forget it
router.post('/sites/:siteId/deployKey/regenerate', requireUserAuth, findSite, async (ctx) => {
  const site = await auth.regenerateDeployKey(ctx.site)
  ctx.body = { status: 'OK', data: serializeSite(site, { showDeployKey: true }) }
})

router.delete('/sites/:siteId', requireUserAuth, findSite, async (ctx) => {
  const { siteId } = ctx.site
  await app.deleteSite(siteId)
  ctx.body = { status: 'OK', data: { siteId } }
})

router.get('/sites/:siteId/deployments', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const deployments = await app.listDeployments(ctx.params.siteId)
  // TODO: pagination
  ctx.body = {
    status: 'OK',
    data: deployments,
    pagination: { count: deployments.length }
  }
})

router.post('/sites/:siteId/deployments', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const site = ctx.site
  const contentTarball = ReadableStream.from(ctx.req)
  const deployment = await app.createDeployment({ site, contentTarball })
  ctx.status = 201 // created
  ctx.body = { status: 'OK', data: deployment }
})

router.get('/sites/:siteId/deployments/:deploymentId', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const site = ctx.site
  const deploymentId = ctx.params.deploymentId
  const deployment = await app.getDeployment({ site, deploymentId })
  ctx.body = { status: 'OK', data: deployment }
})

router.post('/sites/:siteId/deployments/:deploymentId/promote', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  let site = ctx.site
  const deploymentId = ctx.params.deploymentId
  if (site.currentDeployment === deploymentId) {
    ctx.status = 202 // indicate that site is already live, nothing will happen
  }
  const promotion = await app.promoteDeployment({ site, deploymentId })
  site = promotion.site
  const { siteId, deployedAt, status, deployment } = site
  ctx.body = {
    status: 'OK',
    data: {
      siteId, deployedAt, status, deployment
    }
  }
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
