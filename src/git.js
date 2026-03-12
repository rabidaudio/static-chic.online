const { execSync } = require('node:child_process')
const { createReadStream } = require('node:fs')
const { glob, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')

const mime = require('mime-types')
const { simpleGit } = require('simple-git')
const tar = require('tar')

const logger = require('./logger').getLogger()

const s3 = require('./s3')

// where deployments are stored on S3
const getSiteDeploymentsKey = (siteId) => `deployments/${siteId}`

// where live site content is stored on S3
const getSiteContentKey = (siteId) => `sites/${siteId}/content`

const getOrigin = (siteId) => `s3://${process.env.BUCKET_NAME}/${getSiteDeploymentsKey(siteId)}`
module.exports = { getSiteDeploymentsKey, getSiteContentKey, getOrigin }

const createTmpDir = async () => {
  logger.verbose(`git: mkdir /tmp/${process.env.APP_ID}-xxxxx`)
  return await mkdtemp(path.join(tmpdir(), `${process.env.APP_ID}-`))
}

const allFilesRelative = async (cwd, opts = {}) => {
  return await Array.fromAsync(async function * () {
    for await (const entry of glob(['**/*', '**/.*'], { ...opts, cwd, withFileTypes: true })) {
      if (entry.isFile()) yield path.relative(cwd, path.join(entry.parentPath, entry.name))
    }
  }())
}

// create a stream of a .tar.gz of the directory at the provided path.
// returns a node stream that can be piped to a file or request.
module.exports.createTarball = async (directoryPath, { exclude } = { exclude: [] }) => {
  logger.info(`creating tarball of ${directoryPath}`)
  const files = await allFilesRelative(directoryPath, { exclude })
  //   await Array.fromAsync(glob('**/*', { cwd: directoryPath, exclude }))
  for (const item of files) {
    logger.verbose(item)
  }
  return ReadableStream.from(tar.create({ cwd: directoryPath, gzip: true }, files))
}

const extractTarball = async (tarball, cwd) => {
  logger.verbose(`git: tar -xvz ${cwd}`)
  const extract = tar.extract({ cwd, strict: true, onReadEntry: ({ path }) => logger.verbose(`extract: ${path}`) })
  await pipeline(tarball, extract) // wait for extraction to complete
}

// Create a new repository with the given deployment, and return the commit sha
module.exports.initializeSite = async ({ siteId, deploymentId, tarball }) => {
  // create a new repository, unzip into it, commit the results,
  // create an s3 origin, and push the repo
  logger.info(`initializing repository ${siteId}`)
  const cwd = await createTmpDir()
  // https://github.com/steveukx/git-js/blob/main/docs/PLUGIN-UNSAFE-ACTIONS.md
  const git = simpleGit({ baseDir: cwd, unsafe: { allowUnsafePack: true } })
  logger.verbose('git: git init')
  await git.init()
  logger.verbose('git: git-lfs-s3 install')
  execSync('git-lfs-s3 install', { cwd })

  logger.info('extracting tarball')
  await extractTarball(tarball, cwd)
  logger.verbose(`git: echo '${deploymentId}' > .chic-version`)
  await writeFile(path.join(cwd, '.chic-version'), deploymentId) // ensures commits have something unique

  logger.info('committing')
  const ff = await allFilesRelative(cwd, { exclude: ['.git'] })
  logger.verbose('git: git add -A .')
  await git.add(ff)
  logger.verbose(`git: git commit -m "deployment:${deploymentId}"`)
  const { commit } = await git.commit(`deployment:${deploymentId}`)
  logger.verbose(`git: git tag ${deploymentId}`)
  await git.addTag(deploymentId)
  logger.info(`git: sha ${commit}`)

  logger.info('creating origin')
  // https://github.com/awslabs/git-remote-s3
  const origin = getOrigin(siteId)
  logger.verbose(`git: git remote add origin ${origin}`)
  await git.addRemote('origin', origin)

  logger.info(`pushing to ${origin}`)
  logger.verbose('git: git push origin main')
  await git.push('origin', 'main')
  logger.verbose('git: git push --tags origin')
  await git.pushTags('origin')

  logger.info('cleaning up')
  await rm(cwd, { recursive: true, force: true })

  return commit
}

module.exports.addDeployment = async ({ siteId, deploymentId, tarball }) => {
  // clone the code from s3, delete all files, unzip,
  // commit the results, and push
  logger.info(`initializing repository ${siteId}`)
  const cwd = await createTmpDir()
  // https://github.com/steveukx/git-js/blob/main/docs/PLUGIN-UNSAFE-ACTIONS.md
  const git = simpleGit({ baseDir: cwd, unsafe: { allowUnsafePack: true } })

  const origin = getOrigin(siteId)
  logger.info(`cloning repository ${origin}`)
  logger.verbose(`git: git clone ${origin}`)
  await git.raw('clone', '-c', 'protocol.s3.allow=always', origin, cwd)

  logger.info('extracting tarball')
  const preFiles = await allFilesRelative(cwd, { exclude: ['.git'] })
  logger.verbose('git: git rm -r .')
  await git.rm(preFiles)
  await extractTarball(tarball, cwd)
  logger.verbose(`git: echo '${deploymentId}' > .chic-version`)
  await writeFile(path.join(cwd, '.chic-version'), deploymentId) // ensures commits have something unique

  logger.info('committing')
  const postFiles = await allFilesRelative(cwd, { exclude: ['.git'] })
  logger.verbose('git: git add -A .')
  await git.add(postFiles)
  logger.verbose(`git: git commit -m "deployment:${deploymentId}"`)
  const { commit } = await git.commit(`deployment:${deploymentId}`)
  logger.verbose(`git: git tag ${deploymentId}`)
  await git.addTag(deploymentId)
  logger.info(`git: sha ${commit}`)

  logger.info(`pushing to ${origin}`)
  logger.verbose('git: git push origin main')
  await git.push('origin', 'main')
  logger.verbose('git: git push --tags origin')
  await git.pushTags('origin')

  logger.info('cleaning up')
  await rm(cwd, { recursive: true, force: true })

  return commit
}

module.exports.promoteDeployment = async (siteId, deploymentId) => {
  // clone, checkout the deployment, copy all files except .git to s3
  logger.info(`initializing repository ${siteId}`)
  const cwd = await createTmpDir()
  const git = simpleGit({ baseDir: cwd, unsafe: { allowUnsafePack: true } })

  const origin = getOrigin(siteId)
  logger.info(`cloning repository ${origin}`)
  logger.verbose(`git: git clone ${origin}`)
  await git.raw('clone', '-c', 'protocol.s3.allow=always', origin, cwd)

  logger.info(`checking out deployment ${deploymentId}`)
  logger.verbose(`git: git checkout ${deploymentId}`)
  await git.checkout(deploymentId)

  const siteContent = getSiteContentKey(siteId)
  logger.info(`deleting live site ${siteContent}`)
  await s3.deleteRecursive(siteContent)

  logger.info('copying files')
  const ff = await allFilesRelative(cwd, { exclude: ['.git'] })
  for (const file of ff) {
    const key = path.join(siteContent, file)
    // if we don't specify the content type, CF will send it as a binary file
    // and the browser will simply download it
    const contentType = mime.contentType(path.extname(file))
    const absPath = path.join(cwd, file)
    await s3.upload(key, createReadStream(absPath), { contentType })
  }

  logger.info('cleaning up')
  await rm(cwd, { recursive: true, force: true })
}

// TODO: squash deployments - reduce the number/size of old deployments
