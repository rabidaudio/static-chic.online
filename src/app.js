const dns = require('node:dns/promises')
const { randomBytes } = require('node:crypto')

const namor = require('namor')

const logger = require('./logger').getLogger()

const { generateDeployKey } = require('./auth')
const cfront = require('./cfront')
const db = require('./db')
const git = require('./git')
const r53 = require('./r53')
const s3 = require('./s3')

module.exports.createTarball = git.createTarball

const delay = async (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class DomainValidationFailedError extends Error {
  constructor (message, options) {
    super(message, options)
    this.code = options.code
    this.target = options.target
    if (options.results) this.results = options.results
  }
}
module.exports.DomainValidationFailedError = DomainValidationFailedError

// generate a unique human-friendly id for each site to be used
// as a subdomain.
const generateSiteId = () => {
  // space size: 7948^2*(26+10)^5 = 3.8 quadrillion
  // ~50% chance of collision in sqrt() -> ~62 million
  const name = namor.generate({ words: 2, salt: 5 })
  if (!namor.valid_subdomain(name, { reserved: true })) { return generateSiteId() } // try again
  return name
}

// generate a unique id per deployment which is sequential in time,
// i.e. when sorted as strings later deployments are always alphabetically
// later
const generateDeployId = () => {
  const timestamp = Buffer.alloc(8)
  timestamp.writeBigInt64BE(BigInt(new Date().getTime()))
  const rand = randomBytes(4)
  return Buffer.concat([timestamp, rand]).toString('hex')
}

// module.exports.createUser = async ({ userId, name }) => {
//   return await db.put('users', {
//     userId,
//     name,
//     createdAt: new Date().toISOString()
//   })
// }

// module.exports.getUser = async (userId) => {
//   return await db.get('users', { userId })
// }

module.exports.listSitesForUser = async (userId) => {
  // TODO: pagination
  const sites = await db.query('sites', { userId }, { idx: 'idxUserId', asc: false, limit: 100 })
  return sites
}

// create a site. A site has a siteId which is
// a randomly generated subdomain like `estate-specify-07euk`,
// a deploy key used to authenticate deployments, a name,
// a userId which owns it.
module.exports.createSite = async ({ name, userId, customDomain }) => {
  const siteId = generateSiteId()
  logger.info(`generating ${siteId}`)

  if (customDomain) {
    await this.verifyCustomDomain(siteId, customDomain)
  }

  await r53.createSubdomain(siteId)
  const site = await db.put('sites', {
    siteId,
    userId,
    name,
    customDomain,
    gitInitialized: false,
    createdAt: new Date().toISOString(),
    ...generateDeployKey()
  })
  return await getSiteWithStatus(site)
}

const getSiteWithStatus = async (site) => {
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
      status = invalidation.Status.toLowerCase()
    } else {
      const distro = await cfront.getTenant(tenantId)
      status = distro.Status.toLowerCase() // InProgress, Complete, ??
    }
  }
  return { ...site, status }
}

module.exports.getSite = async (siteId) => {
  const site = await db.get('sites', { siteId })
  return await getSiteWithStatus(site)
}

// Check if the customDomain is pointing correctly. Will throw a DomainValidationFailedError
// if not, return silently if verified
module.exports.verifyCustomDomain = async (siteId, customDomain) => {
  const target = r53.getSiteDomain(siteId)
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
}

// add/remove custom domain
module.exports.setSiteCustomDomain = async (site, customDomain) => {
  const { siteId, tenantId, etag } = site
  if (customDomain) await this.verifyCustomDomain(siteId, customDomain)

  // if distro exists, update it
  if (tenantId) {
    logger.info(`updating tenant ${siteId}: domain=${customDomain || 'default'}`)
    const baseDomain = r53.getSiteDomain(siteId)
    const res = await cfront.updateTenant({ tenantId, siteId, baseDomain, customDomain, etag })
    site.etag = res.etag
  }
  // otherwise will set on first deploy

  site = await db.put('sites', { ...site, customDomain })
  return await getSiteWithStatus(site)
}

