const logger = require('../logger').getLogger()

const { AuthorizationError, getExpiryTime, isExpired } = require('./utils')

module.exports = class GithubAuthProvider {
  getAuthorizationUrl (authReqId) {
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.append('client_id', process.env.GITHUB_CLIENT_ID)
    url.searchParams.append('state', authReqId)
    if (process.env.NODE_ENV !== 'prod') {
      url.searchParams.append('redirect_uri', `${process.env.HOST}/oauth/github/callback`)
    }
    return url.toString()
  }

  findAuthReqId (ctx) {
    return ctx.query.state
  }

  async handleCallback (ctx) {
    const code = ctx.query.code
    const accessInfo = await this.#getAccessToken({ code })
    const githubUser = await this.#getUser(accessInfo.accessToken)

    const { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt } = accessInfo
    const { id, name, email, login } = githubUser
    logger.info(`github: user authorized userId=${id} username=${login}`)

    return {
      user: { userId: id, name, email, login, refreshToken, refreshTokenExpiresAt },
      authReq: { accessToken, expiresAt: accessTokenExpiresAt }
    }
  }

  async verifyUser ({ user, accessToken }) {
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
    const { name, email, login } = await this.#getUser(accessToken)
    return { name, email, login, refreshToken, refreshTokenExpiresAt }
  }

  // must pass either code or refresh token
  async #getAccessToken ({ code, refreshToken }) {
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

  async #getUser (accessToken) {
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
}
