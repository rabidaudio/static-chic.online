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

// the git origin to push/pull to
const getOrigin = (siteId) => `s3://${process.env.BUCKET_NAME}/${getSiteDeploymentsKey(siteId)}`

module.exports = {
  getSiteDeploymentsKey,
  getSiteContentKey,
  getOrigin,

  // create a stream of a .tar.gz of the directory at the provided path.
  // returns a node stream that can be piped to a file or request.
  createTarball: async (directoryPath, { exclude } = { exclude: [] }) => {
    logger.info(`creating tarball of ${directoryPath}`)
    const files = await allFilesRelative(directoryPath, { exclude })
    for (const file of files) {
      logger.verbose(file)
    }
    return ReadableStream.from(tar.create({ cwd: directoryPath, gzip: true }, files))
  },

  deploy: async ({ siteId, deploymentId, tarball, isFirst }) => {
    const origin = getOrigin(siteId)
    const repo = new Repo({ origin, deploymentId })
    await repo.prepare()
    if (isFirst) {
      logger.info(`initializing repository ${siteId}`)
      await repo.init()
    } else {
      logger.info(`cloning repository ${siteId}`)
      await repo.clone()
      logger.info('deleting existing files')
      await repo.clearWorkingDirectory()
    }
    logger.info('extracting tarball')
    await repo.extractTarball(tarball)
    await repo.touch(deploymentId)
    logger.info('committing')
    const commit = await repo.commitAllFiles({
      message: `deployment:${deploymentId}`,
      tag: deploymentId
    })
    logger.info(`git: sha=${commit}`)
    if (isFirst) {
      logger.info('creating origin')
      await repo.createOrigin()
    }
    logger.info(`pushing to ${origin}`)
    await repo.push()
    logger.info('cleaning up')
    await repo.cleanup()

    return commit
  },
  promote: async ({ siteId, deploymentId }) => {
    const origin = getOrigin(siteId)
    const repo = new Repo({ origin })
    await repo.prepare()
    logger.info(`cloning repository ${siteId}`)
    await repo.clone()
    logger.info(`checking out deployment ${deploymentId}`)
    await repo.checkout(deploymentId)

    const siteContent = getSiteContentKey(siteId)
    logger.info(`deleting live site ${siteContent}`)
    await s3.deleteRecursive(siteContent)

    logger.info('copying files')
    const files = await allFilesRelative(repo.cwd, { exclude: ['.git'] })
    for (const file of files) {
      const key = path.join(siteContent, file)
      // if we don't specify the content type, CF will send it as a binary file
      // and the browser will simply download it
      const contentType = mime.contentType(path.extname(file))
      const absPath = path.join(repo.cwd, file)
      await s3.upload(key, createReadStream(absPath), { contentType })
    }

    logger.info('cleaning up')
    await repo.cleanup()
  }
// TODO: squash deployments - reduce the number/size of old deployments
}

class Repo {
  constructor ({ origin }) {
    this.origin = origin
  }

  async prepare () {
    logger.verbose(`git: mkdir /tmp/${process.env.APP_ID}-xxxxx`)
    this.cwd = await mkdtemp(path.join(tmpdir(), `${process.env.APP_ID}-`))
    // https://github.com/steveukx/git-js/blob/main/docs/PLUGIN-UNSAFE-ACTIONS.md
    this.git = simpleGit({ baseDir: this.cwd, unsafe: { allowUnsafePack: true } })
  }

  async init () {
    logger.verbose('git: git init')
    await this.git.init()
    logger.verbose('git: git-lfs-s3 install')
    execSync('git-lfs-s3 install', { cwd: this.cwd })
  }

  async clone () {
    logger.info(`cloning repository ${this.origin}`)
    logger.verbose(`git: git clone ${this.origin}`)
    await this.git.raw('clone', '-c', 'protocol.s3.allow=always', this.origin, this.cwd)
  }

  async checkout (tag) {
    logger.verbose(`git: git checkout ${tag}`)
    await this.git.checkout(tag)
  }

  async clearWorkingDirectory () {
    const files = await allFilesRelative(this.cwd, { exclude: ['.git'] })
    logger.verbose('git: git rm -r .')
    await this.git.rm(files)
  }

  async extractTarball (tarball) {
    logger.verbose(`git: tar -xvz ${this.cwd}`)
    const extract = tar.extract({
      cwd: this.cwd,
      strict: true,
      onReadEntry: ({ path }) => logger.verbose(`extract: ${path}`)
    })
    await pipeline(tarball, extract) // wait for extraction to complete
  }

  async touch (content) {
    // ensures commits have something unique TODO: allow-empty instead?
    logger.verbose(`git: echo '${content}' > .chic-version`)
    await writeFile(path.join(this.cwd, '.chic-version'), content)
  }

  async commitAllFiles ({ message, tag }) {
    const files = await allFilesRelative(this.cwd, { exclude: ['.git'] })
    logger.verbose('git: git add -A .')
    await this.git.add(files)
    logger.verbose(`git: git commit -m "${message}"`)
    const { commit } = await this.git.commit(message)
    logger.verbose(`git: git tag ${tag}`)
    await this.git.addTag(tag)
    return commit
  }

  async createOrigin () {
    // https://github.com/awslabs/git-remote-s3
    logger.verbose(`git: git remote add origin ${this.origin}`)
    await this.git.addRemote('origin', this.origin)
  }

  async push () {
    logger.verbose('git: git push origin main')
    await this.git.push('origin', 'main')
    logger.verbose('git: git push --tags origin')
    await this.git.pushTags('origin')
  }

  async cleanup () {
    logger.verbose(`git: rm -rf ${this.cwd}`)
    await rm(this.cwd, { recursive: true, force: true })
  }
}

const allFilesRelative = async (cwd, opts = {}) => {
  return await Array.fromAsync(async function * () {
    for await (const entry of glob(['**/*', '**/.*'], { ...opts, cwd, withFileTypes: true })) {
      if (entry.isFile()) yield path.relative(cwd, path.join(entry.parentPath, entry.name))
    }
  }())
}
