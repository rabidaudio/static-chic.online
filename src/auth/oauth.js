const { randomBytes } = require('node:crypto')

const logger = require('../logger').getLogger()

const { AuthorizationError, getExpiryTime, isExpired } = require('./auth_utils')
const { findProviderByName } = require('./auth_providers')

const db = require('../db')

const AUTH_REQ_EXPIRE_TIME = 1000 * 60 * 15 // 15 minutes

const OAuth = {
  generateId: () => randomBytes(32).toString('base64url'),

  // create a new signup. Returns an authReqId which should be passed
  // to OAuth flow and used to poll the status
  initiateSignup: async (providerName) => {
    const provider = findProviderByName(providerName)
    const authReqId = this.generateId()

    return await db.put('auth-requests', {
      authReqId,
      expiresAt: getExpiryTime(AUTH_REQ_EXPIRE_TIME),
      state: 'pending',
      authorizationUrl: provider.getAuthorizationUrl(authReqId)
    })
  },

  // check if the OAuth flow is complete.
  // if authorized, return it including the user token and delete for security
  // if expiration time has been reached, mark it as expired
  // otherwise return as-is
  // TODO: it's fine to leave non-authorized requests in the database forever since they
  // contain no sensitive information, but we could have a task that periodically
  // clears out old requests.
  getSignupState: async (authReqId) => {
    const authReq = await db.get('auth-requests', { authReqId })
    if (!authReq) throw new AuthorizationError('Invalid auth request')

    if (isExpired(authReq.expiresAt)) {
      const { expiresAt } = isExpired(authReq.expiresAt)
      logger.info(`auth request ${authReqId} state=expired expiresAt=${expiresAt}`)
      await db.put('auth-requests', { authReqId, state: 'expired', expiresAt })
      return { authReqId, state: 'expired', expiresAt }
    }

    if (authReq.state === 'authorized') {
      logger.info(`auth request ${authReqId} state=authorized userId=${authReq.userId}`)
      await db.delete('auth-requests', { authReqId })
      const { accessToken, ...rest } = authReq
      const userToken = this.generateUserToken(authReq.userId, accessToken)
      return { ...rest, userToken }
    }
    if (authReq.state === 'pending') {
      logger.info(`auth request ${authReqId} state=pending expiresAt=${authReq.expiresAt}`)
      return authReq
    }
    logger.info(`auth request ${authReqId} state=${authReq.state}`)
    return authReq
  },

  handleCallback: async (providerName, ctx) => {
    const provider = findProviderByName(providerName)
    const authReqId = provider.findAuthRequestId(ctx)
    let authReq = await db.get('auth-requests', { authReqId })
    if (!authReq) throw new AuthorizationError('Invalid authReqId')
    if (isExpired(authReq.expiresAt)) throw new AuthorizationError('Auth request expired')
    if (authReq.state !== 'pending') throw new AuthorizationError('Invalid authReq state')

    let res
    try {
      res = await provider.handleCallback(ctx)
    } catch (err) {
      logger.error('access token authorization error', err)
      await db.put('auth-requests', { ...authReq, state: 'failed' })
      throw new AuthorizationError('Authorization of access code failed', { cause: err })
    }
    const userId = `${providerName}_${res.user.userId}`
    const user = await db.put('users', {
      ...res.user,
      userId,
      createdAt: new Date().toISOString()
    })
    authReq = await db.put('auth-requests', {
      ...authReq,
      expiresAt: getExpiryTime(AUTH_REQ_EXPIRE_TIME),
      ...res.authReq,
      state: 'authorized',
      userId
    })
    return user
  },

  generateUserToken: (userId, accessToken) => Buffer.from([userId, accessToken].join(':')).toString('base64'),

  isBasicToken: (authorizationHeader) => authorizationHeader && authorizationHeader.match(/^Basic /),

  parseUserToken: (authorizationHeader) => {
    try {
      const [userId, accessToken] = Buffer.from(authorizationHeader.replace(/^Basic /, ''), 'base64').toString('utf8').split(':')
      const [providerName] = userId.split('_', 1)
      return { userId, accessToken, providerName }
    } catch (err) {
      throw new AuthorizationError('Invalid basic auth', { cause: err })
    }
  },

  authorize: async (authorizationHeader) => {
    const { userId, accessToken, providerName } = this.parseUserAuth(authorizationHeader)
    const provider = findProviderByName(providerName)

    const user = await db.get('users', { userId })
    if (!user) throw new AuthorizationError('User not found')

    let res
    try {
      res = await provider.verifyUser({ user, accessToken })
    } catch (err) {
      throw new AuthorizationError('Authorization of access code failed', { cause: err })
    }

    return await db.put('users', {
      ...user,
      ...res
    })
  }
}

module.exports = OAuth
