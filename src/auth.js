const { randomBytes } = require('node:crypto')

const logger = require('./logger').getLogger()

const db = require('./db')

class AuthorizationError extends Error {}

const AUTH_REQ_EXPIRE_TIME = 1000 * 60 * 15 // 15 minutes

const getExpiryTime = (fromNow = AUTH_REQ_EXPIRE_TIME) => new Date(new Date().getTime() + fromNow).toISOString()

const isExpired = (expiresAt) => new Date().getTime() >= new Date(expiresAt).getTime()

const generateAuthReqId = () => randomBytes(32).toString('base64url')

const generateUserToken = (userId, accessToken) => Buffer.from([userId, accessToken].join(':')).toString('base64')

// generate a secure random key to grant access to deployments
const generateDeployKey = () => ({
  deployKey: `depkey_${randomBytes(32).toString('base64')}`,
  deployCreatedAt: new Date().toISOString(),
  deployKeyLastUsedAt: null
})

const obfuscateDeployKey = (deployKey) => deployKey.substr(0, 12) + deployKey.substr(12).replace(/./g, 'x')

const isBasicToken = (authorizationHeader) => authorizationHeader && authorizationHeader.match(/^Basic /)

const parseUserAuth = (authorizationHeader) => {
  try {
    const [userId, accessToken] = Buffer.from(authorizationHeader.replace(/^Basic /, ''), 'base64').toString('utf8').split(':')
    return { userId, accessToken }
  } catch (err) {
    throw new AuthorizationError('Invalid basic auth', { cause: err })
  }
}

const isBearerToken = (authorizationHeader) => authorizationHeader && authorizationHeader.match(/^Bearer /)

const parseDeployKey = (authorizationHeader) => {
  const deployKey = authorizationHeader.replace(/^Bearer /, '')
  if (!deployKey.match(/^depkey_/)) throw new AuthorizationError('Invalid deploy key')
  return deployKey
}

module.exports = { AuthorizationError, generateDeployKey, obfuscateDeployKey, parseUserAuth, parseDeployKey, isBasicToken, isBearerToken }

const getGithubAuthorizationUrl = (authReqId) => {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.append('client_id', process.env.GITHUB_CLIENT_ID)
  url.searchParams.append('state', authReqId)
  if (process.env.NODE_ENV !== 'prod') {
    url.searchParams.append('redirect_uri', `${process.env.HOST}/oauth/github/callback`)
  }
  return url.toString()
}

// create a new signup. Returns an authReqId which should be passed
// to OAuth flow and used to poll the status
module.exports.initiateSignup = async () => {
  const authReqId = generateAuthReqId()

  const authReq = await db.put('auth-requests', {
    authReqId,
    expiresAt: getExpiryTime(),
    state: 'pending'
  })
  return { ...authReq, authorizationUrl: getGithubAuthorizationUrl(authReqId) }
}

// check if the OAuth flow is complete.
// if authorized, return it including the user token and delete for security
// if expiration time has been reached, mark it as expired
// otherwise return as-is
// TODO: it's fine to leave non-authorized requests in the database forever since they
// contain no sensitive information, but we could have a task that periodically
// clears out old requests.
module.exports.getSignupState = async (authReqId) => {
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
    const userToken = generateUserToken(authReq.userId, accessToken)
    return { ...rest, userToken }
  }
  if (authReq.state === 'pending') {
    logger.info(`auth request ${authReqId} state=pending expiresAt=${authReq.expiresAt}`)
    return { ...authReq, authorizationUrl: getGithubAuthorizationUrl(authReqId) }
  }
  logger.info(`auth request ${authReqId} state=${authReq.state}`)
  return authReq
}

