const yargs = require('yargs')
const { hideBin } = require('yargs/helpers')
const chalk = require('chalk')

const logger = require('./logger')

// NOTE: these are populated after args are parsed
let app

const wrap = (cmd) => (argv) => {
  const verbosity = (argv.v instanceof Array ? argv.v : [argv.v])
    .map(v => v ? 1 : 0).reduce((a, b) => a + b, 0)
  const level = ['warn', 'info', 'http', 'verbose'][verbosity] || 'verbose'
  logger.configure({ level, pretty: true })
  app = require('./app')
  return cmd(argv)
}

async function getUser ({ username }) {
  const user = await app.getUser(username)

  if (user) {
    console.log(user)
  } else {
    console.error(`No user found for username "${username}"`)
  }
}

async function addUser ({ username, name }) {
  const user = await app.createUser({ userId: username, name })
  console.log(user)
}

async function listSites ({ username }) {
  const sites = await app.listSitesForUser(username)
  console.log(sites)
}

async function addSite ({ owner, name, wait }) {
  const site = await app.createSite({ name, userId: owner })
  console.log(site)
  if (wait) {
    console.log('waiting...')
    await app.waitForStack(site, (status) => console.log(status))
  }
}

async function addCustomDomain ({ site, domain }) {
  try {
    const siteData = await app.getSite(site)
    const updatedSite = await app.setSiteCustomDomain(siteData, domain)
    console.log(updatedSite)
  } catch (err) {
    if (err instanceof app.DomainValidationFailedError) {
      switch (err.code) {
        case 'NOT_FOUND':
          console.error(chalk.red('DNS record not found.'))
          break
        case 'INVALID':
          console.error(chalk.red('DNS record improperly set.'))
          break
        default:
          console.error(chalk.red('Unable to verify DNS record.'))
          break
      }
      console.error("The custom domain's DNS record must be set before adding to the site.")
      console.log(`Create a CNAME record for ${domain} with a value of \`${err.target}\` and try again.`)
      console.log('If you have already created the record, it may take a few minutes to take effect.')
    }
  }
}

async function listDeployments ({ site }) {
  const siteData = await app.getSite(site)
  const deployments = await app.listDeployments(site)
  console.log(deployments.map(d => {
    if (siteData.currentDeployment === d.deploymentId) return { ...d, current: true }
    else return d
  }))
  // TODO: show in table form instead
}

async function deploy ({ path, site, exclude, promote, wait }) {
  console.log('zipping and uploading...')
  const contentTarball = await app.createTarball(path, { exclude })
  const siteData = await app.getSite(site)
  const deployment = await app.createDeployment({ site: siteData, contentTarball })
  console.log(deployment)
  if (promote) {
    console.log('promoting...')
    let siteData = await app.getSite(site)
    siteData = await app.promoteDeployment({ siteData, deploymentId: deployment.deploymentId })
    console.log(siteData)
    if (wait) {
      console.log('waiting for invalidation...')
      const invalidation = await app.awaitInvalidationComplete({ siteId: site, deploymentId: deployment.deploymentId })
      console.log(invalidation)
    }
  }
}

async function promote ({ siteId, deploymentId, wait }) {
  console.log('promoting...')
  let site = await app.getSite(siteId)
  site = (await app.promoteDeployment({ site, deploymentId })).site
  console.log(site)
  if (wait) {
    console.log('waiting for invalidation...')
    const invalidation = await app.awaitInvalidationComplete({ siteId, deploymentId })
    console.log(invalidation)
  }
}

async function wipeEverything () {
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

module.exports = function main () {
  let cli = yargs(hideBin(process.argv))
    .scriptName('admin')

    .command('get_user [username]', 'check the status of a user', (yargs) => {
      return yargs.positional('username', { describe: 'the unique username of the user' })
    }, wrap(getUser))

    .command('add_user [username]', 'create a new user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the unique username of the user' })
        .option('name', {
          alias: 'n',
          describe: 'The display name of the user'
        })
        .demandOption(['n'])
    }, wrap(addUser))

    .command('list_sites [username]', 'show all the sites managed by the user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the username of the user' })
    }, wrap(listSites))

    .command('add_site', 'create a new site', (yargs) => {
      return yargs
        .example('add_site [username] -n [name]')
        .positional('owner', { describe: 'The username of the site owner' })
        .option('name', {
          alias: 'n',
          describe: 'The display name of the site'
        })
        .demandOption(['owner'])
    }, wrap(addSite))

    .command('add_domain [site] [domain]', 'add a custom domain to a site', (yargs) => {
      return yargs
        .positional('site', { describe: 'the siteId' })
        .positional('domain', { describe: 'the custom domain. Must have a CNAME DNS record to the default domain' })
    }, wrap(addCustomDomain))
    .command('remove_domain [site]', 'remove a custom domain from a site', (yargs) => {
      return yargs
        .positional('site', { describe: 'the siteId' })
    }, wrap(addCustomDomain))

    .command('list_deployments [site]', 'list all the deployments for a site', (yargs) => {
      return yargs
        .positional('site', { describe: 'the siteId' })
    }, wrap(listDeployments))

    .command('deploy [site] [path]', 'create a deployment to the given site', (yargs) => {
      return yargs
        .example("deploy [siteId] myapp/dist --exclude '**/*.test.js'")
        .positional('site', { describe: 'the siteId to deploy to' })
        .positional('path', { describe: 'The path to the root directory of static files' })
        .option('exclude', { alias: 'x', describe: 'a glob of files relative to `path` to exclude', type: 'array', default: [] })
        .option('promote', { alias: 'p', describe: "Also promote the deployment.\nA deployment isn't automatically promoted to live by default", type: 'boolean' })
        .option('wait', { alias: 'w', describe: 'wait for the invalidation to complete (if also promoting)', type: 'boolean' })
    }, wrap(deploy))

    .command([
      'promote [site] [deployment]',
      'rollback [site] [deployment]'
    ], 'make the distribution live', (yargs) => {
      return yargs
        .positional('site', { describe: 'the id of the site', alias: 'siteId' })
        .positional('deployment', { describe: 'the id of the deployment', alias: 'deploymentId' })
        .option('wait', { alias: 'w', describe: 'wait for the invalidation to complete', type: 'boolean' })
    }, wrap(promote))

  if (process.env.NODE_ENV === 'dev') {
    cli = cli.command('wipe_everything', 'delete all sites, deployments, and users',
      (yargs) => yargs, wrap(async () => await wipeEverything()))
  }

  cli.help('h')
    .alias('h', 'help')
    .option('verbose', { alias: 'v', describe: 'Verbose logging (to stderr)' })
    .demandCommand(1, 1, 'command required')
    .parse()
}

// TODO: await tenant created

// module.exports.awaitInvalidationComplete = async ({ siteId, deploymentId }) => {
//   const site = await db.get('sites', { siteId })
//   const deployment = await db.get('deployments', { siteId, deploymentId })
//   if (!deployment.invalidationId) {
//     logger.info(`no invalidations for ${siteId}/${deploymentId}`)
//     return
//   }

//   logger.info(`waiting for invalidation ${siteId}/${deploymentId}`)
//   while (true) {
//     const invalidation = await cfront.getInvalidation(site.tenantId, deployment.invalidationId)
//     logger.info(`invalidation status: ${invalidation.Status}`)
//     if (invalidation.Status === 'Completed') return invalidation
//     await delay(5000)
//   }
// }
