const { randomBytes } = require('node:crypto')

const fetch = require('node-fetch')

const logger = require('./logger').getLogger()

const db = require('./db')

class AuthorizationError extends Error {}
module.exports.AuthorizationError = AuthorizationError

const AUTH_REQ_EXPIRE_TIME = 1000 * 60 * 15 // 15 minutes

const getExpiryTime = (fromNow = AUTH_REQ_EXPIRE_TIME) => new Date(new Date().getTime() + fromNow).toISOString()

const isExpired = (authReq) => new Date().getTime() >= new Date(authReq.expiresAt).getTime()

const generateAuthReqId = () => randomBytes(32).toString('base64url')

const getGithubAuthorizationUrl = (authReqId) => {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.append('client_id', process.env.GITHUB_CLIENT_ID)
  url.searchParams.append('state', authReqId)
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
  return { authReq, authorizationUrl: getGithubAuthorizationUrl(authReqId) }
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

  if (isExpired(authReq)) {
    const { expiresAt } = isExpired(authReq)
    logger.info(`auth request ${authReqId} state=expired expiresAt=${expiresAt}`)
    await db.put('auth-requests', { authReqId, state: 'expired', expiresAt })
    return { authReqId, state: 'expired', expiresAt }
  }

  if (authReq.state === 'authorized') {
    logger.info(`auth request ${authReqId} state=authorized userId=${authReq.userId}`)
    await db.delete('auth-requests', { authReqId })
    return authReq
  }
  if (authReq.state === 'pending') {
    logger.info(`auth request ${authReqId} state=pending expiresAt=${authReq.expiresAt}`)
    return { authReq, authorizationUrl: getGithubAuthorizationUrl(authReqId) }
  }
  logger.info(`auth request ${authReqId} state=${authReq.state}`)
  return authReq
}

const getGithubAccessToken = async (code) => {
  // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github
  logger.http('github: POST https://github.com/login/oauth/access_token')
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code
    }),
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
  // https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28
  logger.http('github: GET https://api.github.com/user')
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json'
    }
  })
  if (res.status !== 200) throw new Error(`Github: get user request failed: ${res.status}`)
  return await res.json()
}

module.exports.handleAuthCallback = async (code, state) => {
  const authReqId = state
  let authReq = await db.get('auth-requests', { authReqId })
  if (!authReq) throw new AuthorizationError('Invalid authReqId')
  if (isExpired(authReq)) throw new AuthorizationError('Auth request expired')
  if (authReq.state !== 'pending') throw new AuthorizationError('Invalid authReq state')

  let accessInfo, githubUser
  try {
    accessInfo = await getGithubAccessToken(code)
    githubUser = await getGithubUser(accessInfo.accessToken)
  } catch (err) {
    await db.put('auth-requests', { ...authReq, state: 'failed' })
    if (err instanceof AuthorizationError) throw err
    throw new AuthorizationError('Authorization of access code failed', { cause: err })
  }
  const { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt } = accessInfo
  const { name, email, login } = githubUser
  const userId = `github:${githubUser.id}`
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

/*

1. save auth-request with securerandom authreq
2. send user to below, passing authreq in state

https://github.com/login/oauth/authorize ?client_id=...&state=...

3. app polls API with authreq waiting for auth

when user authenticates, API is called:

https://api.dev.static-chic.online/oauth/github/callback ?code=... & state=...

4. API finds existing authReq from state
5. API gets access token

POST https://github.com/login/oauth/access_token ?
    "client_id" => CLIENT_ID,
    "client_secret" => CLIENT_SECRET,
    "code" => code
    -> access_token expires_in refresh_token refresh_token_expires_in

GET https://api.github.com/user
    Authorization: Bearer access_token
    -> user_info

6. API upserts user record, saving access token to authreq and refresh token to user. points authreq to user
7. When authreq is polled again, returns authreq+access_token and deletes
8. client saves auth_token

later for auth

1. client makes api call with access token
2. server checks if access token is valid. If so finds user by userId, continues
3. else checks refresh token. If valid, sends new access token to client, continues
4. else auth failed, need to re-auth

------

POST https://github.com/login/device/code
    body: application/x-www-form-urlencoded CLIENT_ID
        -> JSON verification_uri, user_code, device_code, and interval

send user to verification_uri to input user_code

Poll for access token:

POST https://github.com/login/oauth/access_token
    body: application/x-www-form-urlencoded CLIENT_ID, device_code, grant_type=urn:ietf:params:oauth:grant-type:device_code
        -> JSON error,access_token

save access token

verify validity

GET https://api.github.com/user
    "Accept" => "application/vnd.github+json", "Authorization" => "Bearer #{token}"

*/