// must pass either code or refresh token
const getGithubAccessToken = async ({ code, refreshToken }) => {
  // https:// docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github
  logger.http('github: POST https://github.com/login/oauth/access_token')
  const reqBody = {
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET
  }
  if (code) {
    reqBody.code = code
  } else if (refreshToken) {
    reqBody.refresh_token = refreshToken
    reqBody.grant_type = 'refresh_token'
  }
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    body: JSON.stringify(reqBody),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
  })
  logger.http(`github: POST https://github.com/login/oauth/access_token - ${res.status}`)
  const body = await res.json()
  if (body.error) { // res.status >= 400 github returns 200 status code guuuhh
    throw new AuthorizationError(`Github authorize failed: ${body.error} - ${body.error_description}`)
  }
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: getExpiryTime(body.expires_in * 1000),
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt: getExpiryTime(body.refresh_token_expires_in * 1000)
  }
}

const getGithubUser = async (accessToken) => {
  // TODO: octokit seems to ruin node treating the app as cjs
  // const { Octokit } = require("octokit") // await import
  // const client = new Octokit({ auth: accessToken })
  // const { data } = await client.rest.users.getAuthenticated()
  // return data

  // https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28
  logger.http('github: GET https://api.github.com/user')
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json'
    }
  })
  if (res.status !== 200) {
    logger.error('github: get user failed', res.body)
    throw new Error(`Github: get user request failed: ${res.status}`)
  }
  return await res.json()
}

module.exports.handleAuthCallback = async (code, state) => {
  const authReqId = state
  let authReq = await db.get('auth-requests', { authReqId })
  if (!authReq) throw new AuthorizationError('Invalid authReqId')
  if (isExpired(authReq.expiresAt)) throw new AuthorizationError('Auth request expired')
  if (authReq.state !== 'pending') throw new AuthorizationError('Invalid authReq state')

  let accessInfo, githubUser
  try {
    accessInfo = await getGithubAccessToken({ code })
    githubUser = await getGithubUser(accessInfo.accessToken)
  } catch (err) {
    logger.error('access token authorization error', err)
    await db.put('auth-requests', { ...authReq, state: 'failed' })
    throw new AuthorizationError('Authorization of access code failed', { cause: err })
  }
  const { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt } = accessInfo
  const { name, email, login } = githubUser
  const userId = `github_${githubUser.id}`
  logger.info(`github: ${authReqId} user authorized userId=${userId} username=${login}`)
  const user = await db.put('users', {
    userId,
    name,
    email,
    username: login,
    refreshToken,
    refreshTokenExpiresAt,
    createdAt: new Date().toISOString()
  })
  authReq = await db.put('auth-requests', {
    ...authReq,
    accessToken,
    state: 'authorized',
    userId,
    expiresAt: accessTokenExpiresAt
  })
  return user
}

module.exports.authorizeUser = async (authorizationHeader) => {
  const { userId, accessToken } = parseUserAuth(authorizationHeader)

  const user = await db.get('users', { userId })
  if (!user) throw new AuthorizationError('User not found')

  let githubUser
  try {
    githubUser = await getGithubUser(accessToken)
  } catch (err) {
    const { refreshToken, refreshTokenExpiresAt } = user
    if (refreshToken && !isExpired(refreshTokenExpiresAt)) {
      // TODO: if a refresh token is available, try that
      // https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
      // try {
      //   const { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt } = getGithubAccessToken({ refreshToken })
      // } catch (err) {
      //   throw new AuthorizationError('Authorization of access code failed', { cause: err })
      // }
    }

    throw new AuthorizationError('Authorization of access code failed', { cause: err })
  }

  const { name, email, login } = githubUser
  return await db.put('users', {
    ...user,
    name,
    email,
    username: login
    // refreshToken,
    // refreshTokenExpiresAt,
  })
}

module.exports.authorizeDeployKey = async (authorizationHeader) => {
  const deployKey = parseDeployKey(authorizationHeader)

  let [site] = await db.query('sites', { deployKey }, { idx: 'idxDeployKey', limit: 1 })
  if (!site) throw new AuthorizationError('Deploy key invalid')

  site = await db.put('sites', { ...site, deployKeyLastUsedAt: new Date().toISOString() })
  return site
}

module.exports.regenerateDeployKey = async (site) => {
  return await db.put('sites', {
    ...site,
    ...generateDeployKey()
  })
}
