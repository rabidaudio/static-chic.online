const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { glob, mkdtemp, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { pipeline } = require('node:stream/promises')

const mime = require('mime-types')
const namor = require('namor')
const tar = require('tar')

const cfront = require('./cfront')
const cform = require('./cform')
const db = require('./db')
const s3 = require('./s3')

const delay = async (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// where deployments are stored on S3
const siteDeploymentsKeyPrefix = (siteId) => `deployments/${siteId}`
const deploymentTarballKey = (siteId, deploymentId) =>
  `${siteDeploymentsKeyPrefix(siteId)}/${deploymentId}.tar.gz`

// where live site content is stored on S3
const siteContentKeyPrefix = (siteId) => `sites/${siteId}/content`

// generate a unique human-friendly id for each site to be used
// as a subdomain.
const generateSiteId = () => {
  // space size: 7948^2*(26+10)^5 = 3.8 quadrillion
  // ~50% chance of collision in sqrt() -> ~62 million
  const name = namor.generate({ words: 2, salt: 5 })
  if (!namor.valid_subdomain(name, { reserved: true })) { return generateSiteId() } // try again
  return name
}

// generate a secure random key to grant access to deployments
const generateDeployKey = () => randomBytes(32).toString('base64')

// generate a unique id per deployment which is sequential in time,
// i.e. when sorted as strings later deployments are always alphabetically
// later
const generateDeployId = () => {
  const timestamp = Buffer.alloc(8)
  timestamp.writeBigInt64BE(BigInt(new Date().getTime()))
  const rand = randomBytes(4)
  return Buffer.concat([timestamp, rand]).toString('hex')
}

exports.createUser = async ({ userId, name }) => {
  return await db.put('users', {
    userId,
    name,
    createdAt: new Date().toISOString()
  })
}

exports.getUser = async (userId) => {
  return await db.show('users', { userId })
}

// create a site. A site has a siteId which is
// a randomly generated subdomain like `estate-specify-07euk`,
// a deploy key used to authenticate deployments, a name,
// a userId which owns it.
exports.createSite = async ({ name, userId }) => {
  const siteId = generateSiteId()
  console.log('generating', siteId)

  const { stackId, operationId } = await cform.createSite({ siteId })

  // TODO: should we create on first deploy instead??
  return await db.put('sites', {
    siteId,
    userId,
    name,
    stackId,
    latestOperationId: operationId,
    deployKey: generateDeployKey(),
    createdAt: new Date().toISOString()
  })
}

// exports.waitForStack = async (site, callback = () => {}) => {
//   if (!site.latestOperationId) return

//   while (true) {
//     const operation = await cform.getStackStatus(site.siteId, site.latestOperationId)
//     callback(operation.Status)

//     switch (operation.Status) {
//       case 'SUCCEEDED': return operation
//       case 'FAILED': throw new Error("Stack failed") // TODO: get error info
//       case 'STOPPED': throw new Error("Stack was stopped")
//       // QUEUED, RUNNING, STOPPING
//     }
//     await delay(5000)
//   }
// }

exports.getSite = async (siteId) => {
  const site = await db.show('sites', { siteId })
  return { ...site, deployKey: '<obfuscated>' }
}

exports.setSiteCustomDomain = async (siteId, customDomain) => {
  const site = await db.show('sites', { siteId })

  // TODO: if stack update in progress, error
  const { operationId } = await cform.updateParams(site.stackId, { siteId, customDomain })
  // TODO: determine the dns records necessary for validation

  const updatedSite = await db.put('sites', {
    ...site,
    customDomain,
    latestOperationId: operationId
  })

  return { ...updatedSite, deployKey: '<obfuscated>' }
}

exports.listSitesForUser = async (userId) => {
  const sites = await db.query('sites', { userId }, { idx: 'idxUserId', asc: false })
  return sites.map(site => ({ ...site, deployKey: '<obfuscated>' }))
}

exports.listDeployments = async (siteId) => {
  return await db.query('deployments', { siteId }, { asc: false })
}

exports.getDeployment = async ({ siteId, deploymentId }) => {
  return await db.get('deployments', { siteId, deploymentId })
}

// create a new deployment for a site.
// Creates a new record in the deployments table, and adds the tarball
// to the S3 bucket. DeploymentIds are generated so that they are sequential;
// newer deployments are alphabetically after older ones.
// NOTE: this does not update the content on the site.
// For that, call promoteDeployment.
exports.createDeployment = async ({ siteId, contentTarball }) => {
  const deploymentId = generateDeployId()
  await s3.upload(deploymentTarballKey(siteId, deploymentId), contentTarball)
  console.log('create', siteId, deploymentId, contentTarball)
  const deployment = await db.put('deployments', {
    deploymentId,
    siteId,
    createdAt: new Date().toISOString()
  })
  return deployment
}

// make the deployment live for the site
exports.promoteDeployment = async ({ siteId, deploymentId }) => {
  const site = await db.show('sites', { siteId })
  const deployment = await db.show('deployments', { siteId, deploymentId })

  const siteContentPath = siteContentKeyPrefix(siteId)
  console.log('promoting', siteId, deploymentId)

  // in order to unzip the tarball in place, we need to download it, extract it
  // locally, and upload each file one at a time.
  const tmpDir = await mkdtemp(path.join(tmpdir(), `${process.env.APP_ID}-`))
  const tarballPath = deploymentTarballKey(siteId, deploymentId)
  console.log('downloading', tarballPath, 'to', tmpDir)
  const tarball = await s3.download(tarballPath)
  const extract = tar.extract({ cwd: tmpDir, strict: true })
  console.log('extracting tarball')
  await pipeline(tarball, extract) // wait for extraction to complete

  console.log('deleting live site', siteContentPath)
  await s3.deleteRecursive(siteContentPath)

  // upload the tarball
  console.log('uploading files')
  for await (const entry of glob(path.join(tmpDir, '**', '*'))) {
    const s = await stat(entry)
    if (!s.isDirectory()) {
      const key = path.join(siteContentPath, path.relative(tmpDir, entry))
      // if we don't specify the content type, CF will send it as a binary file
      // and the browser will simply download it
      const contentType = mime.contentType(path.extname(entry))
      console.log('upload', contentType, entry, key)
      await s3.upload(key, createReadStream(entry), { contentType })
    }
  }

  if (site.currentDeployment) {
    console.log('invalidating cache')
    const invalidation = await cfront.invalidate(site.distributionTenantId)
    db.put('deployments', { ...deployment, invalidationId: invalidation.Id })
  }

  console.log('updating site')
  return await db.put('sites', {
    ...site,
    currentDeployment: deploymentId,
    deployedAt: new Date().toISOString()
  })
}

exports.deleteSite = async (siteId) => {
  const deleteDeploymentsForSite = async (siteId) => {
    for (const { deploymentId } in await db.query('deployments', { siteId })) {
      await db.delete('deployments', { siteId, deploymentId })
    }
  }
  await Promise.all([
    // remove domain + distro
    cform.deleteStack(siteId).then(() => console.log(`[${siteId}] deleted CloudFormation stack`)),
    // delete data from S3
    s3.deleteRecursive(siteContentKeyPrefix(siteId)).then(() => console.log(`[${siteId}] deleted site content`)),
    s3.deleteRecursive(siteDeploymentsKeyPrefix(siteId)).then(() => console.log(`[${siteId}] deleted deployment data`)),
    // delete all deployments from db
    deleteDeploymentsForSite(siteId).then(() => console.log(`[${siteId}] deleted deployment history`)),
    // delete site from db
    db.delete('sites', { siteId }).then(() => console.log(`[${siteId}] deleted site`))
  ])
  console.log('site removed', siteId)
}

exports.awaitInvalidationComplete = async ({ siteId, deploymentId }) => {
  const site = await db.show('sites', { siteId })
  const deployment = await db.show('deployments', { siteId, deploymentId })
  if (!deployment.invalidationId) return

  while (true) {
    const invalidation = await cfront.getInvalidation(site.distributionTenantId, deployment.invalidationId)
    if (invalidation.Status === 'Completed') return invalidation
    await delay(5000)
  }
}

// create a stream of a .tar.gz of the directory at the provided path.
// returns a node stream that can be piped to a file or request.
exports.createTarball = async (directoryPath) => {
  const filesInDirectory = await Array.fromAsync(glob(path.join(directoryPath, '*')))
  const relativeFiles = filesInDirectory.map((item) => path.relative(directoryPath, item))
  return ReadableStream.from(tar.create({ cwd: directoryPath, gzip: true }, relativeFiles))
}

exports.wipeEverything = async () => {
  if (process.env.NODE_ENV !== 'dev') throw new Error('Can only destroy dev environments')

  await s3.deleteRecursive('')
  for await (const { siteId } of db.scan('sites')) {
    await this.deleteSite(siteId)
  }
  for await (const { userId } of db.scan('users')) {
    await db.delete('users', { userId })
    console.log('deleted user', userId)
  }
}
