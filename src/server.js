const Koa = require('koa')
const Router = require('@koa/router')

const { configure: configureLogger, getLogger } = require('./logger')
configureLogger({ level: 'verbose', pretty: false })
const logger = getLogger()

const OAuth = require('./auth/oauth')
const DeployKeys = require('./auth/deploy_keys')
const Sites = require('./sites')
const Deployments = require('./deployments')

const { AuthorizationError } = require('./auth/utils')
const { DomainValidationFailedError } = Sites

const app = new Koa()
const router = new Router()

app.use(require('@koa/bodyparser').bodyParser())

// log requests
app.use(async (ctx, next) => {
  const { method, url } = ctx
  logger.http(`______ ${method} ${url}`)
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  logger.http(`|____ ${ctx.status} [${ms}ms] ${method} ${url}`)
})

// server errors
app.use(async (ctx, next) => {
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
app.use(async (ctx, next) => {
  const authToken = ctx.get('Authorization')
  if (OAuth.isBasicToken(authToken)) {
    ctx.user = await OAuth.authorize(authToken)
    // TODO: if refreshToken used, return an updated bearerToken
  }
  return await next()
})

// deploy key auth `Authorization: Bearer <deployKey>`
app.use(async (ctx, next) => {
  const authToken = ctx.get('Authorization')
  if (DeployKeys.isBearerToken(authToken)) {
    ctx.site = await DeployKeys.authorize(authToken)
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

  // make sure the user owns the site first
  ctx.site = await Sites.getUserSite(ctx.user.userId, ctx.params.siteId)
  if (!ctx.site || ctx.site.userId !== ctx.user.userId) {
    ctx.status = 403
    ctx.body = { status: 'ERROR', error: { message: 'Forbidden' } }
    return
  }
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
  const provider = ctx.query.provider || 'github'
  const { authReqId, expiresAt, state, authorizationUrl } = await OAuth.initiateSignup(provider)
  ctx.body = {
    status: 'OK',
    data: { authReqId, expiresAt, state, authorizationUrl }
  }
})

router.get('/signup/:authReqId', async (ctx) => {
  const authReq = await OAuth.getSignupState(ctx.params.authReqId)
  const { authReqId, expiresAt, state, userToken, authorizationUrl } = authReq
  ctx.body = {
    status: 'OK',
    data: { authReqId, expiresAt, state, userToken, authorizationUrl }
  }
})

router.get('/oauth/:provider/callback', async (ctx) => {
  ctx.set('Content-Type', 'text/html')
  try {
    const { userId, username, createdAt } = await OAuth.handleCallback(ctx.params.provider, ctx)
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
  const data = await Sites.create({ name, userId, customDomain })
  ctx.status = 201 // created
  ctx.body = { status: 'OK', data }
})

router.get('/sites', requireUserAuth, async (ctx) => {
  const { userId } = ctx.user
  const data = await Sites.list(userId)
  // TODO: pagination
  ctx.body = {
    status: 'OK',
    data,
    pagination: { count: data.length }
  }
})

router.get('/sites/:siteId', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const data = await Sites.get(ctx.params.siteId)
  ctx.body = { status: 'OK', data }
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
  let data = ctx.site
  if (customDomain === undefined || (!customDomain && !ctx.site.customDomain) || customDomain === ctx.site.customDomain) {
    ctx.status = 202 // indicate that the custom domain didn't change so nothing happened
  } else {
    data = await Sites.setCustomDomain(ctx.site, customDomain)
  }
  ctx.body = { status: 'OK', data }
})

// To invalidate a deploy key, simply regenerate and forget it
router.post('/sites/:siteId/deployKey/regenerate', requireUserAuth, findSite, async (ctx) => {
  const data = await Sites.regenerateDeployKey(ctx.site)
  ctx.body = { status: 'OK', data }
})

router.delete('/sites/:siteId', requireUserAuth, findSite, async (ctx) => {
  const { siteId } = ctx.site
  await Sites.delete(siteId)
  ctx.body = { status: 'OK', data: { siteId } }
})

router.get('/sites/:siteId/deployments', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const deployments = await Deployments.list(ctx.params.siteId)
  // TODO: pagination
  ctx.body = {
    status: 'OK',
    data: deployments,
    pagination: { count: deployments.length }
  }
})

router.post('/sites/:siteId/deployments', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const site = ctx.site
  const message = ctx.params.message // optional
  const contentTarball = ReadableStream.from(ctx.req)
  const deployment = await Deployments.create({ site, contentTarball, message })
  ctx.status = 201 // created
  ctx.body = { status: 'OK', data: deployment }
})

router.get('/sites/:siteId/deployments/:deploymentId', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const site = ctx.site
  const deploymentId = ctx.params.deploymentId
  const deployment = await Deployments.get({ site, deploymentId })
  ctx.body = { status: 'OK', data: deployment }
})

router.post('/sites/:siteId/deployments/:deploymentId/promote', requireUserAuthOrDeployKey, findSite, async (ctx) => {
  const deploymentId = ctx.params.deploymentId
  if (ctx.site.currentDeployment === deploymentId) {
    ctx.status = 202 // indicate that site is already live, nothing will happen
  }
  const promotion = await Deployments.promote({ site: ctx.site, deploymentId })
  ctx.site = promotion.site
  const { siteId, deployedAt, status, deployment } = ctx.site
  ctx.body = {
    status: 'OK',
    data: {
      siteId, deployedAt, status, deployment
    }
  }
})

app.use(router.routes()).use(router.allowedMethods())

// fallthrough
app.use((ctx) => {
  ctx.status = 404
  ctx.body = {
    status: 'ERROR',
    error: { message: 'Not Found' }
  }
})

module.exports = { app }
