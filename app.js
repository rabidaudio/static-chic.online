const { randomBytes } = require('node:crypto')
const path = require('node:path')
const { glob } = require('node:fs/promises')

const namor = require('namor')
const tar = require('tar')

const db = require('./db')
const s3 = require('./s3')

// space size: 7948^2*(26+10)^5 = 3.8 quadrillion
// ~50% chance of collision ~62 million
const generateSiteId = () => {
  const name = namor.generate({ words: 2, salt: 5 })
  if (namor.valid_subdomain(name, { reserved: true })) return name
  return generateSiteId() // try again
}

const generateDeployKey = () => randomBytes(32).toString('base64')

const generateSequentialGUID = () => {
  const timestamp = Buffer.alloc(8)
  timestamp.writeBigInt64BE(BigInt(new Date().getTime()))
  const rand = randomBytes(4)
  return Buffer.concat([timestamp, rand]).toString('hex')
}

exports.createUser = async ({ userId, name }) => {
  return await db.create('users', {
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
  return await db.create('sites', {
    siteId: generateSiteId(),
    userId,
    name,
    deployKey: generateDeployKey(),
    createdAt: new Date().toISOString()
  })
  // TODO: create CloudFront tenant
}

exports.getSite = async (siteId) => {
  return await db.show('sites', { siteId })
}

exports.listDeployments = async (siteId) => {
  return await db.query('deployments', { siteId })
}

// create a new deployment for a site.
// Creates a new record in the deployments table, and adds the tarball
// to the S3 bucket. DeploymentIds are generated so that they are sequential;
// newer deployments are alphabetically after older ones.
// NOTE: this does not update the content on the site.
// For that, call promoteDeployment.
exports.createDeployment = async ({ siteId, contentTarball }) => {
  const deploymentId = generateSequentialGUID()
  await s3.upload(`deployments/${siteId}/${deploymentId}.tar.gz`, contentTarball)
  const deployment = await db.create('deployments', {
    deploymentId,
    siteId,
    createdAt: new Date().toISOString()
  })
  return deployment
}

// exports.promoteDeployment = async (deploymentId) => {}

// create a stream of a .tar.gz of the directory at the provided path.
// returns a node stream that can be piped to a file or request.
exports.createTarball = async (directoryPath) => {
  const filesInDirectory = await Array.fromAsync(glob(path.join(directoryPath, '*')))
  return ReadableStream.from(tar.create({ gzip: true }, filesInDirectory))
}