// create a new deployment for a site.
// Creates a new record in the deployments table, and adds the tarball
// to the S3 bucket. DeploymentIds are generated so that they are sequential;
// newer deployments are alphabetically after older ones.
// NOTE: this does not update the content on the site.
// For that, call promoteDeployment.
module.exports.createDeployment = async ({ site, contentTarball }) => {
  const { siteId } = site
  const deploymentId = generateDeployId()

  const commitSha = await (site.gitInitialized
    ? git.addDeployment({ siteId, deploymentId, tarball: contentTarball })
    : git.initializeSite({ siteId, deploymentId, tarball: contentTarball }))

  if (!site.gitInitialized) {
    await db.put('sites', { ...site, gitInitialized: true })
  }

  logger.info(`create ${siteId}/${deploymentId}`)
  const createdAt = new Date().toISOString()
  await db.put('deployments', {
    deploymentId,
    siteId,
    commitSha,
    createdAt
  })
  return { deploymentId, siteId, createdAt }
}

module.exports.listDeployments = async (siteId) => {
  // TODO: pagination?
  return await db.query('deployments', { siteId }, { asc: false, limit: 100 })
}

module.exports.getDeployment = async ({ site, deploymentId }) => {
  const { siteId } = site
  return await db.get('deployments', { siteId, deploymentId })
}

const createDistribution = async ({ siteId, customDomain }) => {
  const baseDomain = r53.getSiteDomain(siteId)
  const { tenant, etag } = await cfront.createTenant({ siteId, customDomain, baseDomain })
  logger.verbose('tenant distro created', tenant)
  return { tenantId: tenant.Id, status: tenant.Status, etag }
}

// make the deployment live for the site
module.exports.promoteDeployment = async ({ site, deploymentId }) => {
  const { siteId } = site
  let deployment = await this.getDeployment({ site, deploymentId })
  if (site.currentDeployment === deploymentId) {
    // already deployed, just check the status and return
    return deployment
  }

  if (!site.tenantId) {
    // logger.warn(
    //   'This is the first deployment published to the site, so it will take longer ' +
    //   'than usual to go live. Future deployments should be much quicker.'
    // ) // TODO: move to cli
    logger.info('creating distro tenant')
    const { tenant, etag } = await createDistribution(site)
    site.tenantId = tenant.tenantId
    site.etag = etag
    await db.put('sites', site)
  }

  await git.promoteDeployment(siteId, deploymentId)

  if (site.currentDeployment) {
    logger.info('invalidating cache')
    const invalidation = await cfront.invalidate(site.tenantId)
    deployment = await db.put('deployments', { ...deployment, invalidationId: invalidation.Id })
  }

  logger.info('updating site')
  site = await db.put('sites', {
    ...site,
    currentDeployment: deploymentId,
    deployedAt: new Date().toISOString()
  })
  site = await getSiteWithStatus(site)
  return { site, deployment }
}

module.exports.deleteSite = async (siteId) => {
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
    ).then(() => r53.deleteSubdomain(siteId))
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

// TODO: await tenant created

module.exports.awaitInvalidationComplete = async ({ siteId, deploymentId }) => {
  const site = await db.get('sites', { siteId })
  const deployment = await db.get('deployments', { siteId, deploymentId })
  if (!deployment.invalidationId) {
    logger.info(`no invalidations for ${siteId}/${deploymentId}`)
    return
  }

  logger.info(`waiting for invalidation ${siteId}/${deploymentId}`)
  while (true) {
    const invalidation = await cfront.getInvalidation(site.tenantId, deployment.invalidationId)
    logger.info(`invalidation status: ${invalidation.Status}`)
    if (invalidation.Status === 'Completed') return invalidation
    await delay(5000)
  }
}

module.exports.wipeEverything = async () => {
  if (process.env.NODE_ENV !== 'dev') throw new Error('Can only destroy dev environments')

  logger.warn('deleting everything!')
  await s3.deleteRecursive('')
  for await (const { siteId } of db.scan('sites')) {
    await this.deleteSite(siteId)
  }
  for await (const { userId } of db.scan('users')) {
    await db.delete('users', { userId })
    logger.info(`deleted user ${userId}`)
  }
}
