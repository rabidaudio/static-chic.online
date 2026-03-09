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

async function addCustomDomain ({ site, domain, wait }) {
  try {
    const updatedSite = await app.setSiteCustomDomain(site, domain)
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
  // if (wait) {
  //   console.log("waiting...")
  //   await app.waitForStack(updatedSite, (status) => console.log(status))
  // }
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
  const contentTarball = await app.createTarball(path, exclude)
  const deployment = await app.createDeployment({ siteId: site, contentTarball })
  console.log(deployment)
  if (promote) {
    console.log('promoting...')
    const deployedSite = await app.promoteDeployment(deployment)
    console.log(deployedSite)
    if (wait) {
      console.log('waiting for invalidation...')
      const invalidation = await app.awaitInvalidationComplete({ siteId: site, deploymentId: deployment.deploymentId })
      console.log(invalidation)
    }
  }
}

async function promote ({ siteId, deploymentId, wait }) {
  console.log('promoting...')
  const site = await app.promoteDeployment({ siteId, deploymentId })
  console.log(site)
  if (wait) {
    console.log('waiting for invalidation...')
    const invalidation = await app.awaitInvalidationComplete({ siteId, deploymentId })
    console.log(invalidation)
  }
}

function main () {
  let cli = yargs(hideBin(process.argv))
    .scriptName('manage')

    .command('get_user <username>', 'check the status of a user', (yargs) => {
      return yargs.positional('username', { describe: 'the unique username of the user' })
    }, wrap(getUser))

    .command('add_user <username> [details]', 'create a new user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the unique username of the user' })
        .option('name', {
          alias: 'n',
          describe: 'The display name of the user'
        })
        .demandOption(['n'])
    }, wrap(addUser))

    .command('list_sites <username>', 'show all the sites managed by the user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the username of the user' })
    }, wrap(listSites))

    .command('add_site', 'create a new site', (yargs) => {
      return yargs
        .example('add_site -o [username] -n [name]')
        .option('owner', {
          alias: 'o',
          describe: 'The username of the site owner'
        })
        .option('name', {
          alias: 'n',
          describe: 'The name of the site'
        })
        // TODO: custom domain
        .option('wait', {
          alias: 'w',
          describe: 'wait for the CloudFront distribution to activate'
        })
        .demandOption(['owner', 'name'])
    }, wrap(addSite))

    .command('add_custom_domain', 'add a custom domain to a site', (yargs) => {
      return yargs
        .example('add_custom_domain -s [siteId] -d example.com')
        .option('site', {
          alias: 's',
          describe: 'the siteId'
        })
        .option('domain', {
          alias: 'd',
          describe: 'the custom domain'
        })
        .option('wait', {
          alias: 'w',
          describe: 'wait for the CloudFront distribution to activate'
        })
        .demandOption(['site', 'domain'])
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
      (yargs) => yargs, wrap(async () => await app.wipeEverything()))
  }

  cli.help('h')
    .alias('h', 'help')
    .option('verbose', { alias: 'v', describe: 'Verbose logging (to stderr)' })
    .demandCommand(1, 1, 'command required')
    .parse()
}

main()
