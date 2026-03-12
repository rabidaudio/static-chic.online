const { randomBytes } = require('node:crypto')

const logger = require('./logger').getLogger()

const Sites = require('./sites')
const Files = require('./files')

const cfront = require('./cfront')
const db = require('./db')

// generate a unique id per deployment which is sequential in time,
// i.e. when sorted as strings later deployments are always alphabetically
// later
const generateDeploymentId = () => {
  const timestamp = Buffer.alloc(8)
  timestamp.writeBigInt64BE(BigInt(new Date().getTime()))
  const rand = randomBytes(4)
  return 'd_' + Buffer.concat([timestamp, rand]).toString('hex')
}

module.exports = {
  sanitize: (deployment) => {
    const {
      deploymentId, siteId, createdAt
      // exclude: commitSha, invalidationId,
    } = deployment
    return { deploymentId, siteId, createdAt }
  },

  // create a new deployment for a site.
  // Creates a new record in the deployments table, and adds the tarball
  // to the S3 bucket. DeploymentIds are generated so that they are sequential;
  // newer deployments are alphabetically after older ones.
  // NOTE: this does not update the content on the site.
  // For that, call promoteDeployment.
  create: async ({ site, contentTarball }) => {
    const { siteId } = site
    const deploymentId = generateDeploymentId()

    const commitSha = await Files.deploy({
      siteId, deploymentId, tarball: contentTarball, isFirst: !site.gitInitialized
    })

    if (!site.gitInitialized) {
      site = await Sites.update({ ...site, gitInitialized: true })
    }

    logger.info(`create ${siteId}/${deploymentId}`)
    const createdAt = new Date().toISOString()
    const deployment = await db.put('deployments', {
      deploymentId,
      siteId,
      commitSha,
      createdAt
    })
    return this.sanitize(deployment)
  },

  list: async (siteId) => {
    // TODO: pagination?
    const deployments = await db.query('deployments', { siteId }, { asc: false, limit: 100 })
    return deployments.map(d => this.sanitize(d))
  },

  get: async ({ site, deploymentId }) => {
    const { siteId } = site
    const deployment = await db.get('deployments', { siteId, deploymentId })
    return this.sanitize(deployment)
  },
  // make the deployment live for the site
  promote: async ({ site, deploymentId }) => {
    const { siteId } = site
    let deployment = await this.get({ site, deploymentId })
    if (site.currentDeployment === deploymentId) {
    // already deployed, just check the status and return
      return this.sanitize(deployment)
    }

    await Sites.prepareDistribution(site)
    await Files.promote({ siteId, deploymentId })

    if (site.currentDeployment) {
      logger.info('invalidating cache')
      const invalidation = await cfront.invalidate(site.tenantId)
      deployment = await db.put('deployments', { ...deployment, invalidationId: invalidation.Id })
    }

    logger.info('updating site')
    await Sites.trackDeployment(site, deployment)
    return { site, deployment }
  }
}
