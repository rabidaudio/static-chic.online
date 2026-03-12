const dns = require('node:dns/promises')

const namor = require('namor')

const logger = require('./logger').getLogger()

const { generateDeployKey, obfuscateDeployKey } = require('./auth/deploy_keys')
const cfront = require('./cfront')
const db = require('./db')
const git = require('./files')
const r53 = require('./r53')
const s3 = require('./s3')

class DomainValidationFailedError extends Error {
  constructor (message, options) {
    super(message, options)
    this.code = options.code
    this.target = options.target
    if (options.results) this.results = options.results
  }
}

const serialize = async (site, opts = {}) => sanitize({ ...site, status: (await getStatus(site)) }, opts)

// generate a unique human-friendly id for each site to be used
// as a subdomain.
const generateSiteId = () => {
  // space size: 7948^2*(26+10)^5 = 3.8 quadrillion
  // ~50% chance of collision in sqrt() -> ~62 million
  const name = namor.generate({ words: 2, salt: 5 })
  if (!namor.valid_subdomain(name, { reserved: true })) { return generateSiteId() } // try again
  return name
}

const getSiteDomain = (siteId) => `${siteId}.${process.env.SITES_DOMAIN}`

module.exports = {
  DomainValidationFailedError,

  getUserSite: async (userId, siteId) => {
    const userSites = await db.query('sites', { userId }, { idx: 'idxUserId', asc: false, limit: 100 })
    return userSites.find(s => s.siteId === siteId)
  },

  list: async (userId) => {
    // TODO: pagination
    const sites = await db.query('sites', { userId }, { idx: 'idxUserId', asc: false, limit: 100 })
    // return Promise.all(sites.map(s => serialize(s)))
    // NOTE: not looking up statuses for performance
    return sites.map(s => sanitize(s))
  },

  // create a site. A site has a siteId which is
  // a randomly generated subdomain like `estate-specify-07euk`,
  // a deploy key used to authenticate deployments, a name,
  // a userId which owns it.
  create: async ({ name, userId, customDomain }) => {
    const siteId = generateSiteId()
    const siteDomain = getSiteDomain(siteId)
    logger.info(`generating ${siteId}`)

    if (customDomain) {
      await this.verifyCustomDomain(siteId, customDomain)
    }

    await r53.createSubdomain(siteDomain)
    const site = await db.put('sites', {
      siteId,
      userId,
      name,
      customDomain,
      gitInitialized: false,
      createdAt: new Date().toISOString(),
      ...generateDeployKey()
    })
    return await serialize(site, { showDeployKey: true })
  },

  get: async (siteId) => {
    const site = await db.get('sites', { siteId })
    return await serialize(site)
  },

  update: async (site) => {
    site = await db.put('sites', site)
    return await serialize(site)
  },

  // Check if the customDomain is pointing correctly. Will throw a DomainValidationFailedError
  // if not, return silently if verified
  verifyCustomDomain: async (siteId, customDomain) => {
    const target = getSiteDomain(siteId)
    try {
      const results = await dns.resolveCname(customDomain)
      if (results.length === 0) {
        throw new DomainValidationFailedError('record has no value', { code: 'INVALID', target })
      }
      if (results[0] === target) return // ok
      if (results[0] === process.env.DISTRIBUTION_DOMAIN) return // ok also
      throw new DomainValidationFailedError('record has incorrect value', { code: 'INVALID', target, results })
    } catch (err) {
      if (err.code === 'ENOTFOUND') {
        throw new DomainValidationFailedError('domain name has no records', { code: 'NOT_FOUND', target, cause: err })
      }
      if (err.code === 'ENODATA') {
        throw new DomainValidationFailedError('domain name has non-CNAME records', { code: 'NOT_FOUND', target, cause: err })
      }
      throw new DomainValidationFailedError(err.message, { code: 'UNKNOWN', target, cause: err })
    }
  },

  // add/remove custom domain
  setCustomDomain: async (site, customDomain) => {
    const { siteId, tenantId, etag } = site
    if (customDomain) await this.verifyCustomDomain(siteId, customDomain)

    // if distro exists, update it
    if (tenantId) {
      logger.info(`updating tenant ${siteId}: domain=${customDomain || 'default'}`)
      const baseDomain = getSiteDomain(siteId)
      const res = await cfront.updateTenant({ tenantId, siteId, baseDomain, customDomain, etag })
      site.etag = res.etag
    }
    // otherwise will set on first deploy

    site = await db.put('sites', { ...site, customDomain })
    return await serialize(site)
  },

  prepareDistribution: async (site) => {
    if (site.tenantId) return site

    logger.info('creating distro tenant')
    const { siteId, customDomain } = site
    const baseDomain = getSiteDomain(siteId)
    const { tenant, etag } = await cfront.createTenant({ siteId, customDomain, baseDomain })
    logger.verbose('tenant distro created', tenant)
    return await db.put('sites', { ...site, tenantId: tenant.Id, etag })
  },

  trackDeployment: async (site, deployment) => {
    return await db.put('sites', {
      ...site,
      currentDeployment: deployment.deploymentId,
      deployedAt: new Date().toISOString()
    })
  },

  regenerateDeployKey: async (site) => {
    site = await db.put('sites', {
      ...site,
      ...generateDeployKey()
    })
    return sanitize(site, { showDeployKey: true })
  },

  delete: async (siteId) => {
    logger.warn(`deleting site ${siteId}`)
    const { tenantId, etag } = await db.get('sites', { siteId })
    const deleteDeploymentsForSite = async (siteId) => {
      for (const { deploymentId } in await db.scan('deployments', { siteId })) {
        logger.info(`deleting ${siteId}/${deploymentId}`)
        await db.delete('deployments', { siteId, deploymentId })
      }
    }
    await Promise.all([
    // delete resources
      (tenantId
        ? cfront.deleteTenant({ tenantId, etag }).then(logger.info(`[${siteId}] deleted distribution tenant`))
        : Promise.resolve()
      ).then(() => r53.deleteSubdomain(getSiteDomain(siteId)))
        .then(logger.info(`[${siteId}] deleted subdomain route`)),

      // delete data from S3
      s3.deleteRecursive(git.getSiteContentKey(siteId)).then(() => logger.info(`[${siteId}] deleted site content`)),
      s3.deleteRecursive(git.getSiteDeploymentsKey(siteId)).then(() => logger.info(`[${siteId}] deleted deployment data`)),
      // delete all deployments from db
      deleteDeploymentsForSite(siteId)
        .then(() => logger.info(`[${siteId}] deleted deployment history`))
      // delete site from db
        .then(() => db.delete('sites', { siteId }))
        .then(() => logger.info(`[${siteId}] deleted site`))
    ])
    logger.info(`site deleted: ${siteId}`)
  }
}

// explicitly allow parameters to be returned
const sanitize = (site, { showDeployKey } = {}) => {
  const {
    siteId, name, customDomain, userId,
    currentDeployment, deployedAt, createdAt, status,
    deployKey, deployKeyCreatedAt, deployKeyLastUsedAt
    // excluding:
    // etag, gitInitialized, tenantId
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
    deployKeyCreatedAt,
    deployKeyLastUsedAt,
    deployKey: (showDeployKey ? deployKey : obfuscateDeployKey(deployKey))
  }
}

const getStatus = async (site) => {
  const { siteId, currentDeployment, tenantId } = site
  let status = 'unknown'
  if (!currentDeployment) {
    status = 'inactive' // no deployment
  } else if (!tenantId) {
    status = 'unknown'
  } else {
    const deployment = await db.get('deployments', { siteId, deploymentId: currentDeployment })
    if (deployment.invalidationId) {
      const invalidation = await cfront.getInvalidation(tenantId, deployment.invalidationId)
      if (invalidation.Status) {
        status = invalidation.Status.toLowerCase()
      }
    } else {
      const distro = await cfront.getTenant(tenantId)
      if (distro.Status) {
        status = distro.Status.toLowerCase() // InProgress, Complete, ??
      }
    }
  }
  return status
}
