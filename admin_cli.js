const yargs = require('yargs')
const { hideBin } = require('yargs/helpers')

const app = require('./app')

function main () {
  yargs(hideBin(process.argv))
    .scriptName('manage')
    .command('get_user <username>', 'check the status of a user', (yargs) => {
      return yargs.positional('username', { describe: 'the unique username of the user' })
    }, async ({ username }) => {
      const user = await app.getUser(username)

      if (user) {
        console.log(user)
      } else {
        console.error(`No user found for username "${username}"`)
      }
    })
    .command('add_user <username> [details]', 'create a new user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the unique username of the user' })
        .option('name', {
          alias: 'n',
          describe: 'The display name of the user'
        })
        .demandOption(['n'])
    }, async ({ username, name }) => {
      // TODO: auth tokens?

      const user = await app.createUser({ userId: username, name })
      console.log(user)
    })
    .command('list_sites <username>', 'show all the sites managed by the user', (yargs) => {
      return yargs
        .positional('username', { describe: 'the username of the user' })
    }, async ({ username }) => {
      // TODO: auth tokens?

      const sites = await app.listSitesForUser(username)
      console.log(sites)
    })

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
          describe: "wait for the CloudFront distribution to activate",
        })
        .demandOption(['owner', 'name'])
    }, async ({ owner, name, wait }) => {
      const site = await app.createSite({ name, userId: owner })
      console.log(site)
      if (wait) {
        console.log("waiting...")
        await app.waitForStack(site, (status) => console.log(status))
      }
    })

    // NOTE: domain name must be pointing correctly beforehand!
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
          describe: "wait for the CloudFront distribution to activate",
        })
        .demandOption(['site', 'domain'])
    }, async ({ site, domain, wait }) => {
      const updatedSite = await app.setSiteCustomDomain(site, domain)
      console.log(updatedSite)
      // if (wait) {
      //   console.log("waiting...")
      //   await app.waitForStack(updatedSite, (status) => console.log(status))
      // }
    })

    .command('list_deployments [site]', 'list all the deployments for a site', (yargs) => {
      return yargs
        .positional('site', { describe: 'the siteId' })
    }, async ({ site }) => {
      const siteData = await app.getSite(site)
      const deployments = await app.listDeployments(site)
      console.log(deployments.map(d => {
        if (siteData.currentDeployment === d.deploymentId) return { ...d, current: true }
        else return d
      }))
      // TODO: show in table form instead
    })

    .command('deploy [path]', 'create a deployment to the given site', (yargs) => {
      return yargs
        .example("deploy myapp/dist --site [siteId] --exclude '**/*.test.js'")
        .positional('path', { describe: 'The path to the root directory of static files' })
        .option('site', {
          alias: 's',
          describe: 'the siteId to deploy to'
        })
        .option('exclude', {
          alias: 'x',
          describe: 'a glob of files relative to `path` to exclude',
          type: 'array',
          default: []
        })
        .option('promote', {
          alias: 'p',
          describe: "Also promote the deployment.\nA deployment isn't automatically promoted to live by default",
          type: 'boolean'
        })
        .option('wait', {
          alias: 'w',
          describe: 'wait for the invalidation to complete (if also promoting)',
          type: 'boolean'
        })
        .demandOption(['site'])
    }, async ({ path, site, exclude, promote, wait }) => {
      console.log('zipping and uploading...')
      const contentTarball = await app.createTarball(path) // TODO: exclude
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
    })

    .command([
      'promote [site] [deployment]',
      'rollback [site] [deployment]'
    ], 'make the distribution live', (yargs) => {
      return yargs
        .positional('site', { describe: 'the id of the site', alias: 'siteId' })
        .positional('deployment', { describe: 'the id of the deployment', alias: 'deploymentId' })
        .option('wait', {
          alias: 'w',
          describe: 'wait for the invalidation to complete',
          type: 'boolean'
        })
    }, async ({ siteId, deploymentId, wait }) => {
      console.log('promoting...')
      const site = await app.promoteDeployment({ siteId, deploymentId })
      console.log(site)
      if (wait) {
        console.log('waiting for invalidation...')
        const invalidation = await app.awaitInvalidationComplete({ siteId, deploymentId })
        console.log(invalidation)
      }
    })

    .help('h')
    .alias('h', 'help')
    .demandCommand(1, 1, 'command required')
    .parse()
}

main()
