const { randomBytes } = require('node:crypto')

const logger = require('../logger').getLogger()

const { AuthorizationError } = require('./auth_utils')

const db = require('../db')

const DeployKeys = {
  // generate a secure random key to grant access to deployments
  generateDeployKey: () => ({
    deployKey: `dk_${randomBytes(32).toString('base64')}`,
    deployCreatedAt: new Date().toISOString(),
    deployKeyLastUsedAt: null
  }),

  obfuscateDeployKey: (deployKey) => deployKey.substr(0, 8) + deployKey.substr(8).replace(/./g, 'x'),

  isBearerToken: (authorizationHeader) => authorizationHeader && authorizationHeader.match(/^Bearer /),

  parseDeployKey: (authorizationHeader) => {
    const deployKey = authorizationHeader.replace(/^Bearer /, '')
    if (!deployKey.match(/^dk_/)) throw new AuthorizationError('Invalid deploy key')
    return deployKey
  },

  authorize: async (authorizationHeader) => {
    const deployKey = this.parseDeployKey(authorizationHeader)

    let [site] = await db.query('sites', { deployKey }, { idx: 'idxDeployKey', limit: 1 })
    if (!site) throw new AuthorizationError('Deploy key invalid')

    site = await db.put('sites', { ...site, deployKeyLastUsedAt: new Date().toISOString() })
    return site
  },

  regenerate: async (site) => {
    logger.info(`regenerating deploy key for site ${site.siteId}`)
    return await db.put('sites', {
      ...site,
      ...this.generateDeployKey()
    })
  }
}

module.exports = DeployKeys
